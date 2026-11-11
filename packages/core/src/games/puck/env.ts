import { hashState } from '../../hash'
import type { BridgeEnv, EnvFactory } from '../../bridge/env-host'
import { nextSeed } from '../../bridge/env-host'
import { DelayedStates, LEVEL_LIMITS } from '../../limiter'
import type { Level } from '../../product'
import { ALL_BOT_KINDS, createBot, type PuckBot, type PuckBotKind } from './bots'
import { DEFAULT_ACCEL, END, LEVEL_MALLET, NO_INPUT, PHASE, RULE_MALLET_SPEED, type MalletLimits } from './constants'
import { observe, stepState } from './core'
import { BIN_X, BIN_Y, FRAME_SKIP, OBS_FEATURES, OWN_FEATURES, VIEW_FEATURES, binX, binY, writeOwn, writeSeatView } from './encode'
import { PEOPLE_BOT_KINDS, PEOPLE_PROFILES, SeatHands, botDelayFor, botHistory, peopleHands, type PeopleProfile } from './seat-hands'
import { blankState, copyState, createState, type PuckState } from './state'

// Air hockey training env for the bridge (P3).
//
// Decisions: one every FRAME_SKIP (2) sim frames, 30 a second; the chosen target is held for those frames.
// Actions: Int32 [seat][x bin 0..10, y bin 0..8] over the seat's own half (nvec 11, 9). A seat whose x head is
// People bots (Nov 10 retune): a sentinel of -1 - (16 * (profile + 1) + kind) plays PEOPLE_BOT_KINDS[kind] with a person's hands
// (seat-hands.ts PEOPLE_PROFILES: the rule mallet, that profile's reaction delay, hand noise and hold) instead of the level's.
// The seat takes them at its first decision of the episode. Plain sentinels (below 16) are untouched.
// -1 - index plays that scripted bot for the decision (PUCK_BOT_KINDS order, then pip); its y head is ignored.
// Observations: Float32 [2 seats][OBS_FEATURES], each seat in its own view (it defends y = 0). With a level,
// the puck, the other mallet and the match numbers are exactly the level's delayFrames late and the seat's own
// mallet and held target are live, like a hand feels itself. With no level nothing is delayed and the mallets
// run at the rule speed with no target noise.
// Hands: the level's mallet speed and acceleration go into the sim (createState limits), the target gets the
// level's gaussian-like noise from the env rng, and a new target is refused for minHoldFrames after the last one.
// Bots below Champion read the same delayed state an agent gets (R15, fair bots); at Champion (and with no
// level) they see the live game unless the option championBotDelay (frames) gives them a reaction time. Both go through the same noise and hold, so a bot is not handed better hands.
// Reward per decision from seat 0: +1 per goal for, -1 per goal against, -0.5 per foul conceded (a 7 second
// possession foul); the training option goalShaping adds that much per decision while seat 0 touched last and the live puck heads for the far goal. Episodes end at first to 7 or at the training cap (7,200 frames, the leader wins), and the
// env auto-resets with the next seed.

export { BIN_X, BIN_Y, FRAME_SKIP, OBS_FEATURES, OWN_FEATURES, VIEW_FEATURES, writeSeatView }
export const ACTION_DIMS = 2
export const PUCK_BOT_KINDS = ['random', 'striker', 'goalie', 'banker', 'shadow'] as const
export const TRAIN_CAP_FRAMES = 7_200
export const LEVELS: readonly Level[] = ['easy', 'medium', 'hard', 'champion']
const FOUL = 5
const GOAL = 0

export interface PuckEnv extends BridgeEnv {
  /** Test hook: called with the state after each sim frame, and once for the new episode's frame 0. */
  onFrame?: (env: number, s: PuckState) => void
  /** For tests: the frame of the state the bot on [env][seat] saw at its last decision (-1 before any). */
  readonly botViewFrame: Int32Array
  stateOf(i: number): PuckState
  hashOf(i: number): string
}

class Env implements PuckEnv {
  readonly obsShape = [2, OBS_FEATURES]
  readonly actionDims = ACTION_DIMS
  readonly version = 'puck-env-2'
  onFrame?: (env: number, s: PuckState) => void
  readonly botViewFrame: Int32Array
  private readonly states: PuckState[] = []
  private readonly seeds: number[] = []
  private readonly seats: SeatHands[][] = []
  private readonly history: Array<DelayedStates<PuckState> | undefined> = []
  /** Seats a people sentinel has taken over this episode, by env * 2 + seat: the bot, its view history and its reaction delay. */
  private readonly people: Array<{ bot: PuckBot; hist: DelayedStates<PuckState>; delay: number } | undefined> = []
  private readonly delay: number
  /** Frames a bot's view lags: the level's delay below Champion, 0 at Champion and with no level unless the option says otherwise. */
  private readonly botDelay: number
  private readonly limits: [MalletLimits, MalletLimits] | null
  private readonly tmp = new Float32Array(VIEW_FEATURES)
  private readonly inputs: [number, number] = [NO_INPUT, NO_INPUT]

