import { useCallback, useEffect, useRef, useState } from 'react'
import { fighterCore, stepPacked } from '@duelwise/core/src/games/fighter/core'
import { MAX_HEALTH } from '@duelwise/core/src/games/fighter/constants'
import { packInput } from '@duelwise/core/src/games/fighter/input'
import { MOVES } from '@duelwise/core/src/games/fighter/moves'
import { copyState, createState, EV, PHASE, type FighterState } from '@duelwise/core/src/games/fighter/state'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import type { Level } from '@duelwise/core/src/product'
import type { Seat } from '@duelwise/core/src/types'
import { createAgent, type RuntimeAgent } from '@duelwise/agents/src/runtime/agent'
import { seatView, viewDue, FRAME_SKIP } from '@duelwise/agents/src/fighter/view'
import { recordTrainingAllowed } from '../../lib/honest-copy'
import { detectDevice, useMatchRecorder, type FinishedMatch, type Upload } from '../../lib/match-recorder'
import { DebugRenderer, type StageRenderer } from './render/DebugRenderer'
import { AgentLink, MAX_WAIT_MS } from './agentLink'
import { KeyboardInput, loadKeyMap, saveKeyMap, type KeyMap } from './input'
import type { Callout, HudView } from './hud'
import { playCue } from './sounds'

// One fighter match, from the seed to the replay-checked record.
//
// The sim is a fixed 60 Hz step driven by an accumulator, so a slow display never changes what happens,
// only how smooth it looks. The agent runs in a worker: the loop sends it the frames viewDue() lists, and
// an AgentLink holds each answer from the step after the one that asked (the lag the env trains with),
// standing still for at most MAX_WAIT_MS when an answer is due and has not landed. What the sim was fed each
// frame (both seats) is what the recorder stores, so the record replays exactly however late the worker was.

export type Phase = 'setup' | 'loading' | 'playing' | 'over'

export const HUMAN: Seat = 0
export const AGENT: Seat = 1

export interface CharacterChoice {
  character: number
  colorway: number
}

export interface StartOptions {
  level: Level
  /** Seat 0 (you) and seat 1 (the agent). */
  choices: [CharacterChoice, CharacterChoice]
  seed?: number
}

export interface FighterMatch {
  phase: Phase
  level: Level
  paused: boolean
  hud: HudView | null
  callouts: Callout[]
  /** "stage" for the 3D renderer, "debug view" when it fell back to boxes. */
  rendererLabel: 'stage' | 'debug view'
  preview: boolean
  failure: string | null
  finished: FinishedMatch | null
  upload: Upload
  unratedReason: string | null
  keys: KeyMap
  setKeys: (k: KeyMap) => void
  start: (el: HTMLElement, o: StartOptions) => Promise<void>
  pause: () => void
  resume: () => void
  /** Leaves the match (it is not counted) and returns to the setup screens. */
  quit: () => void
  /** Pause menu count, for the honest line in the pause menu. */
  pauses: number
  touchAction: (action: import('./input').Action, down: boolean) => void
}

interface Params {
  speed: number
  agentLagMs: number
  forceDebug: boolean
}

/** Query switches for tests and bug reports. `speed` is honoured only with a fixed seed (an unrated match). */
export function readParams(search: string): Params {
  const q = new URLSearchParams(search)
  const num = (k: string, lo: number, hi: number, d: number) => {
    const raw = q.get(k)
    if (raw === null || !/^\d{1,4}$/.test(raw)) return d
    return Math.min(hi, Math.max(lo, Number(raw)))
  }
  return {
    speed: q.has('seed') ? num('speed', 1, 30, 1) : 1,
    agentLagMs: num('agentlag', 0, 5000, 0),
    forceDebug: q.get('renderer') === 'debug',
  }
}

/**
 * A slow display must not slow the match: after a long frame the loop catches up by stepping the sim several
 * times before drawing. The catch-up is bounded (half a second of sim, 30 steps), so a stalled tab does not
 * replay minutes of play as one burst; a tab that is hidden pauses the match instead.
 */
