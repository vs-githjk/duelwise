import { makeRng } from '../../rng'
import type { Result, Rng } from '../../types'
import { N_RAYS, type ArenaObs } from './encode'
import { MOVE, NEUTRAL_INPUT, PITCH_MAX_DELTA, YAW_MAX, type ArenaInput } from './input'
import { PHASE } from './state'
import { cosU, sinU } from './trig'
import { ARENA_BOT_SENTINEL_BASE, PITCH_BINS, YAW_BINS } from './actions'
import { createEnv } from './env'

// Scripted opponents for tests, league seeding and measurement (T10). A bot sees what an agent sees
// (ArenaObs: own state, the opponent as last seen, 24 wall rays) and answers with a full ArenaInput
// once per decision (its turn is applied on every frame of the decision). Bots use no trig functions: a bearing error is a cross product over a distance.

export type BotKind = 'random' | 'rusher' | 'holder' | 'peeker' | 'strafe' | 'holdangle' | 'human-proxy'
/** Order matters: the env reads the sentinel -1 - index in the first action head as 'play this seat with that bot'. New kinds go last. */
export const ARENA_BOT_KINDS: readonly BotKind[] = ['random', 'rusher', 'holder', 'peeker', 'strafe', 'holdangle', 'human-proxy']
export const HUMAN_PROXY_LIMITS = { delayFrames: 15, apmCap: null, minHoldFrames: 0, aimRateDegPerSec: 400, aimNoiseDeg: 0, buttonBits: true } as const

export interface ArenaBot {
  readonly kind: BotKind
  act(obs: ArenaObs): ArenaInput
}

const UNITS_PER_RAD = 8192 / (2 * Math.PI)
const EYE_STAND = 64
const EYE_CROUCH = 46
/** Aim height above the opponent's feet: upper chest. */
const AIM_HEIGHT = 50
/** A turn command is applied on every frame of the decision (4 frames), so 0.2 closes about 80% of an error. */
const AIM_GAIN = 0.2
const RIDGELINE_PRICE = 2700
const CARBINE_PRICE = 3100
const ARMOR_PRICE = 1000

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const input = (o: Partial<ArenaInput>): ArenaInput => ({ ...NEUTRAL_INPUT, ...o })

class RandomBot implements ArenaBot {
  readonly kind = 'random' as const
  constructor(private readonly rng: Rng) {}
  /** Uniform over the policy's own heads, so it is exactly what an untrained network does. */
  act(): ArenaInput {
    const r = this.rng
    return {
      move: r.int(9),
      walk: r.int(2),
      crouch: r.int(2),
      jump: r.int(2),
      fire: r.int(2),
      reload: r.int(2),
      yaw: YAW_BINS[r.int(YAW_BINS.length)]!,
      pitch: PITCH_BINS[r.int(PITCH_BINS.length)]!,
      buy: r.int(4),
    }
  }
}

/** What to buy in the buy phase: the best weapon it can afford, then armor. 0 when nothing. */
function shopping(obs: ArenaObs): number {
  const me = obs.self
  if (me.weapon === 0) {
    if (me.money >= CARBINE_PRICE) return 2
    if (me.money >= RIDGELINE_PRICE) return 1
  }
  if (me.armor < 100 && me.money >= ARMOR_PRICE) return 3
  return 0
}

interface Aim {
  yaw: number
  pitch: number
  /** Horizontal distance to the target. */
  dist: number
  /** The target is in front of the view (within about 75 degrees). */
  ahead: boolean
  /** Yaw error is small enough for the shot to land at this range. */
  onTarget: boolean
}

/**
 * Turn commands that put the crosshair, recoil included, on the opponent's upper chest. Uses the live
 * position while the opponent is in sight and the last sighting otherwise.
 */