  constructor(readonly n: number, private readonly level: Level | undefined, private readonly trainCap: number, championBotDelay: number, private readonly goalShaping = 0) {
    this.delay = level ? LEVEL_LIMITS.puck[level].delayFrames : 0
    this.botDelay = botDelayFor(level, championBotDelay)
    this.limits = level ? [LEVEL_MALLET[level], LEVEL_MALLET[level]] : null
    this.botViewFrame = new Int32Array(n * 2).fill(-1)
  }

  stateOf(i: number): PuckState {
    return this.states[i]!
  }

  hashOf(i: number): string {
    return hashState(this.states[i]!)
  }

  private startEpisode(i: number, seed: number): void {
    this.seeds[i] = seed >>> 0
    const s = createState(seed, this.limits ? { limits: this.limits } : undefined)
    this.states[i] = s
    this.seats[i] = [new SeatHands(seed, 0, this.level), new SeatHands(seed, 1, this.level)]
    this.history[i] = botHistory(this.botDelay)
    this.people[i * 2] = this.people[i * 2 + 1] = undefined
    this.capture(i, true)
    this.onFrame?.(i, s)
  }

  /** Records the views the limiters and bots are asked for later: only frames congruent to -delay mod FRAME_SKIP are read. */
  private capture(i: number, force: boolean): void {
    if (!this.level) return
    const s = this.states[i]!
    if (force || (s.frame + this.delay) % FRAME_SKIP === 0) {
      for (const k of [0, 1] as const) {
        writeSeatView(s, k, this.tmp, 0)
        this.seats[i]![k]!.limiter.record(this.tmp, s.frame)
      }
    }
    if (force || (s.frame + this.botDelay) % FRAME_SKIP === 0) this.history[i]?.record(s.frame, s)
    for (const k of [0, 1] as const) {
      const p = this.people[i * 2 + k]
      if (p && (force || (s.frame + p.delay) % FRAME_SKIP === 0)) p.hist.record(s.frame, s)
    }
  }

  private writeObs(i: number, out: Float32Array): void {
    const s = this.states[i]!
    for (const k of [0, 1] as const) {
      const base = (i * 2 + k) * OBS_FEATURES
      const seat = this.seats[i]![k]!
      if (this.level) seat.limiter.viewInto(s.frame, out, base)
      else writeSeatView(s, k, out, base)
      const st = seat.limiter.status(s.frame)
      writeOwn(s, k, st.sinceChange, st.refused, out, base + VIEW_FEATURES)
    }
  }

  reset(seeds: number[]): Float32Array {
    if (seeds.length !== this.n) throw new Error(`reset needs ${this.n} seeds, got ${seeds.length}`)
    for (let i = 0; i < this.n; i++) this.startEpisode(i, seeds[i]!)
    const obs = new Float32Array(this.n * 2 * OBS_FEATURES)
    for (let i = 0; i < this.n; i++) this.writeObs(i, obs)
    return obs
  }

  /** Hands the seat to a scripted bot on a people profile: the rule mallet, the profile's noise and hold, its own delayed view. */
  private takeOver(i: number, k: 0 | 1, profile: PeopleProfile, kind: (typeof PEOPLE_BOT_KINDS)[number], s: PuckState) {
    const hands = peopleHands(profile)
    const seed = this.seeds[i]!
    const seat = this.seats[i]![k]!
    seat.usePeopleHands(profile, seed)
    if (this.level) {
      writeSeatView(s, k, this.tmp, 0)
      seat.limiter.record(this.tmp, s.frame)
    }
    s.m[k]!.speed = RULE_MALLET_SPEED
    s.m[k]!.accel = DEFAULT_ACCEL
    const hist = new DelayedStates<PuckState>(hands.delayFrames, blankState, copyState)
    hist.record(s.frame, s)
    const p = { bot: createBot(kind, seat.botSeed + 31), hist, delay: hands.delayFrames }
    this.people[i * 2 + k] = p
    return p
  }

  /** The target a seat proposes this decision, in its own half (0..1 each axis), from an action or a bot. */
  private propose(i: number, k: 0 | 1, ax: number, ay: number, s: PuckState): [number, number] {
    const seat = this.seats[i]![k]!
    let ux: number
    let uy: number
    if (Number.isInteger(ax) && ax < 0 && -1 - ax >= 16) {
      const code = -1 - ax
      const profile = PEOPLE_PROFILES[(code >> 4) - 1]
      const kind = PEOPLE_BOT_KINDS[code & 15]
      if (profile === undefined || kind === undefined) throw new RangeError(`puck env: bad people sentinel ${ax} for env ${i} seat ${k}`)
      const p = this.people[i * 2 + k] ?? this.takeOver(i, k, profile, kind, s)
      const seen = p.hist.view(s.frame)
      const view = observe(seen.state, k)
      view.me = observe(s, k).me
      this.botViewFrame[i * 2 + k] = seen.frame
      const t = p.bot.act(view)
      ux = t[0]
      uy = t[1]
    } else if (Number.isInteger(ax) && ax < 0) {
      const kind = -1 - ax
      if (kind >= ALL_BOT_KINDS.length) throw new RangeError(`puck env: bad bot sentinel ${ax} for env ${i} seat ${k}`)
      const bot = seat.botAt(kind)
      const seen = this.history[i]?.view(s.frame)
      const view = observe(seen ? seen.state : s, k)
      if (seen) view.me = observe(s, k).me
      this.botViewFrame[i * 2 + k] = seen ? seen.frame : s.frame
      const t = bot.act(view)
      ux = t[0]
      uy = t[1]
    } else {
      if (!Number.isInteger(ax) || !Number.isInteger(ay) || ax >= BIN_X || ay < 0 || ay >= BIN_Y) {
        throw new RangeError(`puck env: bad action [${ax}, ${ay}] for env ${i} seat ${k}`)
      }
      ux = binX(ax)
      uy = binY(ay)
    }
    return [ux, uy]
  }