const MAX_CATCHUP_SECONDS = 0.5
const MAX_STEPS_PER_TICK = 30
const KO_SLOW_FRAMES = 45
const KO_SLOW_SCALE = 0.25
const CALLOUT_MS = 900
const COMBO_LINGER = 45
const MAX_INFLIGHT = 12

/** What the page shows for a level's limits, from the same config the agent and the trainer use. */
export function limitsText(level: Level): string {
  const c = LEVEL_LIMITS.fighter[level]
  return `Reacts in ${delayMsFor(level)} ms, ${c.apmCap === null ? 'no action cap' : `at most ${c.apmCap} actions a minute`}`
}
export const delayMsFor = (level: Level): number => Math.round((LEVEL_LIMITS.fighter[level].delayFrames * 1000) / 60)
export const apmCapFor = (level: Level): number | null => LEVEL_LIMITS.fighter[level].apmCap

function hudFrom(s: FighterState, combos: HudView['combo']): HudView {
  const [a, b] = s.fighters
  return {
    phase: s.phase,
    phaseFrame: s.phaseFrame,
    round: s.round,
    timer: s.timer,
    wins: [s.wins[0], s.wins[1]],
    health: [a.health, b.health],
    surge: [a.surge, b.surge],
    overheat: [a.overheat, b.overheat],
    superMeter: [a.superMeter, b.superMeter],
    combo: combos,
  }
}

interface Live {
  prev: FighterState
  cur: FighterState
  agent: RuntimeAgent
  renderer: StageRenderer
  classify: ((prev: FighterState, next: FighterState, defender: 0 | 1) => 'counter' | 'punish' | null) | null
  seed: number
  level: Level
  params: Params
  acc: number
  last: number
  raf: number
  slow: number
  anchor: number
  wasFighting: boolean
  link: AgentLink
  waitSince: number
  inflight: number
  lateReplies: number
  comboBase: [number, number]
  combos: HudView['combo']
  comboUntil: [number, number]
  lastHudFrame: number
  calloutId: number
  ended: boolean
  stopped: boolean
  pauseCount: number
}

