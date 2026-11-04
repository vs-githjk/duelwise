import { useCallback, useEffect, useRef, useState } from 'react'
import { arenaCore, createState, stepPacked } from '@duelwise/core/src/games/arena/core'
import { packInput } from '@duelwise/core/src/games/arena/input'
import { copyState, EV, PHASE, type ArenaState } from '@duelwise/core/src/games/arena/state'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import type { Level } from '@duelwise/core/src/product'
import type { Seat } from '@duelwise/core/src/types'
import { createAgent, type RuntimeAgent } from '@duelwise/agents/src/runtime/agent'
import { agentFrameInput, seatView, viewDue, FRAME_SKIP } from '@duelwise/agents/src/arena/view'
import type { ArenaReply } from '@duelwise/agents/src/arena/agent'
import { play, registerSounds, getVolume, isMuted, subscribeAudio } from '../../lib/audio'
import { playStinger } from '../../lib/music'
import { recordTrainingAllowed } from '../../lib/honest-copy'
import { detectDevice, useMatchRecorder, type FinishedMatch, type Upload } from '../../lib/match-recorder'
import { DebugRenderer, opponentVisible, type StageRenderer } from './render/DebugRenderer'
import { ArenaInputSampler, loadKeyMap, loadSettings, saveKeyMap, saveSettings, type ArenaSettings, type KeyMap } from './input'
import type { DeathLine, FeedRow, HudView, RoundSummary, Stats } from './hud'

// One arena match, from the seed to the replay-checked record.
//
// The sim is a fixed 60 Hz step driven by an accumulator, so a slow display never changes what happens,
// only how smooth it looks. The agent runs in a worker: the loop sends it the frames viewDue() lists and
// never waits; the newest answer is applied when it arrives and the last input repeats until then. What
// the sim was fed each frame (both seats) is what the recorder stores, so the record replays exactly
// however late the worker was. The mouse is captured with the Pointer Lock API; losing the lock pauses.

export type Phase = 'setup' | 'loading' | 'playing' | 'over'

export const HUMAN: Seat = 0
export const AGENT: Seat = 1

export interface StartOptions {
  level: Level
  /** The element the renderer mounts into. */
  host: HTMLElement
  /** The element that takes the pointer lock. */
  stage: HTMLElement
  seed?: number
}

export interface ArenaMatch {
  phase: Phase
  level: Level
  paused: boolean
  /** The mouse is captured by the stage. */
  locked: boolean
  hud: HudView | null
  /** "stage" for the 3D renderer, "debug view" when it fell back to the top-down view. */
  rendererLabel: 'stage' | 'debug view'
  preview: boolean
  failure: string | null
  finished: FinishedMatch | null
  upload: Upload
  unratedReason: string | null
  keys: KeyMap
  setKeys: (k: KeyMap) => void
  settings: ArenaSettings
  setSettings: (s: ArenaSettings) => void
  /** True while the scoreboard key is held. */
  board: boolean
  matchId: string
  seed: number
  start: (o: StartOptions) => Promise<void>
  pause: () => void
  resume: () => void
  /** Captures the mouse (call from a click). */
  capture: () => void
  buy: (choice: 1 | 2 | 3) => void
  /** Leaves the match (it is not counted) and returns to the setup screens. */
  quit: () => void
  pauses: number
  touchAction: (action: import('./input').Action | 'fire', down: boolean) => void
  touchAim: (dx: number, dy: number) => void
}

interface Params {
  speed: number
  agentLagMs: number
  forceDebug: boolean
}

/**
 * Query switches for tests and bug reports. `speed` and `agentlag` are honoured only for an unrated
 * match (one that started from a fixed seed); a counted match always runs at speed 1 with no lag.
 */
export function readParams(search: string, unrated: boolean): Params {
  const q = new URLSearchParams(search)
  const num = (k: string, lo: number, hi: number, d: number) => {
    const raw = q.get(k)
    if (raw === null || !/^\d{1,4}$/.test(raw)) return d
    return Math.min(hi, Math.max(lo, Number(raw)))
  }
  return {
    speed: unrated ? num('speed', 1, 30, 1) : 1,
    agentLagMs: unrated ? num('agentlag', 0, 5000, 0) : 0,
    forceDebug: q.get('renderer') === 'debug',
  }
}

