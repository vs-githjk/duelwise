import { hashState } from '../../hash'
import type { BridgeEnv, EnvFactory } from '../../bridge/env-host'
import { nextSeed } from '../../bridge/env-host'
import { DelayedStates, HumanLimiter, LEVEL_LIMITS, UNLIMITED } from '../../limiter'
import { makeRng } from '../../rng'
import type { Level } from '../../product'
import { ACTION_DIMS, ARENA_BOT_SENTINEL_BASE, KEEP_MOVE, badHead, headsFromInput, inputFromHeads } from './actions'
import { ARENA_BOT_KINDS, HUMAN_PROXY_LIMITS, createBot, withMistakes, type ArenaBot } from './bots'
import { ARENA_PEOPLE_LIMITS, decodePeopleSentinel, PEOPLE_DELAY_FRAMES, PEOPLE_MISTAKE_RATE, type PeopleProfile } from '../../people-hands'
import { stepPacked, createState } from './core'
import { MAX_HEALTH } from './economy'
import { ARENA_FEATURES, buildObs, encodeState, type ArenaObs } from './encode'
import { N_MOVES, N_BUYS, PITCH_MAX_DELTA, YAW_MAX, packInput, type ArenaInput } from './input'
import { MAP_LIST, type MapData } from './map'
import { H_STAND, HULL_HALF, STEP_HEIGHT, groundHeight } from './movement'
import { segmentBlocked } from './raycast'
import { PHASE, copyState, blankState, type ArenaState } from './state'
import { WEAPONS } from './weapons'
import { cosU, sinU } from './trig'

// Arena training env for the bridge (T10).
//
// Decisions: one every FRAME_SKIP (4) sim frames; the chosen input is held for those frames.
// Observations: Float32 [2 seats][ARENA_FEATURES], each seat's own view (the encoding is relative to
// the seat, so there is no mirroring). Actions: Int32 [seat][ACTION_DIMS] multi-discrete heads (see
// actions.ts). Reward is from seat 0's view: (damage dealt - damage taken) / MAX_HEALTH per decision,
// plus +1 for each round seat 0 wins and -1 for each it loses (0 for a drawn round), plus a small
// potential-based aiming term (see aimPotential): a policy that has never landed a shot still gets a
// gradient toward finding the opponent and putting the crosshair on it. An episode is one match; the
// env auto-resets with the next seed.
//
// Trigger: a semi-automatic weapon (the dart pistol) fires on the first frame of a decision at most, so
// every decision with fire = 1 is a fresh press; an automatic weapon keeps the trigger down.
// Phases: the buy phase is BUY_DECISIONS decisions (the first applies the buy choice; the second lets
// a seat add armor), then the rest of it is fast-forwarded; round-end frames are fast-forwarded too,
// so they never produce a decision.
// A seat whose first head is -1, -2 or -3 is played by the scripted bot random, rusher or holder
// (ARENA_BOT_KINDS order) for that decision; its other heads are ignored. The league trainer uses this
// to mix bots into its opponent pool per env without a second bridge process. With a level below
// Champion, bots see the opponent as late as an agent does (R15, fair bots) but know their own position, aim and
// ammo live, like a person (R30: the first gate delayed the bot's own crosshair too, so it could not aim); at
// Champion (and with no level) they see the live game. The level's APM cap, minimum hold and aim limits filter
// what they do either way.
// Observation v2 (R15): after the delayed view the seat's OWN input state is appended, undelayed:
// the held move (one-hot, 9), the five held flags (walk, crouch, jump, fire, reload), the fraction of
// APM slots left, frames since the last accepted change (scaled) and a refused flag. The move head has
// one extra value, KEEP_MOVE, that keeps the held move and flags at no APM cost (the turn and buy
// heads still apply). Releases never cost APM (limiter.ts).
// With a level, both seats get that level's HumanLimiter: delayed observations (exactly delayFrames
// late), the APM cap and minimum hold on the movement and button input, and the turn-rate and noise
// limits on the aim (limiter.aim).
// The level string may end in "@close" (or be just "@close"): the close-range curriculum. Every round
// starts with seat 0 moved to within CLOSE_DISTANCES of seat 1 (the first distance that has a free
// hull and a clear line of sight), so a young policy meets its opponent within a few decisions and
// learns to aim before it learns to find the fight.