export function useFighterMatch(agentVersion: (level: Level) => string, learnsFromHumans = false): FighterMatch {
  const recorder = useMatchRecorder('fighter')
  const [phase, setPhase] = useState<Phase>('setup')
  const [level, setLevel] = useState<Level>('easy')
  const [paused, setPaused] = useState(false)
  const [hud, setHud] = useState<HudView | null>(null)
  const [callouts, setCallouts] = useState<Callout[]>([])
  const [rendererLabel, setRendererLabel] = useState<'stage' | 'debug view'>('stage')
  const [preview, setPreview] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [keys, setKeysState] = useState<KeyMap>(loadKeyMap)
  const [pauses, setPauses] = useState(0)
  const live = useRef<Live | null>(null)
  const pausedRef = useRef(false)
  const kb = useRef(new KeyboardInput(keys))
  const recRef = useRef(recorder)
  recRef.current = recorder

  const setKeys = useCallback((k: KeyMap) => {
    setKeysState(k)
    kb.current.setMap(k)
    saveKeyMap(k)
  }, [])

  // Bumped by every teardown and unmount. start() records it on entry and gives up after any await that
  // finds it changed, so a player who leaves during loading never gets a match running behind their back.
  const gen = useRef(0)

  const teardown = useCallback(() => {
    gen.current++
    const l = live.current
    if (!l) return
    l.stopped = true
    cancelAnimationFrame(l.raf)
    l.agent.dispose()
    l.renderer.dispose()
    live.current = null
    if (typeof window !== 'undefined') delete window.__fighter
  }, [])

  useEffect(() => teardown, [teardown])

  const setPause = useCallback((on: boolean) => {
    if (pausedRef.current === on) return
    const l = live.current
    if (on && (!l || l.ended)) return
    pausedRef.current = on
    setPaused(on)
    if (on && l) {
      l.pauseCount++
      setPauses(l.pauseCount)
      kb.current.blur()
    }
    if (!on && l) l.last = performance.now()
  }, [])

  // Keys while a match is on: Escape pauses, bound keys go to the sampler and never scroll the page.
  useEffect(() => {
    if (phase !== 'playing') return
    const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    const down = (e: KeyboardEvent) => {
      if (editable(e.target)) return
      const a = kb.current.actionFor(e.code)
      if (!a) return
      e.preventDefault()
      if (a === 'pause') {
        if (!e.repeat) setPause(!pausedRef.current)
        return
      }
      if (!pausedRef.current) kb.current.down(e.code)
    }
    const up = (e: KeyboardEvent) => {
      if (kb.current.actionFor(e.code)) e.preventDefault()
      kb.current.up(e.code)
    }
    const blur = () => kb.current.blur()
    const hidden = () => {
      if (document.hidden) setPause(true)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', hidden)
      kb.current.blur()
    }
  }, [phase, setPause])

  const start = useCallback(
    async (el: HTMLElement, o: StartOptions) => {
      teardown()
      const my = gen.current
      const stale = () => gen.current !== my
      setFailure(null)
      setPhase('loading')
      setLevel(o.level)
      setHud(null)
      setCallouts([])
      setPauses(0)
      pausedRef.current = false
      setPaused(false)
      const params = readParams(window.location.search)
      // A counted match takes its seed from the server; a fixed ?seed makes an unrated match.
      const seed = (await recRef.current.begin(o.level, o.seed)).seed
      if (stale()) return

      let agent: RuntimeAgent
      try {
        agent = await createAgent('fighter', o.level, { seat: AGENT })
        if (stale()) {
          agent.dispose()
          return
        }
        agent.reset(seed)
        setPreview(agent.preview)
      } catch (e) {
        if (stale()) return
        setFailure(e instanceof Error ? e.message : 'The opponent could not start.')
        setPhase('setup')
        return
      }

      let renderer: StageRenderer | null = null
      let classify: Live['classify'] = null
      if (!params.forceDebug) {
        try {
          const mod = await import('./render/FighterRenderer')
          if (stale()) {
            agent.dispose()
            return
          }
          const r = new mod.FighterRenderer({ choices: o.choices })
          try {
            await r.mount(el)
          } catch (e) {
            r.dispose()
            throw e
          }
          if (stale()) {
            r.dispose()
            agent.dispose()
            return
          }
          renderer = {
            label: 'stage',
            mount: (h) => r.mount(h),
            onStep: (p, n) => r.onStep(p, n),
            render: (p, n, a) => r.render(p, n, a, []),
            resize: (w, h) => r.resize(w, h),
            dispose: () => r.dispose(),
          }
          classify = mod.counterKindFor
        } catch (e) {
          console.warn('fighter: 3D stage unavailable, using the debug view', e)
          renderer = null
        }
      }
      if (!renderer) {
        renderer = new DebugRenderer()
        await renderer.mount(el)
        if (stale()) {
          renderer.dispose()
          agent.dispose()
          return
        }
      }
      setRendererLabel(renderer.label)
      const ro = new ResizeObserver(() => renderer!.resize(Math.max(1, el.clientWidth), Math.max(1, el.clientHeight)))
      ro.observe(el)
      const baseDispose = renderer.dispose.bind(renderer)
      renderer.dispose = () => {
        ro.disconnect()
        baseDispose()
      }

      const cur = createState(seed)
      const prev = createState(seed)
      copyState(prev, cur)
      const l: Live = {
        prev, cur, agent, renderer, classify, seed, level: o.level, params, acc: 0, last: performance.now(), raf: 0, slow: 0,
        anchor: -1, wasFighting: false, link: new AgentLink(), waitSince: 0, inflight: 0, lateReplies: 0, comboBase: [MAX_HEALTH, MAX_HEALTH],
        combos: [null, null], comboUntil: [0, 0], lastHudFrame: -99, calloutId: 0, ended: false, stopped: false, pauseCount: 0,
      }
      live.current = l
      window.__fighter = { frame: 0, lateReplies: 0, record: null }

      recRef.current.start({
        seed,
        humanSeat: HUMAN,
        agent: { version: agentVersion(o.level), level: o.level },
        trainingAllowed: recordTrainingAllowed('fighter', { learnsFromHumans }),
        input: detectDevice() === 'desktop' ? 'keyboard' : 'touch',
      })
      kb.current.blur()
      setHud(hudFrom(cur, l.combos))
      setPhase('playing')

      const limits = LEVEL_LIMITS.fighter[o.level]

      const schedule = () => {
        const due = viewDue(l.cur.frame, l.anchor, limits.delayFrames)
        if (!due.capture && !due.decide) return
        if (l.inflight >= MAX_INFLIGHT) return
        const issued = l.cur.frame
        const q = l.link.ask(issued, due.decide)
        l.inflight++
        l.agent
          .act(seatView(l.cur, AGENT), { frame: issued, anchor: l.anchor })
          .then((a) => {
            const deliver = () => {
              if (l.stopped) return
              l.link.answer(q, packInput({ dir: a[0]!, btn: a[1]! }))
              if (l.cur.frame - issued > FRAME_SKIP) {
                l.lateReplies++
                if (window.__fighter) window.__fighter.lateReplies = l.lateReplies
              }
            }
            l.inflight--
            if (l.params.agentLagMs > 0) setTimeout(deliver, l.params.agentLagMs)
            else deliver()
          })
          .catch((e: unknown) => {
            l.inflight--
            l.link.forget(q)
            if (l.stopped) return
            fail(e instanceof Error ? e.message : 'The opponent stopped responding.')
          })
      }

      const fail = (msg: string) => {
        if (l.stopped) return
        setFailure(msg)
        teardown()
        setPhase('setup')
      }

      const conclude = async () => {
        l.ended = true
        try {
          const out = await recRef.current.finish(fighterCore, l.cur)
          if (window.__fighter) window.__fighter.record = out.record
          const r = out.record.result
          playCue(r.winner === HUMAN ? 'win' : 'lose', 600)
        } catch (e) {
          setFailure(e instanceof Error ? e.message : 'The match record could not be made.')
        }
        setPhase('over')
        setHud(hudFrom(l.cur, [null, null]))
      }

      const stepOnce = () => {
        const s = l.cur
        const fighting = s.phase === PHASE.FIGHT
        if (fighting) {
          if (!l.wasFighting) l.anchor = s.frame
          schedule()
        }
        if (fighting !== l.wasFighting && fighting) playCue('fight')
        l.wasFighting = fighting
        const p0 = fighting ? packInput(kb.current.sample()) : 0
        const p1 = fighting ? l.link.inputAt(s.frame) : 0
        recRef.current.act(s.frame, HUMAN, p0)
        recRef.current.act(s.frame, AGENT, p1)
        const phaseBefore = s.phase
        const hpBefore: [number, number] = [s.fighters[0].health, s.fighters[1].health]
        const comboBefore: [number, number] = [s.fighters[0].comboCount, s.fighters[1].comboCount]
        copyState(l.prev, s)
        stepPacked(s, p0, p1)
        l.renderer.onStep(l.prev, s)
        observe(phaseBefore, hpBefore, comboBefore)
        if (window.__fighter) window.__fighter.frame = s.frame
      }

      // Everything the HUD and sounds derive from one sim step.
      const observe = (phaseBefore: number, hpBefore: [number, number], comboBefore: [number, number]) => {
        const s = l.cur
        let urgent = s.phase !== phaseBefore
        const fresh: Callout[] = []
        for (const i of [0, 1] as const) {
          const f = s.fighters[i]!
          const ev = f.events
          if (ev === 0) continue
          urgent = true
          const attacker = (1 - i) as 0 | 1
          if (ev & EV.HIT_TAKEN && !(ev & EV.THROWN)) {
            const kind = l.classify?.(l.prev, s, i) ?? null
            if (kind) fresh.push({ id: ++l.calloutId, kind, seat: attacker })
            const heavy = MOVES[s.fighters[attacker]!.moveId]?.damage ?? 0
            playCue(heavy >= 700 ? 'hit-heavy' : 'hit-light')
            if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) navigator.vibrate?.(12)
          }
          if (ev & EV.BLOCKED) playCue('block')
          if (ev & EV.DEFLECTED) fresh.push({ id: ++l.calloutId, kind: 'deflect', seat: i })
          if (ev & EV.KO) {
            l.slow = KO_SLOW_FRAMES
            playCue('ko')
          }
        }
        if (s.phase === PHASE.INTRO && phaseBefore !== PHASE.INTRO) playCue('round')
        // Combos: a seat's combo is the hits its opponent has taken in a row.
        for (const seat of [0, 1] as const) {
          const victim = s.fighters[(1 - seat) as 0 | 1]!
          const before = comboBefore[(1 - seat) as 0 | 1]
          if (victim.comboCount > 0 && before === 0) l.comboBase[seat] = hpBefore[(1 - seat) as 0 | 1]
          if (victim.comboCount >= 2) {
            l.combos[seat] = { hits: victim.comboCount, damage: Math.max(0, l.comboBase[seat] - Math.max(0, victim.health)) }
            l.comboUntil[seat] = s.frame + COMBO_LINGER
          } else if (l.combos[seat] && s.frame > l.comboUntil[seat]) {
            l.combos[seat] = null
          }
          if (victim.comboCount >= 2) urgent = true
        }
        if (fresh.length > 0) {
          setCallouts((c) => [...c.slice(-2), ...fresh])
          for (const f of fresh) setTimeout(() => setCallouts((c) => c.filter((x) => x.id !== f.id)), CALLOUT_MS)
        }
        if (urgent || s.frame - l.lastHudFrame >= 3) {
          l.lastHudFrame = s.frame
          setHud(hudFrom(s, [l.combos[0], l.combos[1]]))
        }
        if (s.matchOver === 1 && !l.ended) void conclude()
      }

      const tick = (now: number) => {
        if (l.stopped) return
        l.raf = requestAnimationFrame(tick)
        const dt = Math.min(MAX_CATCHUP_SECONDS, Math.max(0, (now - l.last) / 1000))
        l.last = now
        if (!pausedRef.current && !l.ended) {
          const scale = l.slow > 0 ? KO_SLOW_SCALE : 1
          l.acc += dt * 60 * l.params.speed * scale
          let steps = 0
          const cap = MAX_STEPS_PER_TICK * l.params.speed
          while (l.acc >= 1 && steps < cap && !l.ended) {
            // An answer that is due and has not landed holds the step (the worker is quick, so this is a millisecond or two); after
            // MAX_WAIT_MS the match goes on with the input in force and the answer takes effect when it lands.
            if (l.cur.phase === PHASE.FIGHT && l.link.mustWait(l.cur.frame)) {
              if (l.waitSince === 0) l.waitSince = now
              if (now - l.waitSince < MAX_WAIT_MS) break
              l.lateReplies += l.link.giveUp(l.cur.frame)
              if (window.__fighter) window.__fighter.lateReplies = l.lateReplies
            }
            l.waitSince = 0
            l.acc -= 1
            steps++
            if (l.slow > 0) l.slow--
            stepOnce()
          }
          // A long stall must not be replayed as a burst: drop the backlog beyond the cap.
          if (steps >= cap) l.acc = 0
        }
        l.renderer.render(l.prev, l.cur, Math.min(1, l.acc), [])
      }
      l.raf = requestAnimationFrame(tick)
    },
    [teardown, agentVersion],
  )

  const quit = useCallback(() => {
    teardown()
    pausedRef.current = false
    setPaused(false)
    setHud(null)
    setCallouts([])
    setPhase('setup')
  }, [teardown])

  return {
    phase, level, paused, hud, callouts, rendererLabel, preview, failure, finished: recorder.finished, upload: recorder.upload,
    touchAction: (a, down) => { if (!pausedRef.current) { if (down) kb.current.down(`touch:${a}`); else kb.current.up(`touch:${a}`) } },
    unratedReason: recorder.unratedReason, keys, setKeys, start, pause: () => setPause(true), resume: () => setPause(false), quit, pauses,
  }
}

declare global {
  interface Window {
    /** Debug handle for tests and bug reports: the sim frame, how many agent replies were late, and the finished record. */
    __fighter?: { frame: number; lateReplies: number; record: import('@duelwise/core/src/match-record').MatchRecordV1 | null }
  }
}
