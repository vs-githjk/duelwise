import { useEffect, useRef, useState } from 'react'
import { CAP_FRAMES, PUCK_EVENTS } from '@duelwise/core/src/games/puck/constants'
import type { PuckState } from '@duelwise/core/src/games/puck/state'
import type { Seat } from '@duelwise/core/src/types'
import { NO_INSETS, readSafeInsets, type Layout } from '../puck/input'
import { FixedLoop } from '../puck/loop'
import { PuckRenderer, readTheme } from '../puck/render'
import { playPresent } from '../puck/sounds'
import { TwoHands, fingerOffset, fitLocalLayout } from '../puck/two-hands'
import type { RealtimeHandle } from './useRealtimeLink'
import { PuckNetRun, puckTallyOf, viewToScreen } from './remote-puck'

// One Glasscut sitting for two people on two devices: the page owns a PuckNetRun (rollback over the relay's realtime link), a 60 Hz loop and
// one hand. You are always at the bottom; seat 1 sees the table turned, and its input needs no mirroring because every seat's input is in
// its own view. Nothing here starts, finishes or uploads a match on the site: the relay decides the result and signs it.

export interface RemoteHud {
  /** Goals by seat. */
  score: [number, number]
  clock: string
  sudden: boolean
}

export interface RemotePuckApi {
  stage: React.RefObject<HTMLDivElement | null>
  canvas: React.RefObject<HTMLCanvasElement | null>
  hud: RemoteHud
  touch: boolean
  layout: Layout
  /** Wins by person over this sitting: `one` is you. */
  tally: { one: number; two: number; draws: number }
}

export interface RemotePuckDebug {
  ready: boolean
  me: Seat
  frame: number
  confirmed: number
  over: boolean
  score: [number, number]
  /** Both mallets and the puck in table units (world, seat 0 at y = 0). */
  mallets: [[number, number], [number, number]]
  puck: [number, number]
  /** Frames a second the page drew over the last half second. */
  fps: number
  /** Hash of the confirmed state at each multiple of 60 frames, by frame. */
  hashes: Record<number, string>
  holds: number
  toScreen(wx: number, wy: number): [number, number]
}

declare global {
  interface Window {
    /** Debug handle for the two-device page's tests. */
    __remotePuck?: RemotePuckDebug
  }
}

const IDLE_HUD: RemoteHud = { score: [0, 0], clock: '6:00', sudden: false }
const KEY_STEP = 0.018

