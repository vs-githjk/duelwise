import { useCallback, useEffect, useRef, useState } from 'react'
import { CAP_FRAMES, PUCK_EVENTS } from '@duelwise/core/src/games/puck/constants'
import type { Result } from '@duelwise/core/src/types'
import { NO_INSETS, readSafeInsets, worldToScreen, type Layout } from '../puck/input'
import { FixedLoop } from '../puck/loop'
import { PuckRenderer, readTheme } from '../puck/render'
import { playResult, playTick, snapOf, type Snap } from '../puck/sounds'
import { TwoHands, fingerOffset, fitLocalLayout } from '../puck/two-hands'
import { bottomPerson, localPuckResult, puckTally, startLocalPuck, stepLocalPuck, type Person } from './local-puck'
import { browserEntropy, normalizeNames, PLAYER_ONE, PLAYER_TWO, type Entropy, type LocalSetup } from './useLocalDuel'

// One Glasscut sitting for two people on one device: a fixed 60 Hz loop over the real sim, two fingers (or a mouse and the arrow keys),
// the rematch that swaps ends, and the score of the sitting. Nothing here starts, finishes or uploads a match, reads the server or
// writes storage: a friend game is never rated, never stored and never trained on (decisions.md, Nov 9 and Nov 10).

export interface PuckHud {
  score: [number, number]
  clock: string
  sudden: boolean
}

export interface LocalPuckApi {
  stage: React.RefObject<HTMLDivElement | null>
  canvas: React.RefObject<HTMLCanvasElement | null>
  names: [string, string]
  /** The person at the bottom end now (seat 0) and the top end (seat 1). */
  bottom: Person
  hud: PuckHud
  paused: boolean
  /** The result by game seat, or null while the match is on. */
  result: Result | null
  tally: { one: number; two: number; draws: number }
  /** True when this device has a touch screen (the page shows the two-thumb help; a mouse and arrow keys still work). */
  touch: boolean
  layout: Layout
  pause: () => void
  resume: () => void
  rematch: () => void
  /** The seat that owns the person's name at the bottom/top: names by game seat. */
  seatNames: [string, string]
}

/** Test switches (a fixed `?seed` makes the match a test match): `lead` starts both scores that high, `touch=1|0` forces the touch layout. */
export function readLocalParams(search: string): { seed: number | undefined; lead: number; touch: boolean | null; ff: number } {
  const q = new URLSearchParams(search)
  const raw = q.get('seed')
  const seed = raw !== null && /^\d{1,10}$/.test(raw) && Number(raw) < 2 ** 32 ? Number(raw) : undefined
  const lead = Number(q.get('lead') ?? 0)
  const ff = Number(q.get('ff') ?? 1)
  return {
    seed,
    lead: seed !== undefined && Number.isFinite(lead) ? Math.max(0, Math.floor(lead)) : 0,
    touch: q.get('touch') === '1' ? true : q.get('touch') === '0' ? false : null,
    ff: seed !== undefined && Number.isFinite(ff) ? Math.max(1, Math.min(30, Math.floor(ff))) : 1,
  }
}

