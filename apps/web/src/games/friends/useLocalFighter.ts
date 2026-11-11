import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_HEALTH } from '@duelwise/core/src/games/fighter/constants'
import { MOVES } from '@duelwise/core/src/games/fighter/moves'
import { copyState, EV, PHASE, type FighterState } from '@duelwise/core/src/games/fighter/state'
import type { Result } from '@duelwise/core/src/types'
import { PadReader } from '../fighter/gamepad'
import type { Callout, HudView } from '../fighter/hud'
import { KeyboardInput, P1_KEYS, P2_KEYS, type Action } from '../fighter/input'
import { DebugRenderer, type StageRenderer } from '../fighter/render/DebugRenderer'
import { ROSTER } from '../fighter/roster'
import { playCue } from '../fighter/sounds'
import { fighterTally, firstSeatPerson, localFighterResult, startLocalFighter, stepLocalFighter } from './local-fighter'
import type { Person } from './local-puck'
import { browserEntropy, normalizeNames, PLAYER_ONE, PLAYER_TWO, type Entropy, type LocalSetup } from './useLocalDuel'

// One Tinderbox sitting for two people on one device: a fixed 60 Hz loop over the real sim, two keyboards' worth of keys (or two
// gamepads, or two touch sets on a tablet), the rematch that swaps sides, and the score of the sitting. Nothing here starts, finishes or
// uploads a match, reads the server or writes storage: a friend game is never rated, never stored and never trained on
// (decisions.md, Nov 9 and Nov 10). Controls belong to the person (player one is always WASD, pad one and the left touch set), the
// fighter's side to the game number.

export type LocalFighterPhase = 'loading' | 'playing' | 'over'

export interface LocalFighterApi {
  host: React.RefObject<HTMLDivElement | null>
  phase: LocalFighterPhase
  paused: boolean
  hud: HudView | null
  callouts: Callout[]
  rendererLabel: 'stage' | 'debug view'
  failure: string | null
  names: [string, string]
  /** Names by fighter seat (0 starts on the left). */
  seatNames: [string, string]
  /** Character names by fighter seat. */
  seatCharacters: [string, string]
  result: Result | null
  tally: { one: number; two: number; draws: number }
  pause: () => void
  resume: () => void
  rematch: () => void
  /** A touch button or stick direction of one person (0 is player one). */
  touchAction: (person: 0 | 1, action: Action, down: boolean) => void
}

export interface LocalFighterParams {
  seed: number | undefined
  /** Starting health for both fighters (tests; needs a fixed seed). */
  hp: number | undefined
  speed: number
  forceDebug: boolean
}

/** Test switches. A fixed `?seed` makes the match a test match; `hp` and `speed` count only then. */
export function readLocalFighterParams(search: string): LocalFighterParams {
  const q = new URLSearchParams(search)
  const raw = q.get('seed')
  const seed = raw !== null && /^\d{1,10}$/.test(raw) && Number(raw) < 2 ** 32 ? Number(raw) : undefined
  const num = (k: string, lo: number, hi: number): number | undefined => {
    const v = q.get(k)
    return v !== null && /^\d{1,5}$/.test(v) ? Math.min(hi, Math.max(lo, Number(v))) : undefined
  }
  return {
    seed,
    hp: seed !== undefined ? num('hp', 1, MAX_HEALTH) : undefined,
    speed: seed !== undefined ? (num('speed', 1, 30) ?? 1) : 1,
    forceDebug: q.get('renderer') === 'debug',
  }
}

declare global {
  interface Window {
    /** Debug handle for the friend page's tests. */
    __friendFighter?: { ready: boolean; frame: number; phase: number; over: boolean; wins: [number, number]; health: [number, number]; x: [number, number]; input: [number, number] }
  }
}

const MAX_CATCHUP_SECONDS = 0.5
const MAX_STEPS_PER_TICK = 30
const KO_SLOW_FRAMES = 45
const KO_SLOW_SCALE = 0.25
const CALLOUT_MS = 900
const COMBO_LINGER = 45

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

const editable = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)