function aimAt(obs: ArenaObs): Aim | null {
  const op = obs.opp
  if (op.known === 0) return null
  const me = obs.self
  const dx = op.x - me.x
  const dy = op.y - me.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist < 1) return null
  // The shot flies along (yaw + punchYaw, pitch + punchPitch); undo the punch.
  const yawNow = me.yaw + me.punchYaw
  const cy = cosU(yawNow)
  const sy = sinU(yawNow)
  const forward = dx * cy + dy * sy
  const side = dx * -sy + dy * cy // positive: target is toward larger yaw
  const errYaw = (side / dist) * UNITS_PER_RAD
  const eye = me.crouch === 1 ? EYE_CROUCH : EYE_STAND
  const dz = op.z + AIM_HEIGHT - (me.z + eye)
  const wantPitch = (dz / dist) * UNITS_PER_RAD
  const errPitch = wantPitch - (me.pitch + me.punchPitch)
  const hit = 14000 / dist + 6
  return {
    yaw: forward < 0 ? YAW_MAX * (side >= 0 ? 1 : -1) : clamp(Math.round(errYaw * AIM_GAIN), -YAW_MAX, YAW_MAX),
    pitch: clamp(Math.round(errPitch * AIM_GAIN), -PITCH_MAX_DELTA, PITCH_MAX_DELTA),
    dist,
    ahead: forward > 0.25 * dist,
    onTarget: forward > 0 && Math.abs(errYaw) <= hit && Math.abs(errPitch) <= hit * 1.5,
  }
}

/** Longest free bearing from the rays, as a yaw command, to get out of a wall. */
function turnTowardOpen(obs: ArenaObs): number {
  let best = 0
  for (let i = 1; i < N_RAYS; i++) if (obs.rays[i]! > obs.rays[best]!) best = i
  // Ray i points at yaw + i * 8192 / 24; wrap to -half..half.
  const off = best > N_RAYS / 2 ? best - N_RAYS : best
  return clamp(off * 40, -YAW_MAX, YAW_MAX)
}

class RusherBot implements ArenaBot {
  readonly kind = 'rusher' as const
  private strafe = 1
  constructor(private readonly rng: Rng) {}
  act(obs: ArenaObs): ArenaInput {
    const me = obs.self
    if (obs.phase === PHASE.BUY) return input({ buy: shopping(obs) })
    if (obs.phase !== PHASE.LIVE) return NEUTRAL_INPUT
    const reload = me.ammo === 0 && me.reload === 0 ? 1 : 0
    const aim = aimAt(obs)
    if (aim === null) {
      // Nothing seen yet: run forward, sweep, and leave walls.
      const wall = obs.rays[0]! < 90
      return input({ move: MOVE.F, yaw: wall ? turnTowardOpen(obs) : 5, reload })
    }
    if (this.rng.float() < 0.08) this.strafe = -this.strafe
    const close = aim.dist < 260
    const move = !aim.ahead ? MOVE.N : close ? (this.strafe > 0 ? MOVE.R : MOVE.L) : this.strafe > 0 ? MOVE.FR : MOVE.FL
    const seen = obs.opp.visible === 1
    return input({
      move: obs.rays[0]! < 70 && !close ? MOVE.N : move,
      yaw: aim.yaw,
      pitch: aim.pitch,
      fire: seen && aim.onTarget && me.ammo > 0 ? 1 : 0,
      reload,
    })
  }
}

class HolderBot implements ArenaBot {
  constructor(private readonly rng: Rng, readonly kind: 'holder' | 'human-proxy' = 'holder') {}
  private burst = 0
  act(obs: ArenaObs): ArenaInput {
    const me = obs.self
    if (obs.phase === PHASE.BUY) return input({ buy: shopping(obs) })
    if (obs.phase !== PHASE.LIVE) return NEUTRAL_INPUT
    const reload = me.ammo < 6 && me.reload === 0 && obs.opp.visible === 0 ? 1 : me.ammo === 0 && me.reload === 0 ? 1 : 0
    const aim = aimAt(obs)
    if (aim === null) return input({ yaw: this.rng.float() < 0.5 ? 26 : -26, crouch: 1, reload })
    const seen = obs.opp.visible === 1
    // Tap and pause: three decisions of fire, two of rest, which keeps the spray short enough to hit.
    if (seen && aim.onTarget && me.ammo > 0) this.burst = (this.burst + 1) % 5
    else this.burst = 0
    return input({
      crouch: 1,
      walk: 1,
      yaw: aim.yaw,
      pitch: aim.pitch,
      fire: seen && aim.onTarget && me.ammo > 0 && this.burst < 3 ? 1 : 0,
      reload,
    })
  }
}