/** A slow display must not slow the match: after a long frame the loop catches up, bounded as in the fighter page. */
const MAX_CATCHUP_SECONDS = 0.5
const MAX_STEPS_PER_TICK = 30
const MAX_INFLIGHT = 12
const FEED_FRAMES = 360

const BASE = '/assets/ui/kenney'
registerSounds({
  'arena-round': `${BASE}/interface-sounds/toggle_002.ogg`,
  'arena-win': `${BASE}/interface-sounds/confirmation_002.ogg`,
  'arena-lose': `${BASE}/interface-sounds/error_004.ogg`,
  'arena-buy': `${BASE}/interface-sounds/tick_002.ogg`,
})
const cue = (name: 'round' | 'win' | 'lose' | 'buy', delayMs = 0): void => {
  if (delayMs > 0) setTimeout(() => play(`arena-${name}`), delayMs)
  else play(`arena-${name}`)
}

import { newSightLog, noteShot, reactionLine, resetSightOnTransition, stepSight, type SightLog } from './reaction'

interface Live {
  prev: ArenaState
  cur: ArenaState
  agent: RuntimeAgent
  renderer: StageRenderer
  debug: DebugRenderer | null
  stage: HTMLElement
  seed: number
  level: Level
  params: Params
  acc: number
  last: number
  raf: number
  anchor: number
  phaseSeen: number
  epoch: number
  agentFirst: number | null
  agentRest: number
  seq: number
  applied: number
  inflight: number
  lateReplies: number
  lastHudFrame: number
  feedId: number
  hitId: number
  dmgId: number
  feed: Array<FeedRow & { until: number }>
  stats: Stats
  history: Array<0 | 1 | null>
  sight: [SightLog, SightLog]
  /** Each seat's first shot of the live round, whether or not it was seen. */
  firstShot: [number | null, number | null]
  line: DeathLine | null
  summary: RoundSummary | null
  hit: HudView['hit']
  hitUntil: number
  damage: HudView['damage']
  damageUntil: number
  ended: boolean
  stopped: boolean
  pauseCount: number
  hadLock: boolean
}