const clockText = (frame: number, sudden: boolean): string => {
  if (sudden) return 'Next goal wins'
  const left = Math.max(0, Math.ceil((CAP_FRAMES - frame) / 60))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

export function useRemotePuck(handle: RealtimeHandle): RemotePuckApi {
  const stage = useRef<HTMLDivElement | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const [hud, setHud] = useState<RemoteHud>(IDLE_HUD)
  const [layout, setLayout] = useState<Layout>(() => fitLocalLayout(390, 844, NO_INSETS))
  const [touch, setTouch] = useState(false)
  const [finished, setFinished] = useState<Array<{ winner: 0 | 1 | null; me: Seat }>>([])
  const hRef = useRef(handle)
  hRef.current = handle
  const { matchNo } = handle.state
  const seed = handle.state.go?.seed

  // The result of each finished match, counted once: the relay's `over` is the only thing trusted, and a void match counts for nobody.
  const over = handle.state.over
  const you = handle.state.go?.you
  const counted = useRef(0)
  useEffect(() => {
    if (!over || over.void !== null || !over.result || you === undefined || counted.current === matchNo) return
    counted.current = matchNo
    const w = over.result.winner
    setFinished((f) => [...f, { winner: w === 0 || w === 1 ? w : null, me: you }])
  }, [over, matchNo, you])

  // One effect per match: a rematch is a new `go` (matchNo + 1, the seats swapped), so the table, the session and the listeners are rebuilt.
  useEffect(() => {
    const h = hRef.current
    const go = h.state.go
    const el = stage.current
    const cv = canvas.current
    if (!go || !el || !cv || h.state.phase !== 'playing') return
    const me = go.you
    const q = new URLSearchParams(window.location.search)
    const coarse = q.get('touch') === '1' ? true : q.get('touch') === '0' ? false : window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
    setTouch(coarse)

    const hashes: Record<number, string> = {}
    const link = h.link
    const recording = { ...link, reportHash: (f: number, hash: string) => { hashes[f] = hash; link.reportHash(f, hash) } }
    const run = new PuckNetRun(recording, go.seed, me)
    let curLayout = fitLocalLayout(el.clientWidth || 390, el.clientHeight || 844, readSafeInsets())
    const renderer = new PuckRenderer(cv, readTheme())
    renderer.setOpponent('easy')
    renderer.setView(me)
    const hands = new TwoHands(curLayout)
    const loop = new FixedLoop()
    const keys = { left: false, right: false, up: false, down: false }
    let raf = 0
    let stopped = false
    let holding = false
    let holds = 0
    let tickNo = 0
    let lastKey = ''
    let lastClock = ''
    let bot: ((s: PuckState, tick: number) => number) | null = null
    if (import.meta.env.DEV) {
      // A test sets the hand on the device (local storage) so the invitation addresses stay as the page writes them.
      let stored: string | null = null
      try { stored = window.localStorage.getItem('duelwise.dev-bot') } catch { /* no storage: no scripted hand */ }
      const kind = q.get('bot') ?? stored
      if (kind) void import('./dev-bot').then((m) => { if (!stopped) bot = m.makeDevBot(kind, me, go.seed + me + 1) })
    }

    const fit = (): void => {
      const w = el.clientWidth
      const hh = el.clientHeight
      if (w === 0 || hh === 0) return
      curLayout = fitLocalLayout(w, hh, readSafeInsets())
      hands.setLayout(curLayout)
      renderer.resize(w, hh, curLayout, window.devicePixelRatio || 1)
      setLayout(curLayout)
    }
    const ro = new ResizeObserver(fit)
    ro.observe(el)

    const dbg: RemotePuckDebug = {
      ready: false, me, frame: 0, confirmed: 0, over: false, score: [0, 0], mallets: [[0, 0], [0, 0]], puck: [0, 0], fps: 0, hashes, holds: 0,
      toScreen: (wx, wy) => viewToScreen(curLayout, me, wx, wy),
    }
    window.__remotePuck = dbg

    const tickOnce = (now: number): void => {
      if (keys.left || keys.right || keys.up || keys.down) {
        const step = KEY_STEP * curLayout.scale
        hands.nudgeScreen(0, ((keys.right ? 1 : 0) - (keys.left ? 1 : 0)) * step, ((keys.down ? 1 : 0) - (keys.up ? 1 : 0)) * step)
      }
      const code = bot ? bot(run.state, tickNo) : hands.takeCode(0)
      tickNo++
      const r = run.step(code)
      holding = r.wait
      if (r.wait) holds++
      const evs = run.takeEvents()
      if (evs.length > 0) {
        playPresent(evs, me)
        for (const e of evs) if (e.op === 'fire' && e.kind === PUCK_EVENTS.goal) navigator.vibrate?.(14)
      }
      if (!r.wait) renderer.push(run.state, now)
    }

    const afterTicks = (): void => {
      const s = run.state
      const key = `${s.score[0]}:${s.score[1]}`
      const clock = clockText(s.frame, s.sudden === 1)
      if (key !== lastKey || clock !== lastClock) {
        lastKey = key
        lastClock = clock
        setHud({ score: [s.score[0], s.score[1]], clock, sudden: s.sudden === 1 })
      }
    }

    let dtAcc = 0
    let dtN = 0
    let lastRaf = 0
    let lastStat = 0
    const hold = (): boolean => {
      if (holding && run.fresh) holding = false
      return holding
    }
    const frameLoop = (now: number): void => {
      if (stopped) return
      raf = requestAnimationFrame(frameLoop)
      if (lastRaf > 0) { dtAcc += now - lastRaf; dtN++ }
      lastRaf = now
      // The match is over for the page once the relay has said so; until then the predicted sim keeps its last frame on screen.
      if (hRef.current.state.phase === 'playing') {
        const n = loop.advance(now, () => tickOnce(now), hold)
        if (n > 0) afterTicks()
      }
      renderer.draw(loop.alpha, now, run.state)
      if (now - lastStat > 500) {
        lastStat = now
        dbg.fps = dtN > 0 ? Math.round((1000 * dtN) / dtAcc) : 0
        dtAcc = dtN = 0
      }
      const s = run.state
      dbg.frame = s.frame
      dbg.confirmed = run.confirmedFrame
      dbg.over = run.over
      dbg.score = [s.score[0], s.score[1]]
      dbg.mallets = [[s.m[0].x, s.m[0].y], [s.m[1].x, s.m[1].y]]
      dbg.puck = [s.px, s.py]
      dbg.holds = holds
    }

    // A finger that lands on a button or a menu belongs to it. Only the bottom half (your end) steers; the top half belongs to your friend's phone.
    const onControl = (e: Event): boolean => (e.target as Element | null)?.closest('button, a, [role="dialog"], [data-no-play]') != null
    const playing = (): boolean => dbg.ready && hRef.current.state.phase === 'playing'
    const onDown = (e: PointerEvent): void => {
      if (onControl(e) || !playing()) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const seat = hands.down(e.pointerId, e.pointerType, e.clientX, e.clientY)
      if (seat === null) return
      if (seat !== 0) {
        hands.up(e.pointerId)
        return
      }
      if (e.pointerType !== 'mouse') {
        try { el.setPointerCapture(e.pointerId) } catch { /* the browser ended this pointer */ }
        renderer.setTouching(true)
      }
      e.preventDefault()
    }
    const onMove = (e: PointerEvent): void => {
      if (!playing()) return
      if (e.pointerType === 'mouse') {
        if (hands.move(e.pointerId, e.clientX, e.clientY) === null) hands.down(e.pointerId, 'mouse', e.clientX, e.clientY)
        return
      }
      const list = e.getCoalescedEvents?.() ?? []
      let seat: 0 | 1 | null = null
      if (list.length > 0) for (const c of list) seat = hands.move(e.pointerId, c.clientX, c.clientY)
      else seat = hands.move(e.pointerId, e.clientX, e.clientY)
      if (seat === 0) e.preventDefault()
    }
    const onUp = (e: PointerEvent): void => {
      const seat = hands.up(e.pointerId)
      if (seat !== null && e.pointerType !== 'mouse') renderer.setTouching(false)
    }
    const arrow = (code: string): keyof typeof keys | null =>
      code === 'ArrowLeft' ? 'left' : code === 'ArrowRight' ? 'right' : code === 'ArrowUp' ? 'up' : code === 'ArrowDown' ? 'down' : null
    const onKey = (e: KeyboardEvent): void => {
      const a = arrow(e.code)
      if (a && playing()) { keys[a] = true; e.preventDefault() }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      const a = arrow(e.code)
      if (a) keys[a] = false
    }
    // The tab went to the background or a call came in: lift the finger, and let the next frame start a fresh clock (the session catches up from the friend's inputs).
    const onAway = (): void => {
      hands.cancelAll()
      renderer.setTouching(false)
      loop.pause()
    }
    const stop = (e: Event): void => e.preventDefault()
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('lostpointercapture', onUp)
    el.addEventListener('contextmenu', stop)
    window.addEventListener('blur', onAway)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)

    setHud({ score: [run.state.score[0], run.state.score[1]], clock: clockText(0, false), sudden: false })
    fit()
    hands.reset(0, me === 0 ? run.state.m[0].x : 1 - run.state.m[1].x, me === 0 ? run.state.m[0].y : 2 - run.state.m[1].y)
    renderer.snap(run.state, performance.now())
    dbg.ready = true
    raf = requestAnimationFrame(frameLoop)

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      run.dispose()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('lostpointercapture', onUp)
      el.removeEventListener('contextmenu', stop)
      window.removeEventListener('blur', onAway)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      delete window.__remotePuck
    }
    // A new match (matchNo) is the only thing that restarts the table; the live handle is read through hRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchNo, seed])
  return { stage, canvas, hud, touch, layout, tally: puckTallyOf(finished) }
}
