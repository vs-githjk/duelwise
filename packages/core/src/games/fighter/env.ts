import { hashState } from '../../hash'
import type { BridgeEnv, EnvFactory } from '../../bridge/env-host'
import { nextSeed } from '../../bridge/env-host'
import { DelayedStates, HumanLimiter, LEVEL_LIMITS, UNLIMITED } from '../../limiter'
import { makeRng } from '../../rng'
import type { Level } from '../../product'
import { agentInputLagFor, MAX_HEALTH } from './constants'
import { buildObs, fighterEncoder, fillObs, FIGHTER_FEATURES, type FighterObs } from './encode'
import { N_BUTTONS, N_DIRS, mirrorDir } from './input'
import { stepPacked } from './core'
import { createBot, FIGHTER_BOT_KINDS, type FighterBot } from './bots'
import { PHASE, copyState, createState, type FighterState } from './state'

// Fighter training env for the bridge (T7).
//
// Decisions: one every FRAME_SKIP (4) sim frames; the chosen input is held for those frames.
// Observations: Float32 [2 seats][OBS_FEATURES]. Each seat sees itself on the left (see encode.ts);
// the last feature is 1 when that view is mirrored. Actions are chosen in that mirrored view, so the
// env mirrors the direction back to the screen direction using the flag of the view the seat saw.
// Actions: Int32 [seat][dir 0..8, button 0..6] (multi-discrete), reward is from seat 0's view.
// Reward per decision: (damage dealt - damage taken) / MAX_HEALTH, plus +1 for each round seat 0
// wins and -1 for each it loses (0 for a drawn round). An episode is one best-of-3 match;
// the env auto-resets with the next seed. Frames outside the FIGHT phase (intro, round end) are
// fast-forwarded inside a step and never produce a decision.
// A seat whose direction is -1, -2 or -3 is played by the scripted bot random, rushdown or turtle
// (FIGHTER_BOT_KINDS order) for that decision; its button is ignored. The league trainer uses this to
// mix bots into its opponent pool per env without a second bridge process. With a level below
// Champion, bots read the same delayFrames-late state an agent gets (R15, fair bots) and the level's
// APM cap and minimum hold filter what they press; at Champion (and with no level) they see the live game.
// With a level, both seats get that level's HumanLimiter: delayed observations (exactly
// delayFrames late), and the APM cap and minimum hold on the input.
// Observation v2 (R15): after the delayed view the seat's OWN input state is appended, undelayed,
// like a human feels their own hands: the held input after the limiter (direction in the seat's view,
// one-hot, then button one-hot), the fraction of APM slots left, frames since the last accepted change
// (scaled), and a flag that the last proposal was refused. Actions: the button head has one extra value,
// KEEP_BUTTON, that holds the current input and costs no APM (releases are free as well, see limiter.ts).

export const FRAME_SKIP = 4
export const ACTION_DIMS = 2
/** The view part of an observation: encoded features plus the mirrored flag. */
export const VIEW_FEATURES = FIGHTER_FEATURES + 1
/** Own-input extras: held direction (9), held button (7), slots left, frames since change, refused. */
export const EXTRA_FEATURES = N_DIRS + N_BUTTONS + 3
export const OBS_FEATURES = VIEW_FEATURES + EXTRA_FEATURES
/** The button value that keeps the held input (free). */
export const KEEP_BUTTON = N_BUTTONS
/** Button head size: the seven buttons plus keep. */
export const BUTTON_HEAD = N_BUTTONS + 1
export const LEVELS: readonly Level[] = ['easy', 'medium', 'hard', 'champion']

/** Writes one seat's view (FIGHTER_FEATURES features plus the mirrored flag) into out[offset..]. */
const scratchObs: FighterObs = buildObs(createState(0), 0)
export function writeSeatView(s: FighterState, seat: 0 | 1, out: Float32Array, offset: number): void {
  fillObs(s, seat, scratchObs)
  fighterEncoder.encode(scratchObs, out, offset)
  out[offset + FIGHTER_FEATURES] = scratchObs.mirrored
}

/** A direction chosen in a view back to the screen direction. */
export function viewDirToScreen(dir: number, mirrored: number): number {
  return mirrored === 1 ? mirrorDir(dir) : dir
}

/**
 * Writes the own-input extras for a seat into out[offset..]. `mirrored` is the flag of the view the
 * seat is shown, so the held direction is in the same frame as the actions it chooses.
 */
