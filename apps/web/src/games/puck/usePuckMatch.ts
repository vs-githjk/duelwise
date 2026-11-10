import { useCallback, useEffect, useRef, useState } from 'react'
import { CAP_FRAMES, GRID, NO_INPUT, PHASE, PUCK_EVENTS } from '@duelwise/core/src/games/puck/constants'
import { createBot } from '@duelwise/core/src/games/puck/bots'
import { observe, puckCore } from '@duelwise/core/src/games/puck/core'
import { unitToCell } from '@duelwise/core/src/games/puck/input'
import type { Level } from '@duelwise/core/src/product'
import type { Seat } from '@duelwise/core/src/types'
import { createAgent, type RuntimeAgent } from '@duelwise/agents/src/runtime/agent'
import { liveObs } from '@duelwise/agents/src/puck/view'
import { recordTrainingAllowed } from '../../lib/honest-copy'
import { detectDevice, useMatchRecorder, type FinishedMatch, type Upload } from '../../lib/match-recorder'
import { MalletControl, fitLayout, readSafeInsets, worldToScreen, type Layout } from './input'
import { FixedLoop, PuckMatch } from './loop'
import { personaFor } from '../../personas'
import { momentFor, suddenMoment, type Moment } from './moments'
import { MAX_WAIT_MS, OpponentLink } from './opponent'
import { PuckRenderer, readTheme } from './render'
import { playResult, playTick, snapOf, type Snap } from './sounds'
import { summaryOf, type SeatSummary } from './summary'

// One Glasscut match, from the seed to the replay-checked record.
//
// You are seat 0 and the opponent is seat 1. The sim is a fixed 60 Hz step driven by FixedLoop, so a slow or fast display
// changes how smooth it looks and never what happens. Easy (Pip) is hand-written and plays inside PuckMatch with the env's own
// hands. Marlow, Vesper and Sable are browser agents behind the dispatch (packages/agents): their answers come through an
// OpponentLink and PuckMatch.tickWith steps the sim, under the same level mallet limits. What the sim was fed each tick (both
// seats) is what the recorder stores, so the record replays exactly however late the agent was.

export type Phase = 'setup' | 'loading' | 'playing' | 'over'

export const HUMAN: Seat = 0
export const AGENT: Seat = 1

export interface StartOptions {
  level: Level
  stage: HTMLElement
  canvas: HTMLCanvasElement
  /** A fixed seed makes an unrated test match (the page passes ?seed). */
  seed?: number
}

export interface Hud {
  score: [number, number]
  /** Whose serve it is during the short pause after a goal, else null. */
  serving: 'you' | 'them' | null
  clock: string
  sudden: boolean
}

export interface PuckMatchApi {
  phase: Phase
  level: Level
  paused: boolean
  hud: Hud
  moment: Moment | null
  /** The finished match's counters for you and the opponent, or null while it is on. */
  summary: { you: SeatSummary; them: SeatSummary } | null
  preview: boolean
  failure: string | null
  finished: FinishedMatch | null
  upload: Upload
  unratedReason: string | null
  layout: Layout
  size: { w: number; h: number }
  pointer: 'touch' | 'mouse'
  /** True once a finger has dragged: the thumb strip stops nudging. */
  dragged: boolean
  start: (o: StartOptions) => Promise<void>
  pause: () => void
  resume: () => void
  /** Leaves the match (it is not counted) and returns to the setup screen. */
  quit: () => void
}

interface Params {
  autoplay: boolean
  ff: number
  touch: boolean | null
}

/** Query switches for tests and bug reports. A scripted hand and fast-forward are honoured only with a fixed seed (an unrated match). */
export function readParams(search: string): Params {
  const q = new URLSearchParams(search)
  const fixed = q.has('seed')
  const ff = Number(q.get('ff') ?? 1)
  return {
    autoplay: fixed && q.get('autoplay') === '1',
    ff: fixed && Number.isFinite(ff) ? Math.max(1, Math.min(60, Math.floor(ff))) : 1,
    touch: q.get('touch') === '1' ? true : q.get('touch') === '0' ? false : null,
  }
}