export { ACTION_DIMS }
export const FRAME_SKIP = 4
/** Own-input extras: held move (9), five flags, slots left, frames since change, refused. */
export const EXTRA_FEATURES = N_MOVES + 5 + 3
export const OBS_FEATURES = ARENA_FEATURES + EXTRA_FEATURES
export const BUY_DECISIONS = 2
export const LEVELS: readonly Level[] = ['easy', 'medium', 'hard', 'champion']
/** Largest aiming potential, against 0.35 for a body hit and 1 for a round. */
export const AIM_POTENTIAL = 0.2
const SHAPING_GAMMA = 0.99
export const CLOSE_DISTANCES: readonly number[] = [350, 500, 700]

/** Splits "easy@close" into its level and the curriculum flag. */
export function parseLevel(spec: string | undefined): { level: Level | undefined; close: boolean } {
  if (spec === undefined || spec === '') return { level: undefined, close: false }
  const [name, flag, ...rest] = spec.split('@')
  if (rest.length > 0 || (flag !== undefined && flag !== 'close')) throw new Error(`arena env: unknown level "${spec}"`)
  if (name !== '' && !LEVELS.includes(name as Level)) throw new Error(`arena env: unknown level "${spec}"`)
  return { level: name === '' ? undefined : (name as Level), close: flag === 'close' }
}

function hullFree(map: MapData, x: number, y: number): boolean {
  const b = map.boxes
  for (let i = 0, o = 0; i < map.boxCount; i++, o += 6) {
    if (b[o + 5]! <= STEP_HEIGHT || b[o + 2]! >= H_STAND) continue
    if (x + HULL_HALF <= b[o]! || x - HULL_HALF >= b[o + 3]! || y + HULL_HALF <= b[o + 1]! || y - HULL_HALF >= b[o + 4]!) continue
    return false
  }
  return true
}

/** Directions tried around seat 1, in 30 degree steps, nearest to the original bearing first. */
const CLOSE_TURNS: readonly number[] = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6]
const CLOSE_STEP = 8192 / 12

/**
 * Moves seat 0 to within CLOSE_DISTANCES of seat 1, on the first spot that has a free hull and a clear
 * line of sight (nearest distance first, the original bearing first), and turns it to face seat 1. A
 * round with no valid spot stays as authored. The facing uses Math.atan2: this runs in the training
 * env only, never in the sim, so cross-engine bit equality is not needed.
 */
export function closeIn(s: ArenaState): void {
  const map = MAP_LIST[s.mapIdx]!
  const a = s.players[0]
  const b = s.players[1]
  const dx = b.x - a.x
  const dy = b.y - a.y
  const d = Math.sqrt(dx * dx + dy * dy)
  if (d < 1) return
  const base = Math.atan2(-dy, -dx) // bearing from seat 1 to seat 0
  for (const dist of CLOSE_DISTANCES) {
    if (dist >= d) return
    for (const k of CLOSE_TURNS) {
      const ang = base + (k * CLOSE_STEP * 2 * Math.PI) / 8192
      const x = b.x + Math.cos(ang) * dist
      const y = b.y + Math.sin(ang) * dist
      if (x < map.bounds.x0 + HULL_HALF || x > map.bounds.x1 - HULL_HALF || y < map.bounds.y0 + HULL_HALF || y > map.bounds.y1 - HULL_HALF) continue
      if (!hullFree(map, x, y)) continue
      const z = groundHeight(map, x, y, 0)
      if (segmentBlocked(map, x, y, z + 64, b.x, b.y, b.z + 64)) continue
      a.x = x
      a.y = y
      a.z = z
      a.yaw = Math.round((Math.atan2(b.y - y, b.x - x) * 8192) / (2 * Math.PI)) & 8191
      return
    }
  }
}

const UNITS_PER_RAD = 8192 / (2 * Math.PI)

/**
 * Aiming potential of seat 0 in a live round: 0 unless the opponent is in sight, else AIM_POTENTIAL
 * times the mean of a yaw term and a pitch term, each 1 on target and falling to 0 at 0.5 rad (about
 * 29 degrees) of error. The reward adds gamma * potential(next) - potential(now), so it cannot change
 * which policy is best (Ng, Harada and Russell 1999); it only makes the way there less sparse.
 */