export function writeExtras(lim: HumanLimiter, frame: number, mirrored: number, out: Float32Array, offset: number): void {
  const st = lim.status(frame)
  const dir = viewDirToScreen(st.held[0], mirrored)
  for (let d = 0; d < N_DIRS; d++) out[offset + d] = d === dir ? 1 : 0
  for (let b = 0; b < N_BUTTONS; b++) out[offset + N_DIRS + b] = b === st.held[1] ? 1 : 0
  out[offset + N_DIRS + N_BUTTONS] = st.slotsLeft
  out[offset + N_DIRS + N_BUTTONS + 1] = st.sinceChange
  out[offset + N_DIRS + N_BUTTONS + 2] = st.refused
}

interface Seat {
  limiter: HumanLimiter
  mirrored: number
  /** The packed input the seat's agent held at the end of the previous decision: the first `lag` frames of the next block still hold it. */
  prevPacked: number
  bots: Array<FighterBot | undefined>
  botSeed: number
}

class FighterEnv implements BridgeEnv {
  readonly obsShape = [2, OBS_FEATURES]
  readonly actionDims = ACTION_DIMS
  readonly version = 'fighter-env-4'
  private states: FighterState[] = []
  private seeds: number[] = []
  /** Per env: frames an agent's input lags its decision this episode (0 with no level: the unlimited env is the sim's own). */
  private lags: number[] = []
  private anchors: number[] = []
  private seats: Seat[][] = []
  private readonly delay: number
  private readonly tmp = new Float32Array(VIEW_FEATURES)
  /** Per env: recent full states, for bots that must see the delayed view (levels below Champion). */
  private readonly history: Array<DelayedStates<FighterState> | undefined> = []
  private readonly delayBots: boolean
  /** For tests: the frame of the state the bot on [env][seat] saw at its last decision (-1 before any). */
  readonly botViewFrame: Int32Array

  constructor(readonly n: number, private readonly level: Level | undefined) {
    this.delay = level ? LEVEL_LIMITS.fighter[level].delayFrames : 0
    this.delayBots = level !== undefined && level !== 'champion'
    this.botViewFrame = new Int32Array(n * 2).fill(-1)
  }

  private startEpisode(i: number, seed: number): void {
    this.seeds[i] = seed >>> 0
    this.lags[i] = this.level ? agentInputLagFor(seed) : 0
    const s = createState(seed)
    this.states[i] = s
    const seats: Seat[] = []
    for (const k of [0, 1]) {
      const limiter = new HumanLimiter(this.level ? LEVEL_LIMITS.fighter[this.level] : UNLIMITED, makeRng((seed + 7919 * (k + 1)) >>> 0))
      seats.push({ limiter, mirrored: 0, prevPacked: 0, bots: [], botSeed: (seed + 104729 * (k + 1)) >>> 0 })
    }
    this.seats[i] = seats
    this.history[i] = this.delayBots ? new DelayedStates<FighterState>(this.delay, () => createState(0), copyState) : undefined
    // The intro is not a decision.
    this.fastForward(i)
    this.anchorViews(i)
  }

  /**
   * Decisions run on a FRAME_SKIP grid starting at the anchor frame (the first fight frame of a round
   * or episode). History before the anchor is dropped, so a view never shows the previous round; until
   * the delay has elapsed the seat sees the round-start view.
   */
  private anchorViews(i: number): void {
    this.anchors[i] = this.states[i]!.frame
    if (!this.level) return
    for (const seat of this.seats[i]!) seat.limiter.clearViews()
    this.history[i]?.clear()
    this.capture(i, true)
  }

  /** Records the views the limiters will be asked for later. Only frames congruent to -delay mod FRAME_SKIP are needed. */
  private capture(i: number, force: boolean): void {
    if (!this.level) return
    const s = this.states[i]!
    if (!force && (s.frame - this.anchors[i]! + this.delay) % FRAME_SKIP !== 0) return
    for (const k of [0, 1] as const) {
      writeSeatView(s, k, this.tmp, 0)
      this.seats[i]![k]!.limiter.record(this.tmp, s.frame)
    }
    this.history[i]?.record(s.frame, s)
  }

  /** Steps neutral through intro and round-end frames. Returns how many frames it stepped. */
  private fastForward(i: number): number {
    const s = this.states[i]!
    let steps = 0
    while (s.matchOver === 0 && s.phase !== PHASE.FIGHT) {
      stepPacked(s, 0, 0)
      steps++
    }
    return steps
  }

  private writeObs(i: number, out: Float32Array): void {
    const s = this.states[i]!
    for (const k of [0, 1] as const) {
      const base = (i * 2 + k) * OBS_FEATURES
      const seat = this.seats[i]![k]!
      if (this.level) seat.limiter.viewInto(s.frame, out, base)
      else writeSeatView(s, k, out, base)
      seat.mirrored = out[base + FIGHTER_FEATURES]!
      writeExtras(seat.limiter, s.frame, seat.mirrored, out, base + VIEW_FEATURES)
    }
  }