/**
 * Crouched behind its start until the cycle opens, then a short strafing peek that fires on sight and
 * goes back. The peek side alternates, so the bot is hard to pre-aim. (R30: the judge's human proxies.)
 */
class PeekerBot implements ArenaBot {
  readonly kind = 'peeker' as const
  private tick = 0
  private side = 1
  constructor(private readonly rng: Rng) {}
  act(obs: ArenaObs): ArenaInput {
    const me = obs.self
    if (obs.phase === PHASE.BUY) return input({ buy: shopping(obs) })
    if (obs.phase !== PHASE.LIVE) return NEUTRAL_INPUT
    const reload = me.ammo < 6 && me.reload === 0 && obs.opp.visible === 0 ? 1 : me.ammo === 0 && me.reload === 0 ? 1 : 0
    const aim = aimAt(obs)
    const phase = this.tick++ % PEEK_CYCLE
    if (phase === 0) this.side = this.rng.float() < 0.5 ? 1 : -1
    const peeking = phase >= PEEK_CYCLE - PEEK_LENGTH
    if (aim === null) return input({ crouch: peeking ? 0 : 1, move: peeking ? MOVE.F : MOVE.N, yaw: peeking ? this.side * 12 : 0, reload })
    const seen = obs.opp.visible === 1
    const fire = seen && aim.onTarget && me.ammo > 0 && (peeking || phase % 2 === 0) ? 1 : 0
    return input({
      crouch: peeking ? 0 : 1,
      walk: peeking ? 0 : 1,
      move: peeking ? (this.side > 0 ? MOVE.R : MOVE.L) : MOVE.N,
      yaw: aim.yaw,
      pitch: aim.pitch,
      fire,
      reload,
    })
  }
}
const PEEK_CYCLE = 24
const PEEK_LENGTH = 8

/**
 * Counter-strafing: runs sideways for a few decisions, stops dead to shoot for the next few, and alternates
 * sides. It keeps its crosshair on the opponent while moving, as a person with a mouse does.
 */
class StrafeBot implements ArenaBot {
  readonly kind = 'strafe' as const
  private tick = 0
  private side = 1
  constructor(private readonly rng: Rng) {}
  act(obs: ArenaObs): ArenaInput {
    const me = obs.self
    if (obs.phase === PHASE.BUY) return input({ buy: shopping(obs) })
    if (obs.phase !== PHASE.LIVE) return NEUTRAL_INPUT
    const reload = me.ammo === 0 && me.reload === 0 ? 1 : 0
    const aim = aimAt(obs)
    if (aim === null) {
      const wall = obs.rays[0]! < 90
      return input({ move: MOVE.F, yaw: wall ? turnTowardOpen(obs) : 7, reload })
    }
    const step = this.tick++ % 6
    if (step === 0 && this.rng.float() < 0.7) this.side = -this.side
    const stopped = step >= 3
    const seen = obs.opp.visible === 1
    return input({
      move: stopped ? MOVE.N : this.side > 0 ? MOVE.R : MOVE.L,
      yaw: aim.yaw,
      pitch: aim.pitch,
      fire: seen && aim.onTarget && me.ammo > 0 && stopped ? 1 : 0,
      reload,
    })
  }
}