export function useLocalFighter(setup: LocalSetup, entropy: Entropy = browserEntropy): LocalFighterApi {
  const names = useRef<[string, string]>(normalizeNames(setup.names))
  const firstLeft = useRef<Person>(setup.side === 'random' ? (entropy.coin() === 0 ? PLAYER_ONE : PLAYER_TWO) : setup.side === 0 ? PLAYER_ONE : PLAYER_TWO)
  const host = useRef<HTMLDivElement | null>(null)
  const [game, setGame] = useState(0)
  const [phase, setPhase] = useState<LocalFighterPhase>('loading')
  const [paused, setPaused] = useState(false)
  const [hud, setHud] = useState<HudView | null>(null)
  const [callouts, setCallouts] = useState<Callout[]>([])
  const [rendererLabel, setRendererLabel] = useState<'stage' | 'debug view'>('stage')
  const [failure, setFailure] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [finished, setFinished] = useState<Array<{ winner: 0 | 1 | null; bottom: Person }>>([])
  const kbs = useRef<[KeyboardInput, KeyboardInput]>([new KeyboardInput(P1_KEYS), new KeyboardInput(P2_KEYS)])
  const ctl = useRef<{ pause: () => void; resume: () => void } | null>(null)
  const left = firstSeatPerson(firstLeft.current, game)

  // One effect per game: a rematch is a new game number, so the loop, the renderer and the listeners are rebuilt from a new seed.
  useEffect(() => {
    const el = host.current
    if (!el) return
    const params = readLocalFighterParams(window.location.search)
    const seed = game === 0 && params.seed !== undefined ? params.seed : entropy.seed()
    const personAtSeat0 = firstSeatPerson(firstLeft.current, game)
    // Controls follow the person: the keyboard of whoever holds seat 0 drives the fighter on the left.
    const kbOfSeat = (seat: 0 | 1): KeyboardInput => kbs.current[(seat === 0) === (personAtSeat0 === PLAYER_ONE) ? 0 : 1]
    const s = startLocalFighter(seed, game === 0 ? params.hp : undefined)
    const prev = startLocalFighter(seed)
    copyState(prev, s)
    const kb = kbs.current
    const pads = new PadReader()
    let stopped = false
    let ended = false
    let isPaused = false
    let renderer: StageRenderer | null = null
    let ro: ResizeObserver | null = null
    let raf = 0
    let acc = 0
    let last = performance.now()
    let slow = 0
    let wasFighting = false
    let lastHudFrame = -99
    let calloutId = 0
    const comboBase: [number, number] = [MAX_HEALTH, MAX_HEALTH]
    const combos: HudView['combo'] = [null, null]
    const comboUntil: [number, number] = [0, 0]
    let classify: ((p: FighterState, n: FighterState, defender: 0 | 1) => 'counter' | 'punish' | null) | null = null
    const dbg: NonNullable<Window['__friendFighter']> = { ready: false, frame: 0, phase: 0, over: false, wins: [0, 0], health: [0, 0], x: [0, 0], input: [0, 0] }
    window.__friendFighter = dbg
    for (const k of kb) k.blur()
    pads.reset(kb)
    setFailure(null)
    setResult(null)
    setPaused(false)
    setPhase('loading')
    setHud(null)
    setCallouts([])

    const setPause = (on: boolean): void => {
      if (ended || isPaused === on || !dbg.ready) return
      isPaused = on
      setPaused(on)
      if (on) {
        kb.forEach((k) => k.blur())
        pads.reset(kb)
      } else {
        // Whatever was pressed during the pause is forgotten, so a tap made then cannot fire on resume.
        kb.forEach((k) => k.blur())
        pads.reset(kb)
        last = performance.now()
      }
    }
    ctl.current = { pause: () => setPause(true), resume: () => setPause(false) }

    const observe = (phaseBefore: number, hpBefore: [number, number], comboBefore: [number, number]): void => {
      let urgent = s.phase !== phaseBefore
      const fresh: Callout[] = []
      for (const i of [0, 1] as const) {
        const f = s.fighters[i]!
        const ev = f.events
        if (ev === 0) continue
        urgent = true
        const attacker = (1 - i) as 0 | 1
        if (ev & EV.HIT_TAKEN && !(ev & EV.THROWN)) {
          const kind = classify?.(prev, s, i) ?? null
          if (kind) fresh.push({ id: ++calloutId, kind, seat: attacker })
          const heavy = MOVES[s.fighters[attacker]!.moveId]?.damage ?? 0
          playCue(heavy >= 700 ? 'hit-heavy' : 'hit-light')
          if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) navigator.vibrate?.(12)
        }
        if (ev & EV.BLOCKED) playCue('block')
        if (ev & EV.DEFLECTED) fresh.push({ id: ++calloutId, kind: 'deflect', seat: i })
        if (ev & EV.KO) {
          slow = KO_SLOW_FRAMES
          playCue('ko')
        }
      }
      if (s.phase === PHASE.INTRO && phaseBefore !== PHASE.INTRO) playCue('round')
      // Combos: a seat's combo is the hits its opponent has taken in a row.
      for (const seat of [0, 1] as const) {
        const victim = s.fighters[(1 - seat) as 0 | 1]!
        const before = comboBefore[(1 - seat) as 0 | 1]
        if (victim.comboCount > 0 && before === 0) comboBase[seat] = hpBefore[(1 - seat) as 0 | 1]
        if (victim.comboCount >= 2) {
          combos[seat] = { hits: victim.comboCount, damage: Math.max(0, comboBase[seat] - Math.max(0, victim.health)) }
          comboUntil[seat] = s.frame + COMBO_LINGER
        } else if (combos[seat] && s.frame > comboUntil[seat]) {
          combos[seat] = null
        }
        if (victim.comboCount >= 2) urgent = true
      }
      if (fresh.length > 0) {
        setCallouts((c) => [...c.slice(-2), ...fresh])
        for (const f of fresh) setTimeout(() => { if (!stopped) setCallouts((c) => c.filter((x) => x.id !== f.id)) }, CALLOUT_MS)
      }
      if (urgent || s.frame - lastHudFrame >= 3) {
        lastHudFrame = s.frame
        setHud(hudFrom(s, [combos[0], combos[1]]))
      }
      if (s.matchOver === 1 && !ended) conclude()
    }

    const conclude = (): void => {
      ended = true
      const r = localFighterResult(s)!
      setFinished((f) => [...f, { winner: r.winner, bottom: personAtSeat0 }])
      setResult(r)
      setPhase('over')
      setHud(hudFrom(s, [null, null]))
      playCue(r.winner === null ? 'lose' : 'win', 600)
    }

    const stepOnce = (): void => {
      const fighting = s.phase === PHASE.FIGHT
      if (fighting && !wasFighting) playCue('fight')
      wasFighting = fighting
      if (pads.poll(kb)) setPause(true)
      const a = kbOfSeat(0).sample()
      const b = kbOfSeat(1).sample()
      const phaseBefore = s.phase
      const hpBefore: [number, number] = [s.fighters[0].health, s.fighters[1].health]
      const comboBefore: [number, number] = [s.fighters[0].comboCount, s.fighters[1].comboCount]
      copyState(prev, s)
      stepLocalFighter(s, a, b)
      renderer!.onStep(prev, s)
      observe(phaseBefore, hpBefore, comboBefore)
      dbg.frame = s.frame
      dbg.phase = s.phase
      dbg.over = s.matchOver === 1
      dbg.wins = [s.wins[0], s.wins[1]]
      dbg.health = [s.fighters[0].health, s.fighters[1].health]
      dbg.x = [s.fighters[0].pos.x, s.fighters[1].pos.x]
      dbg.input = [a.dir + a.btn * 9, b.dir + b.btn * 9]
    }

    const tick = (now: number): void => {
      if (stopped) return
      raf = requestAnimationFrame(tick)
      const dt = Math.min(MAX_CATCHUP_SECONDS, Math.max(0, (now - last) / 1000))
      last = now
      if (isPaused) {
        // Start on a pad resumes.
        if (pads.poll([])) setPause(false)
      } else if (!ended) {
        acc += dt * 60 * params.speed * (slow > 0 ? KO_SLOW_SCALE : 1)
        let steps = 0
        const cap = MAX_STEPS_PER_TICK * params.speed
        while (acc >= 1 && steps < cap && !ended && !isPaused) {
          acc -= 1
          steps++
          if (slow > 0) slow--
          stepOnce()
        }
        if (steps >= cap) acc = 0
      }
      renderer!.render(prev, s, Math.min(1, acc), [])
    }

    const down = (e: KeyboardEvent): void => {
      if (editable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (P1_KEYS.pause.includes(e.code) || P2_KEYS.pause.includes(e.code)) {
        e.preventDefault()
        if (!e.repeat && !ended) setPause(!isPaused)
        return
      }
      const who = kb[0].actionFor(e.code) ? kb[0] : kb[1].actionFor(e.code) ? kb[1] : null
      if (!who) return
      e.preventDefault()
      if (!isPaused && !ended) who.down(e.code)
    }
    const up = (e: KeyboardEvent): void => {
      for (const k of kb) if (k.actionFor(e.code)) { e.preventDefault(); k.up(e.code) }
    }
    const blur = (): void => kb.forEach((k) => k.blurKeys())
    const hidden = (): void => { if (document.hidden) setPause(true) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', hidden)

    void (async () => {
      if (!params.forceDebug) {
        try {
          const mod = await import('../fighter/render/FighterRenderer')
          if (stopped) return
          const choices: [{ character: number; colorway: number }, { character: number; colorway: number }] =
            personAtSeat0 === PLAYER_ONE ? [{ character: 0, colorway: 0 }, { character: 1, colorway: 0 }] : [{ character: 1, colorway: 0 }, { character: 0, colorway: 0 }]
          const r = new mod.FighterRenderer({ choices })
          try {
            await r.mount(el)
          } catch (e) {
            r.dispose()
            throw e
          }
          if (stopped) {
            r.dispose()
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
        const d = new DebugRenderer()
        await d.mount(el)
        if (stopped) {
          d.dispose()
          return
        }
        renderer = d
      }
      setRendererLabel(renderer.label)
      const r = renderer
      ro = new ResizeObserver(() => r.resize(Math.max(1, el.clientWidth), Math.max(1, el.clientHeight)))
      ro.observe(el)
      r.resize(Math.max(1, el.clientWidth), Math.max(1, el.clientHeight))
      setHud(hudFrom(s, [null, null]))
      setPhase('playing')
      last = performance.now()
      dbg.ready = true
      raf = requestAnimationFrame(tick)
    })().catch((e: unknown) => {
      if (!stopped) setFailure(e instanceof Error ? e.message : 'The stage could not start.')
    })

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      ro?.disconnect()
      renderer?.dispose()
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', hidden)
      kb.forEach((k) => k.blur())
      ctl.current = null
      delete window.__friendFighter
    }
    // The game number is the only thing that restarts the stage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game])

  const pause = useCallback(() => ctl.current?.pause(), [])
  const resume = useCallback(() => ctl.current?.resume(), [])
  const rematch = useCallback(() => setGame((g) => g + 1), [])
  const touchAction = useCallback((person: 0 | 1, action: Action, down: boolean) => {
    const k = kbs.current[person]
    if (down) k.down(`touch:${action}`)
    else k.up(`touch:${action}`)
  }, [])
  const seatNames: [string, string] = left === PLAYER_ONE ? [names.current[0], names.current[1]] : [names.current[1], names.current[0]]
  const seatCharacters: [string, string] = left === PLAYER_ONE ? [ROSTER[0]!.name, ROSTER[1]!.name] : [ROSTER[1]!.name, ROSTER[0]!.name]
  return { host, phase, paused, hud, callouts, rendererLabel, failure, names: names.current, seatNames, seatCharacters, result, tally: fighterTally(finished), pause, resume, rematch, touchAction }
}