  reset(seeds: number[]): Float32Array {
    if (seeds.length !== this.n) throw new Error(`reset needs ${this.n} seeds, got ${seeds.length}`)
    for (let i = 0; i < this.n; i++) this.startEpisode(i, seeds[i]!)
    const obs = new Float32Array(this.n * 2 * OBS_FEATURES)
    for (let i = 0; i < this.n; i++) this.writeObs(i, obs)
    return obs
  }

  step(actions: Int32Array) {
    if (actions.length !== this.n * 2 * ACTION_DIMS) throw new Error(`step needs ${this.n * 2 * ACTION_DIMS} actions, got ${actions.length}`)
    const obs = new Float32Array(this.n * 2 * OBS_FEATURES)
    const reward = new Float32Array(this.n)
    const done = new Uint8Array(this.n)
    const infos: Array<Record<string, unknown>> = []
    for (let i = 0; i < this.n; i++) {
      const s = this.states[i]!
      const packed = [0, 0]
      /** The input each seat holds for the first `lag` frames of this block (an agent's earlier decision still in force). */
      const lagged = [-1, -1]
      for (const k of [0, 1] as const) {
        let dir = actions[(i * 2 + k) * 2]!
        let btn = actions[(i * 2 + k) * 2 + 1]!
        const seat = this.seats[i]![k]!
        let isBot = false
        if (Number.isInteger(dir) && dir < 0 && dir >= -FIGHTER_BOT_KINDS.length) {
          isBot = true
          const kind = -1 - dir
          const bot = (seat.bots[kind] ??= createBot(FIGHTER_BOT_KINDS[kind]!, seat.botSeed + kind))
          const seen = this.history[i]?.view(s.frame)
          const view = buildObs(seen ? seen.state : s, k)
          this.botViewFrame[i * 2 + k] = seen ? seen.frame : s.frame
          const a = bot.act(view)
          dir = a % N_DIRS
          btn = (a - dir) / N_DIRS
          // The bot answers in its own view; mirror to the screen below like an agent's action.
          seat.mirrored = view.mirrored
        }
        if (!(dir >= 0 && dir < N_DIRS && btn >= 0 && btn < BUTTON_HEAD) || !Number.isInteger(dir) || !Number.isInteger(btn)) {
          throw new RangeError(`fighter env: bad action [${dir}, ${btn}] for env ${i} seat ${k}`)
        }
        // KEEP_BUTTON proposes exactly the held input: free, and never refused.
        const held = seat.limiter.act(btn === KEEP_BUTTON ? seat.limiter.heldInput() : [viewDirToScreen(dir, seat.mirrored), btn], s.frame)
        packed[k] = held[1]! * N_DIRS + held[0]!
        if (!isBot && this.lags[i]! > 0) lagged[k] = seat.prevPacked
        seat.prevPacked = packed[k]!
      }
      let r = 0
      for (let f = 0; f < FRAME_SKIP && s.matchOver === 0; f++) {
        const fighting = s.phase === PHASE.FIGHT
        const h0 = s.fighters[0].health
        const h1 = s.fighters[1].health
        const w0 = s.wins[0]
        const w1 = s.wins[1]
        stepPacked(s, f < this.lags[i]! && lagged[0]! >= 0 ? lagged[0]! : packed[0]!, f < this.lags[i]! && lagged[1]! >= 0 ? lagged[1]! : packed[1]!)
        if (fighting) {
          r += (h1 - Math.max(0, s.fighters[1].health) - (h0 - Math.max(0, s.fighters[0].health))) / MAX_HEALTH
          r += s.wins[0] - w0 - (s.wins[1] - w1)
        }
        this.capture(i, false)
      }
      if (this.fastForward(i) > 0 && s.matchOver === 0) this.anchorViews(i)
      reward[i] = r
      if (s.matchOver === 1) {
        done[i] = 1
        const [a, b] = s.wins
        infos.push({
          env: i, winner: a > b ? 0 : b > a ? 1 : null, score: [a, b], finalHash: hashState(s), seed: this.seeds[i], frames: s.frame,
        })
        this.startEpisode(i, nextSeed(this.seeds[i]!, this.n))
      }
      this.writeObs(i, obs)
    }
    return { obs, reward, done, infos }
  }
}

export const createEnv: EnvFactory | null = ({ n, level }) => {
  if (level !== undefined && !LEVELS.includes(level as Level)) throw new Error(`fighter env: unknown level "${level}"`)
  return new FighterEnv(n, level as Level | undefined)
}