  step(actions: Int32Array) {
    if (actions.length !== this.n * 2 * ACTION_DIMS) throw new Error(`step needs ${this.n * 2 * ACTION_DIMS} actions, got ${actions.length}`)
    const obs = new Float32Array(this.n * 2 * OBS_FEATURES)
    const reward = new Float32Array(this.n)
    const done = new Uint8Array(this.n)
    const infos: Array<Record<string, unknown>> = []
    for (let i = 0; i < this.n; i++) {
      const s = this.states[i]!
      for (const k of [0, 1] as const) {
        const [ux, uy] = this.propose(i, k, actions[(i * 2 + k) * 2]!, actions[(i * 2 + k) * 2 + 1]!, s)
        this.inputs[k] = this.seats[i]![k]!.act(ux, uy, s.frame)
      }
      const g0 = s.stats[GOAL]!
      const g1 = s.stats[6 + GOAL]!
      const f0 = s.stats[FOUL]!
      for (let f = 0; f < FRAME_SKIP && s.matchOver === 0 && s.frame < this.trainCap; f++) {
        stepState(s, this.inputs)
        this.capture(i, false)
        this.onFrame?.(i, s)
      }
      reward[i] = s.stats[GOAL]! - g0 - (s.stats[6 + GOAL]! - g1) - 0.5 * (s.stats[FOUL]! - f0)
      // Training-only shaping (option goalShaping): seat 0 touched the puck last and it is live and heading for seat 1's goal (y = TABLE_L).
      if (this.goalShaping !== 0 && s.phase === PHASE.LIVE && s.lastTouch === 0 && s.pvy > 0) reward[i] += this.goalShaping
      const capped = s.matchOver === 0 && s.frame >= this.trainCap
      if (s.matchOver === 1 || capped) {
        done[i] = 1
        const a = s.score[0]
        const b = s.score[1]
        const reason = capped ? 'cap' : s.endReason === END.GOALS ? 'goals' : s.endReason === END.TIME ? 'time' : s.endReason === END.SUDDEN ? 'sudden' : 'draw'
        infos.push({
          env: i,
          winner: capped ? (a > b ? 0 : b > a ? 1 : null) : s.winner === 0 ? 0 : s.winner === 1 ? 1 : null,
          score: [a, b],
          fouls: [s.stats[FOUL]!, s.stats[6 + FOUL]!],
          reason,
          finalHash: hashState(s),
          seed: this.seeds[i],
          frames: s.frame,
        })
        this.startEpisode(i, nextSeed(this.seeds[i]!, this.n))
      }
      this.writeObs(i, obs)
    }
    return { obs, reward, done, infos }
  }
}

export const createEnv: EnvFactory | null = (opts) => {
  const { n, level } = opts
  if (level !== undefined && !LEVELS.includes(level as Level)) throw new Error(`puck env: unknown level "${level}"`)
  const o = opts as { trainCapFrames?: number; championBotDelay?: number; goalShaping?: number }
  return new Env(n, level as Level | undefined, o.trainCapFrames ?? TRAIN_CAP_FRAMES, o.championBotDelay ?? 0, o.goalShaping ?? 0)
}

export interface BotMatch {
  winner: 0 | 1 | null
  score: [number, number]
  frames: number
  reason: string
  hash: string
}

/** One full match between two bots (seat 0 plays a, seat 1 plays b) through the env, so it uses exactly the hands an agent gets. */
export function playBotMatch(seed: number, a: PuckBotKind, b: PuckBotKind, level?: Level, championBotDelay = 0): BotMatch {
  const env = createEnv!({ n: 1, seed, level, trainCapFrames: 36_000, championBotDelay } as never) as PuckEnv
  env.reset([seed])
  const act = new Int32Array([-1 - ALL_BOT_KINDS.indexOf(a), 0, -1 - ALL_BOT_KINDS.indexOf(b), 0])
  for (let d = 0; d < 40_000; d++) {
    const out = env.step(act)
    if (out.done[0]) {
      const info = out.infos[0] as { winner: 0 | 1 | null; score: [number, number]; frames: number; reason: string; finalHash: string }
      return { winner: info.winner, score: info.score, frames: info.frames, reason: info.reason, hash: info.finalHash }
    }
  }
  throw new Error('playBotMatch: no end')
}