/**
 * Stands in the open and does not move or sweep: the crosshair stays on whatever angle it was spawned or
 * last aimed at, and it fires when the opponent crosses it. The "hold an angle" player of the judge's probe.
 */
class HoldAngleBot implements ArenaBot {
  readonly kind = 'holdangle' as const
  private burst = 0
  act(obs: ArenaObs): ArenaInput {
    const me = obs.self
    if (obs.phase === PHASE.BUY) return input({ buy: shopping(obs) })
    if (obs.phase !== PHASE.LIVE) return NEUTRAL_INPUT
    const reload = me.ammo === 0 && me.reload === 0 ? 1 : 0
    const aim = aimAt(obs)
    if (aim === null) return input({ reload })
    const seen = obs.opp.visible === 1
    if (seen && aim.onTarget && me.ammo > 0) this.burst = (this.burst + 1) % 5
    else this.burst = 0
    // Turns only while the opponent is in sight; once it is gone the bot keeps the last facing.
    return input({
      yaw: seen ? aim.yaw : 0,
      pitch: seen ? aim.pitch : 0,
      fire: seen && aim.onTarget && me.ammo > 0 && this.burst < 3 ? 1 : 0,
      reload,
    })
  }
}

/**
 * A bot that slips (people hands, A4): with probability `rate` per decision its answer is replaced by a uniformly random input over the
 * policy's heads (the random bot). Default off: a rate of 0 returns the bot itself, so every published measurement stays byte-identical.
 * Two draws per decision, always, so the slip stream does not depend on what the bot did.
 */
export function withMistakes(bot: ArenaBot, rate: number, seed: number): ArenaBot {
  if (!(rate > 0)) return bot
  const coin = makeRng(seed >>> 0)
  const random = new RandomBot(makeRng((seed + 977) >>> 0))
  return {
    kind: bot.kind,
    act(obs) {
      const slip = coin.float() < rate
      const wrong = random.act()
      const a = bot.act(obs)
      return slip ? wrong : a
    },
  }
}

export function createBot(kind: BotKind, seed: number): ArenaBot {
  const rng = makeRng(seed >>> 0)
  switch (kind) {
    case 'random':
      return new RandomBot(rng)
    case 'rusher':
      return new RusherBot(rng)
    case 'holder':
      return new HolderBot(rng)
    case 'human-proxy':
      return new HolderBot(rng, 'human-proxy')
    case 'peeker':
      return new PeekerBot(rng)
    case 'strafe':
      return new StrafeBot(rng)
    case 'holdangle':
      return new HoldAngleBot()
    default:
      throw new Error(`unknown arena bot "${kind as string}"`)
  }
}

export interface BotMatch {
  result: Result
  finalHash: string
  frames: number
}

const MAX_DECISIONS = 60_000

/** Plays one match between two bots through the training env, so the decision rhythm is the env's. Seat 0 is kinds[0]. */
export function playBotMatch(seed: number, kinds: [BotKind, BotKind], opts: { level?: string } = {}): BotMatch {
  if (!createEnv) throw new Error('arena env is not built')
  const env = createEnv({ n: 1, seed, level: opts.level })
  env.reset([seed])
  const act = new Int32Array(2 * env.actionDims)
  act[0] = ARENA_BOT_SENTINEL_BASE - ARENA_BOT_KINDS.indexOf(kinds[0])
  act[env.actionDims] = ARENA_BOT_SENTINEL_BASE - ARENA_BOT_KINDS.indexOf(kinds[1])
  for (let t = 0; t < MAX_DECISIONS; t++) {
    const out = env.step(act)
    if (out.done[0] === 1) {
      const info = out.infos[0] as { score: [number, number]; winner: 0 | 1 | null; finalHash: string; frames: number }
      return { result: { winner: info.winner, score: info.score, reason: info.winner === null ? 'draw' : 'rounds' }, finalHash: info.finalHash, frames: info.frames }
    }
  }
  throw new Error('arena bot match did not finish')
}