export function aimPotential(s: ArenaState): number {
  if (s.phase !== PHASE.LIVE) return 0
  const me = s.players[0]
  const op = s.players[1]
  if (me.alive === 0 || me.lsKnown === 0 || me.lsAge !== 0) return 0
  const dx = op.x - me.x
  const dy = op.y - me.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist < 1) return 0
  const yaw = me.yaw + me.punchYaw
  const forward = dx * cosU(yaw) + dy * sinU(yaw)
  if (forward <= 0) return 0
  const side = -dx * sinU(yaw) + dy * cosU(yaw)
  const yawErr = Math.abs(side / forward)
  const eye = me.crouch === 1 ? 46 : 64
  const wantPitch = (op.z + 50 - (me.z + eye)) / dist
  const pitchErr = Math.abs(wantPitch - (me.pitch + me.punchPitch) / UNITS_PER_RAD)
  const yawTerm = yawErr >= 0.5 ? 0 : 1 - yawErr / 0.5
  const pitchTerm = pitchErr >= 0.5 ? 0 : 1 - pitchErr / 0.5
  return (AIM_POTENTIAL * (yawTerm + pitchTerm)) / 2
}

interface Seat {
  limiter: HumanLimiter
  proxyLimiter: HumanLimiter
  bots: Array<ArenaBot | undefined>
  botSeed: number
  /** Set once a people sentinel takes the seat over this episode (A4): the bot, its own limiter, delayed view and reaction delay. */
  people?: { bot: ArenaBot; limiter: HumanLimiter; hist: DelayedStates<ArenaState>; delay: number }
}

/** Writes the own-input extras for a seat into out[offset..]. */
export function writeExtras(lim: HumanLimiter, frame: number, out: Float32Array, offset: number): void {
  const st = lim.status(frame)
  for (let m = 0; m < N_MOVES; m++) out[offset + m] = m === st.held[0] ? 1 : 0
  for (let b = 0; b < 5; b++) out[offset + N_MOVES + b] = (st.held[1] >> b) & 1
  out[offset + N_MOVES + 5] = st.slotsLeft
  out[offset + N_MOVES + 6] = st.sinceChange
  out[offset + N_MOVES + 7] = st.refused
}

const FLAG_BITS = (i: { walk: number; crouch: number; jump: number; fire: number; reload: number }): number =>
  i.walk + 2 * i.crouch + 4 * i.jump + 8 * i.fire + 16 * i.reload

export class ArenaEnv implements BridgeEnv {
  /** For behaviour cloning: the policy heads a scripted bot chose in the last step, per [env][seat]; untouched for a seat the policy plays. */
  readonly botHeads: Int32Array
  readonly obsShape = [2, OBS_FEATURES]
  readonly actionDims = ACTION_DIMS
  readonly version = 'arena-env-2'
  private states: ArenaState[] = []
  private seeds: number[] = []
  private anchors: number[] = []
  private rounds: number[] = []
  private buyDecisions: number[] = []
  private potentials: number[] = []
  private seats: Seat[][] = []
  private readonly delay: number
  private readonly tmp = new Float32Array(ARENA_FEATURES)
  /** Per env: recent full states, for bots that must see the delayed view (levels below Champion). */
  private readonly history: Array<DelayedStates<ArenaState> | undefined> = []
  private readonly proxyHistory: Array<DelayedStates<ArenaState>> = []
  private readonly delayBots: boolean
  /** For tests: the frame of the state the bot on [env][seat] saw at its last decision (-1 before any). */
  readonly botViewFrame: Int32Array
  /** For tests: the observation the bot on [env][seat] was last given (its own state live, the opponent as late as the level allows). */
  readonly botObsSeen: Array<ArenaObs | undefined>
  private readonly teachRand = (() => { const r = makeRng(0x7ea5); return () => r.float() })()

  constructor(readonly n: number, private readonly level: Level | undefined, private readonly close: boolean) {
    this.delay = level ? LEVEL_LIMITS.arena[level].delayFrames : 0
    this.delayBots = level !== undefined && level !== 'champion'
    this.botViewFrame = new Int32Array(n * 2).fill(-1)
    this.botObsSeen = new Array<ArenaObs | undefined>(n * 2).fill(undefined)
    this.botHeads = new Int32Array(n * 2 * ACTION_DIMS)
  }