const clockText = (frame: number, sudden: boolean): string => {
  if (sudden) return 'Next goal wins'
  const left = Math.max(0, Math.ceil((CAP_FRAMES - frame) / 60))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

const IDLE_HUD: PuckHud = { score: [0, 0], clock: '6:00', sudden: false }
/** Arrow keys move the top mallet's target this fraction of the table width per tick. */
const KEY_STEP = 0.018

export interface FriendPuckDebug {
  ready: boolean
  frame: number
  over: boolean
  score: [number, number]
  /** Both mallets and the puck in table units (y runs 0 at the bottom goal to 2 at the top goal). */
  mallets: [[number, number], [number, number]]
  puck: [number, number]
  offset: number
  toScreen(wx: number, wy: number): [number, number]
}

declare global {
  interface Window {
    /** Debug handle for the friend page's tests. */
    __friendPuck?: FriendPuckDebug
  }
}

export function useLocalPuck(setup: LocalSetup, entropy: Entropy = browserEntropy): LocalPuckApi {
  const names = useRef<[string, string]>(normalizeNames(setup.names))
  const firstBottom = useRef<Person>(setup.side === 'random' ? (entropy.coin() === 0 ? PLAYER_ONE : PLAYER_TWO) : setup.side === 0 ? PLAYER_ONE : PLAYER_TWO)
  const stage = useRef<HTMLDivElement | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const [game, setGame] = useState(0)
  const [hud, setHud] = useState<PuckHud>(IDLE_HUD)
  const [paused, setPaused] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [finished, setFinished] = useState<Array<{ winner: 0 | 1 | null; bottom: Person }>>([])
  const [layout, setLayout] = useState<Layout>(() => fitLocalLayout(390, 844, NO_INSETS))
  const [touch, setTouch] = useState(false)
  const ctl = useRef<{ pause: () => void; resume: () => void } | null>(null)
  const bottom = bottomPerson(firstBottom.current, game)
  const bottomRef = useRef(bottom)
  bottomRef.current = bottom

  // One effect per game: a rematch is a new game number, so the loop, the listeners and the table are rebuilt from the new seed.
  useEffect(() => {
    const el = stage.current
    const cv = canvas.current
    if (!el || !cv) return
    const params = readLocalParams(window.location.search)
    const coarse = params.touch ?? (window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0)
    setTouch(coarse)
    // A fixed ?seed is for the first game only; every rematch draws a new seed.
    const seed = game === 0 && params.seed !== undefined ? params.seed : entropy.seed()
    const s = startLocalPuck(seed, game === 0 ? params.lead : 0)
    let curLayout = fitLocalLayout(el.clientWidth || 390, el.clientHeight || 844, readSafeInsets())
    const renderer = new PuckRenderer(cv, readTheme())
    renderer.setOpponent('easy')
    const hands = new TwoHands(curLayout)
    const loop = new FixedLoop()
    const soundSnap: Snap = snapOf(s)
    const keys = { left: false, right: false, up: false, down: false }
    let raf = 0
    let stopped = false
    let isPaused = false
    let ended = false
    let lastKey = ''
    let lastClock = ''

    const fit = (): void => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w === 0 || h === 0) return
      curLayout = fitLocalLayout(w, h, readSafeInsets())
      hands.setLayout(curLayout)
      renderer.resize(w, h, curLayout, window.devicePixelRatio || 1)
      setLayout(curLayout)
    }
    const ro = new ResizeObserver(fit)
    ro.observe(el)

    const dbg: FriendPuckDebug = {
      ready: false, frame: 0, over: false, score: [0, 0], mallets: [[0, 0], [0, 0]], puck: [0, 0], offset: fingerOffset(curLayout),
      toScreen: (wx, wy) => worldToScreen(curLayout, wx, wy),
    }
    window.__friendPuck = dbg

    const tickOnce = (): void => {
      snapOf(s, soundSnap)
      if (keys.left || keys.right || keys.up || keys.down) {
        const step = KEY_STEP * curLayout.scale
        hands.nudgeScreen(1, ((keys.right ? 1 : 0) - (keys.left ? 1 : 0)) * step, ((keys.down ? 1 : 0) - (keys.up ? 1 : 0)) * step)
      }
      stepLocalPuck(s, hands.takeCode(0), hands.takeCode(1))
      renderer.push(s, performance.now())
      playTick(soundSnap, s, 0)
      if (s.ev & (1 << PUCK_EVENTS.goal)) navigator.vibrate?.(14)
    }

    const afterTicks = (): void => {
      const key = `${s.score[0]}:${s.score[1]}`
      const clock = clockText(s.frame, s.sudden === 1)
      if (key !== lastKey || clock !== lastClock) {
        lastKey = key
        lastClock = clock
        setHud({ score: [s.score[0], s.score[1]], clock, sudden: s.sudden === 1 })
      }
      if (s.matchOver === 1 && !ended) {
        ended = true
        const r = localPuckResult(s)!
        setFinished((f) => [...f, { winner: r.winner, bottom: bottomRef.current }])
        setResult(r)
        playResult(r.winner ?? -1, 0)
      }
    }

    const frameLoop = (now: number): void => {
      if (stopped) return
      raf = requestAnimationFrame(frameLoop)
      if (!isPaused && !ended) {
        const n = loop.advance(now, () => {
          for (let k = 0; k < params.ff && s.matchOver === 0; k++) tickOnce()
        })
        if (n > 0) afterTicks()
      }
      renderer.draw(loop.alpha, now, s)
      dbg.frame = s.frame
      dbg.over = s.matchOver === 1
      dbg.score = [s.score[0], s.score[1]]
      dbg.mallets = [[s.m[0].x, s.m[0].y], [s.m[1].x, s.m[1].y]]
      dbg.puck = [s.px, s.py]
      dbg.offset = fingerOffset(curLayout)
    }

    const setPause = (on: boolean): void => {
      if (on) keys.left = keys.right = keys.up = keys.down = false
      if (ended || isPaused === on) return
      isPaused = on
      loop.pause()
      hands.cancelAll()
      renderer.setTouching(false)
      setPaused(on)
    }
    ctl.current = { pause: () => setPause(true), resume: () => setPause(false) }

    // A finger that lands on a button or a menu belongs to it.
    const onControl = (e: Event): boolean => (e.target as Element | null)?.closest('button, a, [role="dialog"], [data-no-play]') != null
    const touching = (): boolean => dbg.ready && !isPaused
    const onDown = (e: PointerEvent): void => {
      if (onControl(e) || !touching() || ended) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const seat = hands.down(e.pointerId, e.pointerType, e.clientX, e.clientY)
      if (seat === null) return
      if (e.pointerType !== 'mouse') {
        try { el.setPointerCapture(e.pointerId) } catch { /* the browser ended this pointer */ }
        renderer.setTouching(true)
      }
      e.preventDefault()
    }
    const onMove = (e: PointerEvent): void => {
      if (!touching() || ended) return
      if (e.pointerType === 'mouse') {
        // A mouse steers the bottom mallet by hovering, no press needed.
        if (hands.move(e.pointerId, e.clientX, e.clientY) === null) hands.down(e.pointerId, 'mouse', e.clientX, e.clientY)
        return
      }
      const list = e.getCoalescedEvents?.() ?? []
      let seat: 0 | 1 | null = null
      if (list.length > 0) for (const c of list) seat = hands.move(e.pointerId, c.clientX, c.clientY)
      else seat = hands.move(e.pointerId, e.clientX, e.clientY)
      if (seat !== null) e.preventDefault()
    }
    const onUp = (e: PointerEvent): void => {
      const seat = hands.up(e.pointerId)
      if (seat !== null && e.pointerType !== 'mouse') renderer.setTouching(false)
    }
    const onHidden = (): void => { if (document.hidden) setPause(true) }
    // Losing the window sends no key-up: a held arrow must not stay held (the pause itself may already be on).
    const clearKeys = (): void => { keys.left = keys.right = keys.up = keys.down = false }
    const onAway = (): void => { clearKeys(); setPause(true) }
    const arrow = (code: string): keyof typeof keys | null =>
      code === 'ArrowLeft' ? 'left' : code === 'ArrowRight' ? 'right' : code === 'ArrowUp' ? 'up' : code === 'ArrowDown' ? 'down' : null
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Escape' || e.code === 'KeyP') { if (!ended) setPause(!isPaused); return }
      const a = arrow(e.code)
      if (a && !ended) { keys[a] = true; e.preventDefault() }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      const a = arrow(e.code)
      if (a) keys[a] = false
    }
    const stop = (e: Event): void => e.preventDefault()
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('lostpointercapture', onUp)
    el.addEventListener('contextmenu', stop)
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('blur', onAway)
    window.addEventListener('pagehide', onAway)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)

    setHud({ score: [s.score[0], s.score[1]], clock: clockText(0, false), sudden: false })
    setResult(null)
    setPaused(false)
    fit()
    hands.reset(0, s.m[0].x, s.m[0].y)
    hands.reset(1, 1 - s.m[1].x, 2 - s.m[1].y)
    renderer.snap(s, performance.now())
    dbg.ready = true
    raf = requestAnimationFrame(frameLoop)

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('lostpointercapture', onUp)
      el.removeEventListener('contextmenu', stop)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('blur', onAway)
      window.removeEventListener('pagehide', onAway)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      ctl.current = null
      delete window.__friendPuck
    }
    // The game number is the only thing that restarts the table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game])

  const pause = useCallback(() => ctl.current?.pause(), [])
  const resume = useCallback(() => ctl.current?.resume(), [])
  const rematch = useCallback(() => setGame((g) => g + 1), [])
  const seatNames: [string, string] = bottom === PLAYER_ONE ? [names.current[0], names.current[1]] : [names.current[1], names.current[0]]
  return { stage, canvas, names: names.current, bottom, hud, paused, result, tally: puckTally(finished), touch, layout, pause, resume, rematch, seatNames }
}