const IDLE_HUD: Hud = { score: [0, 0], serving: null, clock: '6:00', sudden: false }
const MOMENT_MS = 2200

const clockText = (frame: number, sudden: boolean): string => {
  if (sudden) return 'Next goal wins'
  const left = Math.max(0, Math.ceil((CAP_FRAMES - frame) / 60))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

export interface DebugApi {
  ready: boolean
  frame: number
  over: boolean
  winner: number
  score: [number, number]
  phase: number
  mallet: [number, number]
  held: [number, number]
  puck: [number, number]
  landscape: boolean
  scale: number
  paused: boolean
  fps: number
  simMs: number
  drawMs: number
  record: import('@duelwise/core/src/match-record').MatchRecordV1 | null
  toScreen(wx: number, wy: number): [number, number]
}

declare global {
  interface Window {
    /** Debug handle for tests and bug reports: the sim state, the layout, and the finished record. */
    __puck?: DebugApi
  }
}

interface Live {
  match: PuckMatch
  renderer: PuckRenderer
  control: MalletControl
  loop: FixedLoop
  agent: RuntimeAgent | null
  link: OpponentLink
  stage: HTMLElement
  ro: ResizeObserver
  cleanup: () => void
  paused: boolean
  ended: boolean
  stopped: boolean
  raf: number
  waitSince: number
  lateReplies: number
}

export function usePuckMatch(agentVersion: (level: Level) => string, learnsFromHumans = false): PuckMatchApi {
  const recorder = useMatchRecorder('puck')
  const recRef = useRef(recorder)
  recRef.current = recorder
  const [phase, setPhase] = useState<Phase>('setup')
  const [level, setLevel] = useState<Level>('easy')
  const [paused, setPaused] = useState(false)
  const [hud, setHud] = useState<Hud>(IDLE_HUD)
  const [moment, setMoment] = useState<Moment | null>(null)
  const [summary, setSummary] = useState<PuckMatchApi['summary']>(null)
  const [preview, setPreview] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [layout, setLayout] = useState<Layout>({ landscape: false, x: 0, y: 0, scale: 1, edgeGuard: 0 })
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [pointer, setPointer] = useState<'touch' | 'mouse'>('mouse')
  const [dragged, setDragged] = useState(false)
  const live = useRef<Live | null>(null)
  // Bumped by every teardown and unmount: start() gives up after any await that finds it changed, so a player who leaves
  // during loading never gets a match running behind their back.
  const gen = useRef(0)

  const teardown = useCallback(() => {
    gen.current++
    const l = live.current
    if (!l) return
    l.stopped = true
    cancelAnimationFrame(l.raf)
    l.ro.disconnect()
    l.cleanup()
    l.agent?.dispose()
    live.current = null
    if (typeof window !== 'undefined') delete window.__puck
  }, [])
  useEffect(() => teardown, [teardown])

  const setPause = useCallback((on: boolean) => {
    const l = live.current
    if (!l || l.ended || l.paused === on) return
    l.paused = on
    l.loop.pause()
    l.control.cancelAll()
    l.renderer.setTouching(false)
    setPaused(on)
  }, [])

  const start = useCallback(
    async (o: StartOptions) => {
      teardown()
      const my = gen.current
      const stale = () => gen.current !== my
      setFailure(null)
      setPhase('loading')
      setLevel(o.level)
      setPaused(false)
      setHud(IDLE_HUD)
      setMoment(null)
      setSummary(null)
      setDragged(false)
      const params = readParams(window.location.search)
      const coarse = params.touch ?? (window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0)
      setPointer(coarse ? 'touch' : 'mouse')
      // A counted match takes its seed from the server; Glasscut stores every match as Practice, and a fixed ?seed makes an unrated one.
      const seed = (await recRef.current.begin(o.level, o.seed)).seed
      if (stale()) return

      let agent: RuntimeAgent | null = null
      if (o.level !== 'easy') {
        try {
          agent = await createAgent('puck', o.level, { seat: AGENT })
          if (stale()) {
            agent.dispose()
            return
          }
          agent.reset(seed)
        } catch (e) {
          if (stale()) return
          setFailure(e instanceof Error ? e.message : 'The opponent could not start.')
          setPhase('setup')
          return
        }
      }
      setPreview(agent ? agent.preview : false)

      const { stage, canvas } = o
      const insets = () => readSafeInsets()
      let curLayout = fitLayout(stage.clientWidth, stage.clientHeight, coarse, insets())
      const renderer = new PuckRenderer(canvas, readTheme())
      renderer.setOpponent(o.level)
      const control = new MalletControl(curLayout)
      const loop = new FixedLoop()
      const match = new PuckMatch(seed, o.level)
      const link = new OpponentLink()
      const scripted = params.autoplay ? createBot('striker', seed + 1) : null
      const l: Live = {
        match, renderer, control, loop, agent, link, stage, ro: new ResizeObserver(() => fit()), cleanup: () => {}, paused: false, ended: false, stopped: false,
        raf: 0, waitSince: 0, lateReplies: 0,
      }
      live.current = l

      const api: DebugApi = {
        ready: false, frame: 0, over: false, winner: -1, score: [0, 0], phase: 0, mallet: [0, 0], held: [0, 0], puck: [0, 0], landscape: false, scale: 1,
        paused: false, fps: 0, simMs: 0, drawMs: 0, record: null, toScreen: (wx, wy) => worldToScreen(curLayout, wx, wy),
      }
      window.__puck = api

      function fit(): void {
        const w = stage.clientWidth
        const h = stage.clientHeight
        if (w === 0 || h === 0) return
        curLayout = fitLayout(w, h, coarse, insets())
        control.setLayout(curLayout)
        renderer.resize(w, h, curLayout, window.devicePixelRatio || 1)
        setLayout(curLayout)
        setSize({ w, h })
      }

      recRef.current.start({
        seed,
        humanSeat: HUMAN,
        agent: { version: agentVersion(o.level), level: o.level },
        trainingAllowed: recordTrainingAllowed('puck', { learnsFromHumans }),
        input: coarse ? 'touch' : 'mouse',
      })

      let lastKey = '0:0'
      let lastClock = ''
      let lastServe: Hud['serving'] = null
      let momentId = 0
      let momentTimer: ReturnType<typeof setTimeout> | undefined
      let wasSudden = false
      const oppName = personaFor(o.level).name
      const showMoment = (m: Moment | null): void => {
        if (!m) return
        setMoment(m)
        clearTimeout(momentTimer)
        momentTimer = setTimeout(() => setMoment((cur) => (cur?.id === m.id ? null : cur)), MOMENT_MS)
      }
      let simAcc = 0
      let simN = 0
      let drawAcc = 0
      let drawN = 0
      let dtAcc = 0
      let dtN = 0
      let lastRaf = 0
      let lastStat = 0

      const askAgent = (): void => {
        const a = l.agent
        if (!a) return
        const s = match.s
        const q = link.ask(s.frame)
        a.act(liveObs(s, AGENT), { frame: s.frame })
          .then((out) => {
            if (l.stopped) return
            if (s.frame - q.frame > 4) l.lateReplies++
            link.answer(q, Number.isInteger(out[0]) ? out[0]! : NO_INPUT)
          })
          .catch((e: unknown) => {
            link.forget(q)
            if (l.stopped) return
            setFailure(e instanceof Error ? e.message : 'The opponent stopped responding.')
            teardown()
            setPhase('setup')
          })
      }

      const conclude = async (): Promise<void> => {
        l.ended = true
        try {
          const out = await recRef.current.finish(puckCore, match.s)
          api.record = out.record
        } catch (e) {
          setFailure(e instanceof Error ? e.message : 'The match record could not be made.')
        }
        setSummary({ you: summaryOf(match.s, HUMAN), them: summaryOf(match.s, AGENT) })
        playResult(match.s.winner, HUMAN)
        setPhase('over')
      }

      const soundSnap: Snap = snapOf(match.s)
      const tickOnce = (): void => {
        const s = match.s
        const frame = s.frame
        snapOf(s, soundSnap)
        let code: number
        if (scripted) {
          if (frame % 2 === 0) {
            const t = scripted.act(observe(s, HUMAN))
            code = unitToCell(t[0]) + GRID * unitToCell(t[1])
          } else code = NO_INPUT
        } else code = control.takeCode()
        if (l.agent) {
          if (s.phase !== PHASE.OVER) askAgent()
          match.tickWith(code, link.take())
        } else match.tick(code)
        recRef.current.act(frame, HUMAN, code)
        recRef.current.act(frame, AGENT, match.inputs[1])
        renderer.push(s, performance.now())
        playTick(soundSnap, s, HUMAN)
        if (s.ev !== 0) {
          if (s.ev & (1 << PUCK_EVENTS.goal)) navigator.vibrate?.(14)
          showMoment(momentFor(s, ++momentId, oppName))
        }
      }

      const afterTicks = (): void => {
        const s = match.s
        if (s.sudden === 1 && !wasSudden && !match.over) showMoment(suddenMoment(++momentId))
        wasSudden = s.sudden === 1
        const key = `${s.score[0]}:${s.score[1]}`
        const clock = clockText(s.frame, s.sudden === 1)
        const serving: Hud['serving'] = s.phase === PHASE.READY && s.frame > 0 ? (s.serveSeat === HUMAN ? 'you' : 'them') : null
        if (key !== lastKey || clock !== lastClock || serving !== lastServe) {
          lastKey = key
          lastClock = clock
          lastServe = serving
          setHud({ score: [s.score[0], s.score[1]], serving, clock, sudden: s.sudden === 1 })
        }
        if (match.over && !l.ended) void conclude()
      }

      const frameLoop = (now: number): void => {
        if (l.stopped) return
        l.raf = requestAnimationFrame(frameLoop)
        if (l.paused) {
          lastRaf = 0
        } else {
          if (lastRaf > 0) { dtAcc += now - lastRaf; dtN++ }
          lastRaf = now
          if (!l.ended) {
            const t0 = performance.now()
            const hold = (): boolean => {
              if (!l.agent || !link.mustWait(match.s.frame)) {
                l.waitSince = 0
                return false
              }
              if (l.waitSince === 0) l.waitSince = now
              if (now - l.waitSince < MAX_WAIT_MS) return true
              l.lateReplies += link.giveUp()
              l.waitSince = 0
              return false
            }
            const n = loop.advance(now, () => {
              for (let k = 0; k < params.ff && !match.over; k++) tickOnce()
            }, hold)
            if (n > 0) {
              simAcc += (performance.now() - t0) / n
              simN++
              afterTicks()
            }
          }
        }
        renderer.draw(loop.alpha, now, match.s)
        drawAcc += renderer.lastDrawMs
        drawN++
        if (now - lastStat > 500) {
          lastStat = now
          api.fps = dtN > 0 ? Math.round((1000 * dtN) / dtAcc) : 0
          api.simMs = simN > 0 ? simAcc / simN : 0
          api.drawMs = drawN > 0 ? drawAcc / drawN : 0
          dtAcc = dtN = simAcc = simN = drawAcc = drawN = 0
        }
        const s = match.s
        api.frame = s.frame; api.over = match.over; api.winner = s.winner; api.phase = s.phase
        api.score = [s.score[0], s.score[1]]
        api.mallet = [s.m[0].x, s.m[0].y]; api.held = control.target(); api.puck = [s.px, s.py]
        api.landscape = curLayout.landscape; api.scale = curLayout.scale; api.paused = l.paused
      }

      // Pointer events. A finger that lands on a button or a menu belongs to it.
      const onControl = (e: Event): boolean => (e.target as Element | null)?.closest('button, a, [role="dialog"], [data-no-play]') != null
      const onDown = (e: PointerEvent): void => {
        if (onControl(e) || l.paused || match.over) return
        if (e.pointerType === 'mouse' && e.button !== 0) return
        if (control.down(e.pointerId, e.pointerType, e.clientX, e.clientY, e.timeStamp)) {
          if (e.pointerType !== 'mouse') {
            try { stage.setPointerCapture(e.pointerId) } catch { /* the browser ended this pointer */ }
            renderer.setTouching(true)
          }
          e.preventDefault()
        }
      }
      const onMove = (e: PointerEvent): void => {
        if (l.paused || match.over) return
        if (e.pointerType === 'mouse') {
          control.move(e.pointerId, 'mouse', e.clientX, e.clientY, e.timeStamp)
          return
        }
        if (!control.active(e.pointerId)) return
        const list = e.getCoalescedEvents?.() ?? []
        if (list.length > 0) for (const c of list) control.move(e.pointerId, e.pointerType, c.clientX, c.clientY, c.timeStamp)
        else control.move(e.pointerId, e.pointerType, e.clientX, e.clientY, e.timeStamp)
        setDragged(true)
        e.preventDefault()
      }
      const onUp = (e: PointerEvent): void => {
        if (control.active(e.pointerId)) renderer.setTouching(false)
        control.up(e.pointerId)
      }
      // A hidden tab, a blurred window, a call or the app switcher pauses the match and starts a fresh clock: no catch-up burst on return.
      const onHidden = (): void => { if (document.hidden) setPause(true) }
      const onAway = (): void => setPause(true)
      const onKey = (e: KeyboardEvent): void => {
        if (e.code === 'Escape' || e.code === 'KeyP') { if (!match.over) setPause(!l.paused) }
      }
      const stop = (e: Event): void => e.preventDefault()
      stage.addEventListener('pointerdown', onDown)
      stage.addEventListener('pointermove', onMove)
      stage.addEventListener('pointerup', onUp)
      stage.addEventListener('pointercancel', onUp)
      stage.addEventListener('lostpointercapture', onUp)
      stage.addEventListener('contextmenu', stop)
      document.addEventListener('visibilitychange', onHidden)
      window.addEventListener('blur', onAway)
      window.addEventListener('pagehide', onAway)
      window.addEventListener('keydown', onKey)
      l.cleanup = () => {
        clearTimeout(momentTimer)
        stage.removeEventListener('pointerdown', onDown)
        stage.removeEventListener('pointermove', onMove)
        stage.removeEventListener('pointerup', onUp)
        stage.removeEventListener('pointercancel', onUp)
        stage.removeEventListener('lostpointercapture', onUp)
        stage.removeEventListener('contextmenu', stop)
        document.removeEventListener('visibilitychange', onHidden)
        window.removeEventListener('blur', onAway)
        window.removeEventListener('pagehide', onAway)
        window.removeEventListener('keydown', onKey)
      }

      l.ro.observe(stage)
      fit()
      control.reset(match.s.m[0].x, match.s.m[0].y)
      renderer.snap(match.s, performance.now())
      api.ready = true
      setPhase('playing')
      l.raf = requestAnimationFrame(frameLoop)
    },
    [teardown, setPause, agentVersion, learnsFromHumans],
  )

  const quit = useCallback(() => {
    teardown()
    setPaused(false)
    setPhase('setup')
    setHud(IDLE_HUD)
    setMoment(null)
  }, [teardown])

  return {
    phase, level, paused, hud, moment, summary, preview, failure, finished: recorder.finished, upload: recorder.upload, unratedReason: recorder.unratedReason,
    layout, size, pointer, dragged, start, pause: () => setPause(true), resume: () => setPause(false), quit,
  }
}