  private startEpisode(i: number, seed: number): void {
    this.seeds[i] = seed >>> 0
    const s = createState(seed)
    this.states[i] = s
    const seats: Seat[] = []
    for (const k of [0, 1]) {
      const limiter = new HumanLimiter(this.level ? LEVEL_LIMITS.arena[this.level] : UNLIMITED, makeRng((seed + 7919 * (k + 1)) >>> 0))
      seats.push({ limiter, proxyLimiter: new HumanLimiter(HUMAN_PROXY_LIMITS, makeRng((seed + 7919 * (k + 1)) >>> 0)), bots: [], botSeed: (seed + 104729 * (k + 1)) >>> 0 })
    }
    this.seats[i] = seats
    this.history[i] = this.delayBots ? new DelayedStates<ArenaState>(this.delay, blankState, copyState) : undefined
    this.proxyHistory[i] = new DelayedStates<ArenaState>(HUMAN_PROXY_LIMITS.delayFrames, blankState, copyState)
    this.newRound(i)
    this.fastForward(i)
    this.anchorViews(i)
    this.potentials[i] = aimPotential(s)
  }

  private newRound(i: number): void {
    const s = this.states[i]!
    this.rounds[i] = s.round
    this.buyDecisions[i] = 0
    if (this.close) closeIn(s)
  }

  /**
   * Decisions run on a FRAME_SKIP grid starting at the anchor frame (the first frame of a buy phase or
   * of the live phase). History before the anchor is dropped, so a view never shows the previous
   * phase; until the delay has elapsed the seat sees the anchor view.
   */
  private anchorViews(i: number): void {
    this.anchors[i] = this.states[i]!.frame
    this.proxyHistory[i]!.clear()
    for (const seat of this.seats[i]!) {
      seat.people?.hist.clear()
      seat.people?.limiter.clearViews()
    }
    for (const seat of this.seats[i]!) seat.limiter.clearViews()
    this.history[i]?.clear()
    this.capture(i, true)
  }

  /** Records the views the limiters will be asked for later. Only frames congruent to -delay mod FRAME_SKIP are needed. */
  private capture(i: number, force: boolean): void {
    const s = this.states[i]!
    if (force || (s.frame - this.anchors[i]! + HUMAN_PROXY_LIMITS.delayFrames) % FRAME_SKIP === 0) this.proxyHistory[i]!.record(s.frame, s)
    for (const seat of this.seats[i]!) {
      const p = seat.people
      if (p && (force || (s.frame - this.anchors[i]! + p.delay) % FRAME_SKIP === 0)) p.hist.record(s.frame, s)
    }
    if (!this.level) return
    if (!force && (s.frame - this.anchors[i]! + this.delay) % FRAME_SKIP !== 0) return
    for (const k of [0, 1] as const) {
      encodeState(s, k, this.tmp, 0)
      this.seats[i]![k]!.limiter.record(this.tmp, s.frame)
    }
    this.history[i]?.record(s.frame, s)
  }

  private needsDecision(i: number): boolean {
    const s = this.states[i]!
    return s.phase === PHASE.LIVE || (s.phase === PHASE.BUY && this.buyDecisions[i]! < BUY_DECISIONS)
  }

  /** Steps neutral through the rest of the buy phase and the round end. Returns how many frames it stepped. */
  private fastForward(i: number): number {
    const s = this.states[i]!
    let steps = 0
    while (s.matchOver === 0 && !this.needsDecision(i)) {
      stepPacked(s, 0, 0)
      steps++
      if (s.round !== this.rounds[i]) this.newRound(i)
    }
    return steps
  }

  private writeObs(i: number, out: Float32Array): void {
    const s = this.states[i]!
    for (const k of [0, 1] as const) {
      const base = (i * 2 + k) * OBS_FEATURES
      const limiter = this.seats[i]![k]!.limiter
      if (this.level) limiter.viewInto(s.frame, out, base)
      else encodeState(s, k, out, base)
      writeExtras(limiter, s.frame, out, base + ARENA_FEATURES)
    }
  }

  reset(seeds: number[]): Float32Array {
    if (seeds.length !== this.n) throw new Error(`reset needs ${this.n} seeds, got ${seeds.length}`)
    for (let i = 0; i < this.n; i++) this.startEpisode(i, seeds[i]!)
    const obs = new Float32Array(this.n * 2 * OBS_FEATURES)
    for (let i = 0; i < this.n; i++) this.writeObs(i, obs)
    return obs
  }