export function useArenaMatch(agentVersion: (level: Level) => string, learnsFromHumans = false): ArenaMatch {
  const recorder = useMatchRecorder('arena')
  const [phase, setPhase] = useState<Phase>('setup')
  const [level, setLevel] = useState<Level>('easy')
  const [paused, setPaused] = useState(false)
  const [locked, setLocked] = useState(false)
  const [board, setBoard] = useState(false)
  const [hud, setHud] = useState<HudView | null>(null)
  const [rendererLabel, setRendererLabel] = useState<'stage' | 'debug view'>('stage')
  const [preview, setPreview] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [keys, setKeysState] = useState<KeyMap>(loadKeyMap)
  const [settings, setSettingsState] = useState<ArenaSettings>(loadSettings)
  const [pauses, setPauses] = useState(0)
  const [ids, setIds] = useState({ matchId: '', seed: 0 })
  const live = useRef<Live | null>(null)
  const pausedRef = useRef(false)
  const sampler = useRef(new ArenaInputSampler(keys, settings))
  const recRef = useRef(recorder)
  recRef.current = recorder

  const setKeys = useCallback((k: KeyMap) => {
    setKeysState(k)
    sampler.current.setMap(k)
    saveKeyMap(k)
  }, [])
  const setSettings = useCallback((s: ArenaSettings) => {
    setSettingsState(s)
    sampler.current.setSettings(s)
    saveSettings(s)
  }, [])

  const gen = useRef(0)

  const teardown = useCallback(() => {
    gen.current++
    const l = live.current
    if (document.pointerLockElement) document.exitPointerLock()
    if (!l) return
    l.stopped = true
    cancelAnimationFrame(l.raf)
    l.agent.dispose()
    l.renderer.dispose()
    live.current = null
    setLocked(false)
    setBoard(false)
    if (typeof window !== 'undefined') delete window.__arena
  }, [])

  useEffect(() => teardown, [teardown])

  // The site's volume and mute reach the 3D scene's own synthesised sound.
  useEffect(() => {
    const sync = () => {
      const r = live.current?.renderer as (StageRenderer & { setVolume?: (v: number) => void; setMuted?: (m: boolean) => void }) | undefined
      r?.setVolume?.(getVolume())
      r?.setMuted?.(isMuted())
    }
    sync()
    return subscribeAudio(sync)
  }, [phase])

  const capture = useCallback(() => {
    const l = live.current
    if (!l || l.ended || pausedRef.current || (typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches)) return
    try {
      const p = l.stage.requestPointerLock() as unknown as Promise<void> | undefined
      p?.catch?.(() => {})
    } catch {
      // some browsers refuse the request right after Esc; the next click works
    }
    l.renderer.unlockAudio?.()
  }, [])

  const setPause = useCallback((on: boolean) => {
    if (pausedRef.current === on) return
    const l = live.current
    if (on && (!l || l.ended)) return
    pausedRef.current = on
    setPaused(on)
    if (on && l) {
      l.pauseCount++
      setPauses(l.pauseCount)
      sampler.current.blur()
      setBoard(false)
      if (document.pointerLockElement) document.exitPointerLock()
    }
    if (!on && l) l.last = performance.now()
  }, [])

  // Keys and mouse while a match is on.
  useEffect(() => {
    if (phase !== 'playing') return
    const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    const buyKey: Record<string, 1 | 2 | 3> = { Digit1: 1, Digit2: 2, Digit3: 3, Numpad1: 1, Numpad2: 2, Numpad3: 3 }
    const down = (e: KeyboardEvent) => {
      if (editable(e.target)) return
      const a = sampler.current.actionFor(e.code)
      if (!a) {
        const b = buyKey[e.code]
        if (b && !e.repeat && !pausedRef.current && live.current?.cur.phase === PHASE.BUY) {
          e.preventDefault()
          sampler.current.queueBuy(b)
          cue('buy')
        }
        return
      }
      e.preventDefault()
      if (a === 'pause') {
        if (!e.repeat) setPause(!pausedRef.current)
        return
      }
      if (pausedRef.current) return
      if (a === 'scoreboard') setBoard(true)
      sampler.current.down(e.code)
    }
    const up = (e: KeyboardEvent) => {
      const a = sampler.current.actionFor(e.code)
      if (a) e.preventDefault()
      if (a === 'scoreboard') setBoard(false)
      sampler.current.up(e.code)
    }
    const isLocked = () => document.pointerLockElement !== null && document.pointerLockElement === live.current?.stage
    const move = (e: MouseEvent) => {
      if (isLocked() && !pausedRef.current) {
        const cur = live.current?.cur
        if (cur) sampler.current.setPitch(cur.players[0].pitch)
        sampler.current.mouseMove(e.movementX, e.movementY)
      }
    }
    const mdown = (e: MouseEvent) => {
      const l = live.current
      if (!l || pausedRef.current || l.ended || (typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches)) return
      if (isLocked()) {
        e.preventDefault()
        sampler.current.mouseDown(e.button)
      } else if (e.button === 0 && e.target instanceof Node && l.stage.contains(e.target) && !(e.target instanceof Element && e.target.closest('[data-no-capture]'))) {
        capture()
      }
    }
    const mup = (e: MouseEvent) => sampler.current.mouseUp(e.button)
    const lockChange = () => {
      const l = live.current
      const on = isLocked()
      setLocked(on)
      if (!l) return
      if (on) l.hadLock = true
      else {
        sampler.current.blur()
        // Esc (or any other way out of the lock) pauses a match that had the mouse.
        if (l.hadLock && !pausedRef.current && !l.ended) setPause(true)
        l.hadLock = false
      }
    }
    const blur = () => (window.matchMedia?.('(pointer: coarse)').matches ? sampler.current.blurKeys() : sampler.current.blur())
    const hidden = () => {
      if (document.hidden) setPause(true)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    document.addEventListener('mousemove', move)
    document.addEventListener('mousedown', mdown)
    document.addEventListener('mouseup', mup)
    document.addEventListener('pointerlockchange', lockChange)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mousedown', mdown)
      document.removeEventListener('mouseup', mup)
      document.removeEventListener('pointerlockchange', lockChange)
      document.removeEventListener('visibilitychange', hidden)
      sampler.current.blur()
    }
  }, [phase, setPause, capture])

  const start = useCallback(
    async (o: StartOptions) => {
      teardown()
      const my = gen.current
      const stale = () => gen.current !== my
      setFailure(null)
      setPhase('loading')
      setLevel(o.level)
      setHud(null)
      setPauses(0)
      setBoard(false)
      pausedRef.current = false
      setPaused(false)
      sampler.current.blur()
      // A counted match takes its seed from the server; a fixed ?seed makes an unrated match.
      const seed = (await recRef.current.begin(o.level, o.seed)).seed
      // Decided from the session that actually started, not from the URL.
      const params = readParams(window.location.search, o.seed !== undefined)
      if (stale()) return

      let agent: RuntimeAgent
      try {
        agent = await createAgent('arena', o.level, { seat: AGENT })
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
      let debug: DebugRenderer | null = null
      if (!params.forceDebug) {
        try {
          const mod = await import('./render/ArenaRenderer')
          if (stale()) {
            agent.dispose()
            return
          }
          const r = new mod.ArenaRenderer({ seat: HUMAN, audio: true })
          try {
            await r.mount(o.host)
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
            render: (p, n, a) => r.render(p, n, a),
            setPendingTurn: (t) => r.setPendingTurn(t),
            resize: (w, h) => r.resize(w, h),
            unlockAudio: () => r.unlockAudio(),
            dispose: () => r.dispose(),
            ...({ setVolume: (v: number) => r.setVolume(v), setMuted: (m: boolean) => r.setMuted(m) } as object),
          }
        } catch (e) {
          console.warn('arena: 3D scene unavailable, using the debug view', e)
          renderer = null
        }
      }
      if (!renderer) {
        debug = new DebugRenderer()
        renderer = debug
        await renderer.mount(o.host)
        if (stale()) {
          renderer.dispose()
          agent.dispose()
          return
        }
      }
      setRendererLabel(renderer.label)
      const ro = new ResizeObserver(() => renderer!.resize(Math.max(1, o.host.clientWidth), Math.max(1, o.host.clientHeight)))
      ro.observe(o.host)
      const baseDispose = renderer.dispose.bind(renderer)
      renderer.dispose = () => {
        ro.disconnect()
        baseDispose()
      }

      const cur = createState(seed)
      const prev = createState(seed)
      copyState(prev, cur)
      const sightLog = newSightLog
      const l: Live = {
        prev, cur, agent, renderer, debug, stage: o.stage, seed, level: o.level, params, acc: 0, last: performance.now(), raf: 0,
        anchor: cur.frame, phaseSeen: cur.phase, epoch: 0, agentFirst: null, agentRest: 0, seq: 0, applied: 0, inflight: 0, lateReplies: 0,
        lastHudFrame: -99, feedId: 0, hitId: 0, dmgId: 0, feed: [],
        stats: { kills: [0, 0], deaths: [0, 0], headshots: [0, 0], damage: [0, 0] }, history: [], sight: [sightLog(), sightLog()], firstShot: [null, null],
        line: null, summary: null, hit: null, hitUntil: 0, damage: null, damageUntil: 0, ended: false, stopped: false, pauseCount: 0, hadLock: false,
      }
      live.current = l
      window.__arena = {
        frame: 0, lateReplies: 0, record: null, yaw: 0, pitch: 0, phase: cur.phase, round: cur.round, money: cur.players[0].money,
        weapon: cur.players[0].weapon, opponentDrawn: false, opponentVisible: false, x: 0, y: 0,
      }
      setIds({ matchId: '', seed })

      recRef.current.start({
        seed,
        humanSeat: HUMAN,
        agent: { version: agentVersion(o.level), level: o.level },
        trainingAllowed: recordTrainingAllowed('arena', { learnsFromHumans }),
        input: detectDevice() === 'desktop' ? 'mouse' : 'touch',
      })
      sampler.current.blur()
      setHud(hudFrom(l))
      setPhase('playing')

      const limits = LEVEL_LIMITS.arena[o.level]

      const schedule = () => {
        const due = viewDue(l.cur.frame, l.anchor, limits.delayFrames, l.cur.phase)
        if (!due.capture && !due.decide) return
        if (l.inflight >= MAX_INFLIGHT) return
        const issued = l.cur.frame
        const epoch = l.epoch
        const seq = ++l.seq
        l.inflight++
        l.agent
          .act(seatView(l.cur, AGENT), { frame: issued, anchor: l.anchor, phase: l.cur.phase, weapon: l.cur.players[AGENT].weapon })
          .then((a) => {
            const deliver = () => {
              // A reply from an earlier phase would carry an old input into the new one.
              if (l.stopped || seq < l.applied || epoch !== l.epoch) return
              const r = a as ArenaReply
              if (r[2] !== 1) return
              l.applied = seq
              l.agentFirst = r[0]
              l.agentRest = r[1]
              if (l.cur.frame - issued > FRAME_SKIP) {
                l.lateReplies++
                if (window.__arena) window.__arena.lateReplies = l.lateReplies
              }
            }
            l.inflight--
            if (l.params.agentLagMs > 0) setTimeout(deliver, l.params.agentLagMs)
            else deliver()
          })
          .catch((e: unknown) => {
            l.inflight--
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
        if (document.pointerLockElement) document.exitPointerLock()
        try {
          const out = await recRef.current.finish(arenaCore, l.cur)
          if (window.__arena) window.__arena.record = out.record
          setIds({ matchId: out.record.matchId, seed })
          const r = out.record.result
          // The match result: the shared stinger. (The round cues below stay as they are.)
          playStinger(r.winner === HUMAN ? 'win' : 'loss', 600)
        } catch (e) {
          setFailure(e instanceof Error ? e.message : 'The match record could not be made.')
        }
        setPhase('over')
        setHud(hudFrom(l))
      }

      const stepOnce = () => {
        const s = l.cur
        if (s.phase !== l.phaseSeen) {
          l.phaseSeen = s.phase
          l.anchor = s.frame
          l.epoch++
          l.agentFirst = null
          l.agentRest = 0
          if (s.phase === PHASE.BUY && s.round > 1) cue('round')
        }
        if (s.phase !== PHASE.ROUND_END) schedule()
        sampler.current.setPitch(s.players[0].pitch)
        const mine = sampler.current.sample()
        const roundEnd = s.phase === PHASE.ROUND_END
        const p0 = roundEnd ? 0 : packInput(s.phase === PHASE.BUY ? mine : mine)
        const held = { first: l.agentFirst, rest: l.agentRest }
        const p1 = agentFrameInput(s.frame, l.anchor, s.phase, held)
        l.agentFirst = held.first
        recRef.current.act(s.frame, HUMAN, p0)
        recRef.current.act(s.frame, AGENT, p1)
        copyState(l.prev, s)
        stepPacked(s, p0, p1)
        l.renderer.onStep(l.prev, s)
        observe()
        const w = window.__arena
        if (w) {
          const me = s.players[0]
          w.frame = s.frame
          w.yaw = me.yaw
          w.pitch = me.pitch
          w.x = me.x
          w.y = me.y
          w.phase = s.phase
          w.round = s.round
          w.money = me.money
          w.weapon = me.weapon
          w.opponentVisible = opponentVisible(s, 0)
        }
      }

      // Everything the HUD, the scoreboard and the round summary derive from one sim step.
      const observe = () => {
        const s = l.cur
        const p = l.prev
        let urgent = s.phase !== p.phase
        // Sight and first shots (for the reaction line): a seat's window starts when it first sees the other.
        if (s.phase === PHASE.LIVE) {
          for (const i of [0, 1] as const) if (opponentVisible(s, i)) l.sight[i] = stepSight(l.sight[i], true, true, s.frame)
        } else if (resetSightOnTransition(p.phase, s.phase)) {
          l.sight[0] = sightLog()
          l.sight[1] = sightLog()
          l.firstShot = [null, null]
          l.line = null
        }
        for (const i of [0, 1] as const) {
          const me = s.players[i]
          const ev = me.events
          if (ev === 0) continue
          urgent = true
          const other = s.players[1 - i]!
          if (ev & EV.FIRED) {
            if (l.firstShot[i] === null) l.firstShot[i] = s.frame
            for (const w of [0, 1] as const) noteShot(l.sight[w], i, s.frame)
          }
          if (ev & EV.HIT_DEALT) {
            const before = p.players[1 - i]!
            l.stats.damage[i] += Math.max(0, before.health - other.health)
            if (i === HUMAN) {
              l.hit = { id: ++l.hitId, kind: ev & EV.KILL ? 'kill' : ev & EV.HEADSHOT ? 'head' : 'hit' }
              l.hitUntil = s.frame + 15
              if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) navigator.vibrate?.(12)
            }
          }
          if (ev & EV.HIT_TAKEN && i === HUMAN) {
            const a = Math.atan2(other.y - me.y, other.x - me.x)
            const yaw = (me.yaw / 8192) * Math.PI * 2
            let d = yaw - a
            d = Math.atan2(Math.sin(d), Math.cos(d))
            l.damage = { id: ++l.dmgId, angle: d }
            l.damageUntil = s.frame + 60
          }
          if (ev & EV.KILL) {
            l.stats.kills[i]++
            if (ev & EV.HEADSHOT) l.stats.headshots[i]++
            l.feed.push({ id: ++l.feedId, killer: i, victim: (1 - i) as 0 | 1, weapon: me.weapon, headshot: (ev & EV.HEADSHOT) !== 0, until: s.frame + FEED_FRAMES })
            // The line for the summary: the exchange as the killer's seat saw it, from the first sight to each seat's first shot.
            l.line = reactionLine(l.sight[i]!, l.firstShot, s.frame, Math.round((limits.delayFrames * 1000) / 60), i === AGENT)
          }
          if (ev & EV.DIED) l.stats.deaths[i]++
        }
        if (s.phase === PHASE.LIVE) {
          for (const i of [0, 1] as const) {
            if (!opponentVisible(s, i)) l.sight[i] = stepSight(l.sight[i], false, s.players[i].alive === 1 && s.players[1 - i]!.alive === 1, s.frame)
          }
        }
        if (s.phase === PHASE.ROUND_END && p.phase !== PHASE.ROUND_END) {
          const winner: 0 | 1 | null = s.wins[0] > p.wins[0] ? 0 : s.wins[1] > p.wins[1] ? 1 : null
          l.history.push(winner)
          l.summary = {
            round: s.round, winner, reason: s.lastReason,
            money: [Math.max(0, s.players[0].money - p.players[0].money), Math.max(0, s.players[1].money - p.players[1].money)],
            line: s.lastReason === 1 ? l.line : null,
          }
          cue(winner === 0 ? 'win' : 'lose')
        }
        if (s.phase !== PHASE.ROUND_END) l.summary = null
        if (l.hit && s.frame > l.hitUntil) l.hit = null
        if (l.damage && s.frame > l.damageUntil) l.damage = null
        const live = l.feed.length
        l.feed = l.feed.filter((f) => f.until > s.frame).slice(-4)
        if (l.feed.length !== live) urgent = true
        if (urgent || s.frame - l.lastHudFrame >= 3) {
          l.lastHudFrame = s.frame
          setHud(hudFrom(l))
        }
        if (s.matchOver === 1 && !l.ended) void conclude()
      }

      const tick = (now: number) => {
        if (l.stopped) return
        l.raf = requestAnimationFrame(tick)
        const dt = Math.min(MAX_CATCHUP_SECONDS, Math.max(0, (now - l.last) / 1000))
        l.last = now
        if (!pausedRef.current && !l.ended) {
          l.acc += dt * 60 * l.params.speed
          let steps = 0
          const cap = MAX_STEPS_PER_TICK * l.params.speed
          while (l.acc >= 1 && steps < cap && !l.ended) {
            l.acc -= 1
            steps++
            stepOnce()
          }
          // A long stall must not be replayed as a burst: drop the backlog beyond the cap.
          if (steps >= cap) l.acc = 0
        }
        l.renderer.setPendingTurn?.(pausedRef.current || l.ended ? null : sampler.current.pendingTurn())
        l.renderer.render(l.prev, l.cur, Math.min(1, l.acc))
        if (window.__arena && l.debug) window.__arena.opponentDrawn = l.debug.opponentDrawn
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
    setPhase('setup')
  }, [teardown])

  const buy = useCallback((choice: 1 | 2 | 3) => {
    if (pausedRef.current || live.current?.cur.phase !== PHASE.BUY) return
    sampler.current.queueBuy(choice)
    cue('buy')
  }, [])

  return {
    phase, level, paused, locked, hud, rendererLabel, preview, failure, finished: recorder.finished, upload: recorder.upload,
    touchAction: (a, down) => {
      if (pausedRef.current) return
      if (a === 'fire') { if (down) sampler.current.mouseDown(0); else sampler.current.mouseUp(0) }
      else { if (a === 'scoreboard') setBoard(down); if (down) sampler.current.down(`touch:${a}`); else sampler.current.up(`touch:${a}`) }
    },
    touchAim: (dx, dy) => { if (!pausedRef.current) { const cur = live.current?.cur; if (cur) sampler.current.setPitch(cur.players[0].pitch); sampler.current.mouseMove(dx * 8, dy * 8) } },
    unratedReason: recorder.unratedReason, keys, setKeys, settings, setSettings, board, matchId: ids.matchId, seed: ids.seed, start,
    pause: () => setPause(true), resume: () => setPause(false), capture, buy, quit, pauses,
  }
}

function hudFrom(l: Live): HudView {
  const s = l.cur
  const me = s.players[0]
  const op = s.players[1]
  return {
    frame: s.frame, phase: s.phase, phaseFrame: s.phaseFrame, buyFrames: s.buyFrames, round: s.round, timer: s.timer,
    wins: [s.wins[0], s.wins[1]], health: me.health, armor: me.armor, money: me.money, aiMoney: op.money, weapon: me.weapon, ammo: me.ammo, reload: me.reload,
    alive: me.alive === 1, mapIdx: s.mapIdx, you: { x: me.x, y: me.y, yaw: me.yaw },
    // The opponent's true position only while this seat sees it.
    opp: opponentVisible(s, 0) ? { x: op.x, y: op.y } : null,
    hit: l.hit, damage: l.damage, feed: l.feed.map(({ until: _u, ...f }) => f), stats: { kills: [...l.stats.kills], deaths: [...l.stats.deaths], headshots: [...l.stats.headshots], damage: [...l.stats.damage] } as Stats,
    history: [...l.history], summary: l.summary,
  }
}

declare global {
  interface Window {
    /** Debug handle for tests and bug reports: sim frame, late agent replies, the human seat's pose, and the finished record. */
    __arena?: {
      frame: number
      lateReplies: number
      record: import('@duelwise/core/src/match-record').MatchRecordV1 | null
      yaw: number
      pitch: number
      x: number
      y: number
      phase: number
      round: number
      money: number
      weapon: number
      /** Debug view only: whether the last frame drew the opponent. */
      opponentDrawn: boolean
      /** Whether the sim says the human seat sees the opponent right now. */
      opponentVisible: boolean
    }
  }
}