  /** Hands the seat to a scripted bot on a people profile: the profile's limiter (cap, hold, turn rate, noise), its own delayed view, its slips. */
  private takeOver(i: number, k: 0 | 1, profile: PeopleProfile, kind: number, s: ArenaState) {
    const seat = this.seats[i]![k]!
    const delay = PEOPLE_DELAY_FRAMES[profile]
    const limiter = new HumanLimiter(ARENA_PEOPLE_LIMITS[profile], makeRng((this.seeds[i]! + 7919 * (k + 1)) >>> 0))
    const hist = new DelayedStates<ArenaState>(delay, blankState, copyState)
    hist.record(s.frame, s)
    const bot = withMistakes(createBot(ARENA_BOT_KINDS[kind]!, seat.botSeed + kind), PEOPLE_MISTAKE_RATE[profile], seat.botSeed + 4242)
    seat.people = { bot, limiter, hist, delay }
    return seat.people
  }

  /** The input a seat plays this decision: a bot's or the policy's, then filtered by the level's limiter. */
  private seatInput(i: number, k: 0 | 1, actions: Int32Array): ArenaInput {
    const s = this.states[i]!
    const seat = this.seats[i]![k]!
    const base = (i * 2 + k) * ACTION_DIMS
    let inp: ArenaInput
    const head = actions[base]!
    const isProxy = head === ARENA_BOT_SENTINEL_BASE - ARENA_BOT_KINDS.indexOf('human-proxy')
    let people: NonNullable<Seat['people']> | undefined
    if (Number.isInteger(head) && head < 0 && ARENA_BOT_SENTINEL_BASE - head >= 16) {
      const dec = decodePeopleSentinel(ARENA_BOT_SENTINEL_BASE - head, ARENA_BOT_KINDS.length)
      if (!dec) throw new RangeError(`arena env: bad people sentinel ${head} for env ${i} seat ${k}`)
      people = seat.people ?? this.takeOver(i, k, dec.profile, dec.kind, s)
      const seen = people.hist.view(s.frame)
      this.botViewFrame[i * 2 + k] = seen.frame
      const view = buildObs(s, k)
      view.opp = buildObs(seen.state, k).opp
      this.botObsSeen[i * 2 + k] = view
      inp = people.bot.act(view)
      const bad = this.badInput(inp)
      if (bad) throw new RangeError(`arena env: people bot gave ${bad} for env ${i} seat ${k}`)
      headsFromInput(inp, this.botHeads, base, this.teachRand)
    } else if (Number.isInteger(head) && head < 0 && head >= ARENA_BOT_SENTINEL_BASE - (ARENA_BOT_KINDS.length - 1)) {
      const kind = ARENA_BOT_SENTINEL_BASE - head
      const bot = (seat.bots[kind] ??= createBot(ARENA_BOT_KINDS[kind]!, seat.botSeed + kind))
      const seen = isProxy ? this.proxyHistory[i]!.view(s.frame) : this.history[i]?.view(s.frame)
      this.botViewFrame[i * 2 + k] = seen ? seen.frame : s.frame
      // A bot, like a person, knows its own position and aim right now; only its sight of the opponent is late (R30).
      const view = buildObs(s, k)
      if (seen) view.opp = buildObs(seen.state, k).opp
      this.botObsSeen[i * 2 + k] = view
      inp = bot.act(view)
      const bad = this.badInput(inp)
      if (bad) throw new RangeError(`arena env: bot ${ARENA_BOT_KINDS[kind]} gave ${bad} for env ${i} seat ${k}`)
      headsFromInput(inp, this.botHeads, base, this.teachRand)
    } else {
      const bad = badHead(actions, base)
      if (bad >= 0) throw new RangeError(`arena env: bad action head ${bad} (${actions[base + bad]}) for env ${i} seat ${k}`)
      if (actions[base] === KEEP_MOVE) {
        // Keep: the move and button heads are replaced by what is held; the turn and buy heads still apply.
        const heads = Int32Array.from(actions.subarray(base, base + ACTION_DIMS))
        heads[0] = 0
        const h = seat.limiter.heldInput()
        inp = { ...inputFromHeads(heads, 0), move: h[0], walk: h[1] & 1, crouch: (h[1] >> 1) & 1, jump: (h[1] >> 2) & 1, fire: (h[1] >> 3) & 1, reload: (h[1] >> 4) & 1 }
      } else {
        inp = inputFromHeads(actions, base)
      }
    }
    const lim = people ? people.limiter : isProxy ? seat.proxyLimiter : seat.limiter
    const held = lim.act([inp.move, FLAG_BITS(inp)], s.frame)
    let f = held[1]!
    // A semi-automatic weapon presses the trigger again on every decision (heldInput), so each decision that
    // fires spends an APM slot even when the held input did not change.
    if ((f & 8) !== 0 && s.phase === PHASE.LIVE && WEAPONS[s.players[k].weapon]!.auto === 0 && !lim.trigger(s.frame)) f &= ~8
    const [yaw, pitch] = lim.aim(inp.yaw, inp.pitch, FRAME_SKIP)
    return {
      move: held[0]!, walk: f & 1, crouch: (f >> 1) & 1, jump: (f >> 2) & 1, fire: (f >> 3) & 1, reload: (f >> 4) & 1,
      yaw: Math.max(-YAW_MAX, Math.min(YAW_MAX, yaw)), pitch: Math.max(-PITCH_MAX_DELTA, Math.min(PITCH_MAX_DELTA, pitch)), buy: inp.buy,
    }
  }

  /** The input for frames 2 to 4 of a decision: the same, minus the buy choice and, for a semi-automatic weapon, the trigger. */
  private heldInput(s: ArenaState, k: 0 | 1, inp: ArenaInput, buying: boolean): ArenaInput {
    const release = inp.fire === 1 && WEAPONS[s.players[k].weapon]!.auto === 0
    if (!buying && !release) return inp
    return { ...inp, buy: 0, fire: release ? 0 : inp.fire }
  }

  private badInput(a: ArenaInput): string | null {
    if (!Number.isInteger(a.move) || a.move < 0 || a.move >= N_MOVES) return `move ${a.move}`
    if (!Number.isInteger(a.buy) || a.buy < 0 || a.buy >= N_BUYS) return `buy ${a.buy}`
    return null
  }

  step(actions: Int32Array) {
    if (actions.length !== this.n * 2 * ACTION_DIMS) throw new Error(`step needs ${this.n * 2 * ACTION_DIMS} actions, got ${actions.length}`)
    const obs = new Float32Array(this.n * 2 * OBS_FEATURES)
    const reward = new Float32Array(this.n)
    const done = new Uint8Array(this.n)
    const infos: Array<Record<string, unknown>> = []
    for (let i = 0; i < this.n; i++) {
      const s = this.states[i]!
      const inA = this.seatInput(i, 0, actions)
      const inB = this.seatInput(i, 1, actions)
      const buying = s.phase === PHASE.BUY
      if (buying) this.buyDecisions[i]!++
      const p0 = packInput(inA)
      const p1 = packInput(inB)
      // A buy choice is made once per decision, on its first frame. A semi-automatic weapon gets its
      // trigger on the first frame only, so every decision that fires is a fresh press (the policy has no
      // memory of its last trigger state); an automatic weapon holds the trigger for the whole decision.
      const rest0 = this.heldInput(s, 0, inA, buying)
      const rest1 = this.heldInput(s, 1, inB, buying)
      const q0 = rest0 === inA ? p0 : packInput(rest0)
      const q1 = rest1 === inB ? p1 : packInput(rest1)
      let r = 0
      for (let f = 0; f < FRAME_SKIP && s.matchOver === 0; f++) {
        const live = s.phase === PHASE.LIVE
        const h0 = s.players[0].health
        const h1 = s.players[1].health
        const w0 = s.wins[0]
        const w1 = s.wins[1]
        stepPacked(s, f === 0 ? p0 : q0, f === 0 ? p1 : q1)
        if (live) {
          r += (h1 - s.players[1].health - (h0 - s.players[0].health)) / MAX_HEALTH
          r += s.wins[0] - w0 - (s.wins[1] - w1)
        }
        this.capture(i, false)
      }
      if (this.fastForward(i) > 0 && s.matchOver === 0) this.anchorViews(i)
      const phi = s.matchOver === 1 ? 0 : aimPotential(s)
      r += SHAPING_GAMMA * phi - this.potentials[i]!
      this.potentials[i] = phi
      reward[i] = r
      if (s.matchOver === 1) {
        done[i] = 1
        const [a, b] = s.wins
        infos.push({
          env: i, winner: a > b ? 0 : b > a ? 1 : null, score: [a, b], rounds: s.round, finalHash: hashState(s), seed: this.seeds[i], frames: s.frame,
        })
        this.startEpisode(i, nextSeed(this.seeds[i]!, this.n))
      }
      this.writeObs(i, obs)
    }
    return { obs, reward, done, infos }
  }
}

export const createEnv: EnvFactory | null = ({ n, level }) => {
  const { level: lv, close } = parseLevel(level)
  return new ArenaEnv(n, lv, close)
}
