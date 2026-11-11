import type { Result, Rng } from '../../types'
import { makeRng } from '../../rng'
import { stepPacked } from './core'
import { THROW_RANGE } from './constants'
import { FRAME_SKIP, viewDirToScreen } from './env'
import { buildObs, type FighterObs } from './encode'
import { BTN, DIR, N_ACTIONS, N_DIRS } from './input'
import { M, MOVES, isAttackId } from './moves'
import { hashFighterState, PHASE, createState } from './state'

// Scripted opponents for tests, league seeding and measurement. A bot sees what an agent sees (the
// mirrored FighterObs: it stands on the left facing right, the opponent is at dx > 0) and answers
// with a packed input (button * 9 + direction) in that view, once per decision.

export type BotKind = 'random' | 'rushdown' | 'turtle' | 'zoner' | 'throwloop' | 'backwalk' | 'pokeloop' | 'sweepspam' | 'fireball' | 'throwtap' | 'fireball25'
// Order matters: the env hands a seat to bot index i with the first action head = -1 - i, and the league
// trainer (league.py BOT_KINDS) uses the same order. New bots are appended, never inserted.
export const FIGHTER_BOT_KINDS: readonly BotKind[] = ['random', 'rushdown', 'turtle', 'zoner', 'throwloop', 'backwalk', 'pokeloop', 'sweepspam', 'fireball', 'throwtap', 'fireball25']

export interface FighterBot {
  readonly kind: BotKind
  /** One packed input in the bot's own (mirrored) view. */
  act(obs: FighterObs): number
}

const pack = (dir: number, btn: number): number => btn * N_DIRS + dir

/** Presses `btn`, but releases first when a button is still held, so every press is a fresh edge. */
const press = (obs: FighterObs, dir: number, btn: number): number => (obs.self.prevBtn !== 0 ? pack(dir, 0) : pack(dir, btn))

const busy = (obs: FighterObs): boolean => obs.self.moveId > M.WALK_B || obs.self.hitstop > 0

class RandomBot implements FighterBot {
  readonly kind = 'random' as const
  constructor(private readonly rng: Rng) {}
  act(): number {
    return this.rng.int(N_ACTIONS)
  }
}

class RushdownBot implements FighterBot {
  readonly kind = 'rushdown' as const
  constructor(private readonly rng: Rng) {}
  act(obs: FighterObs): number {
    const { self, opp, dx } = obs
    if (obs.phase !== PHASE.FIGHT) return pack(DIR.N, 0)
    if (busy(obs)) return pack(DIR.L, 0)
    if (opp.airborne === 1 && dx < 140 && self.prevBtn === 0) return pack(DIR.U, BTN.SPECIAL)
    if (dx > 300) {
      if (self.projectileOn === 0 && this.rng.float() < 0.08) return press(obs, DIR.N, BTN.SPECIAL)
      return pack(DIR.R, 0)
    }
    // Pressure, but a swing that is already coming gets blocked.
    if (isAttackId(opp.moveId) && dx < MOVES[opp.moveId]!.hit.x1 + 40 && opp.moveFrame <= MOVES[opp.moveId]!.startup + MOVES[opp.moveId]!.active) {
      return pack(MOVES[opp.moveId]!.level === 'low' ? DIR.DL : DIR.L, 0)
    }
    // Fight at the edge of reach with long normals, closer in with throws and quick normals.
    if (dx > 185) return pack(DIR.R, 0)
    const r = this.rng.float()
    if (dx > 120) {
      if (r < 0.45) return press(obs, DIR.N, BTN.HEAVY)
      if (r < 0.7) return press(obs, DIR.D, BTN.HEAVY)
      return press(obs, DIR.N, BTN.MEDIUM)
    }
    if (dx < 70 && r < 0.4) return press(obs, DIR.N, BTN.THROW)
    if (r < 0.7) return press(obs, DIR.N, BTN.LIGHT)
    return press(obs, DIR.N, BTN.MEDIUM)
  }
}

class TurtleBot implements FighterBot {
  readonly kind = 'turtle' as const
  constructor(private readonly rng: Rng) {}
  act(obs: FighterObs): number {
    const { self, opp, dx } = obs
    if (obs.phase !== PHASE.FIGHT) return pack(DIR.N, 0)
    if (opp.moveId === M.THROW && dx < 90) return press(obs, DIR.N, BTN.THROW) // tech
    if (self.moveId > M.WALK_B && self.stun === 0) return pack(DIR.L, 0)
    if (opp.airborne === 1 && dx < 150) return press(obs, DIR.U, BTN.SPECIAL)
    if (isAttackId(opp.moveId)) {
      const m = MOVES[opp.moveId]!
      if (opp.moveFrame > m.startup + m.active - 1 && !m.projectile) {
        // Recovery: punish if the target is in reach.
        if (dx < m.hit.x1 + 60) return press(obs, DIR.N, BTN.HEAVY)
        return pack(DIR.L, 0)
      }
      return pack(m.level === 'low' ? DIR.DL : DIR.L, 0)
    }
    if (opp.projectileOn === 1) return pack(DIR.L, 0)
    if (dx > 380 && self.projectileOn === 0 && this.rng.float() < 0.1) return press(obs, DIR.N, BTN.SPECIAL)
    if (dx < 110 && this.rng.float() < 0.15) return press(obs, DIR.N, BTN.LIGHT)
    return pack(DIR.L, 0)
  }
}

/**
 * Exploit bot 1 (R30, the judge's "blind zone"): holds back and taps Special every 40 frames (10 decisions)
 * whatever happens. It reads nothing, so a policy that only reacts to what it sees cannot be fooled by it
 * and has to close the distance and punish the recovery.
 */
class ZonerBot implements FighterBot {
  readonly kind = 'zoner' as const
  private n: number
  constructor(rng: Rng) {
    this.n = rng.int(10)
  }
  act(obs: FighterObs): number {
    if (obs.phase !== PHASE.FIGHT) return pack(DIR.L, 0)
    const fire = this.n++ % 10 === 0
    return fire ? press(obs, DIR.L, BTN.SPECIAL) : pack(DIR.L, 0)
  }
}

/** Exploit bot 2 (the judge's "throw loop"): walks forward and mashes Throw as fresh presses once close. */
class ThrowLoopBot implements FighterBot {
  readonly kind = 'throwloop' as const
  constructor(_rng: Rng) {}
  act(obs: FighterObs): number {
    if (obs.phase !== PHASE.FIGHT) return pack(DIR.N, 0)
    if (obs.dx <= THROW_RANGE - 2) return press(obs, DIR.N, BTN.THROW)
    return pack(DIR.R, 0)
  }
}

/** Exploit bot 3: walks away for the whole round and only pokes when it is backed into the wall. A policy that never closes in loses on the timer. */
class BackWalkBot implements FighterBot {
  readonly kind = 'backwalk' as const
  constructor(_rng: Rng) {}
  act(obs: FighterObs): number {
    if (obs.phase !== PHASE.FIGHT) return pack(DIR.N, 0)
    if (obs.dx < 70) return press(obs, DIR.L, BTN.LIGHT)
    return pack(DIR.L, 0)
  }
}

/**
 * Exploit bot 4 (KC1, the judge's tinderbox-r2 "pokespam"): walks in to poking range, then holds down and taps Light as a
 * fresh press every 12 frames (3 decisions). It needs spacing, so a policy has to keep its own distance, step in on the
 * recovery and not block high.
 */
const POKE_RANGE = 120
class PokeLoopBot implements FighterBot {
  readonly kind = 'pokeloop' as const
  private n: number
  constructor(rng: Rng) {
    this.n = rng.int(3)
  }
  act(obs: FighterObs): number {
    if (obs.phase !== PHASE.FIGHT) return pack(DIR.N, 0)
    if (obs.dx > POKE_RANGE) return pack(DIR.R, 0)
    return this.n++ % 3 === 0 ? press(obs, DIR.D, BTN.LIGHT) : pack(DIR.D, 0)
  }
}

/** Exploit bot 5 (the judge's sweep spam): walks in to sweep range and sweeps (down + Heavy) whenever it is free to act. */
const SWEEP_RANGE = 150
class SweepSpamBot implements FighterBot {
  readonly kind = 'sweepspam' as const
  constructor(_rng: Rng) {}
  act(obs: FighterObs): number {
    if (obs.phase !== PHASE.FIGHT) return pack(DIR.N, 0)
    if (obs.dx > SWEEP_RANGE) return pack(DIR.R, 0)
    return busy(obs) ? pack(DIR.D, 0) : press(obs, DIR.D, BTN.HEAVY)
  }
}

/**
 * Exploit bot 6 (the judge's "range fireball"): keeps a mid-range gap (steps back when crowded, walks in when far) and
 * fires Special whenever its last fireball is gone. A zoner that reads spacing, unlike the blind one.
 */
const FIREBALL_NEAR = 220
const FIREBALL_FAR = 650
class FireballBot implements FighterBot {
  readonly kind = 'fireball' as const
  constructor(_rng: Rng) {}
  act(obs: FighterObs): number {
    if (obs.phase !== PHASE.FIGHT) return pack(DIR.N, 0)
    if (obs.dx < FIREBALL_NEAR) return pack(DIR.L, 0)
    if (obs.dx > FIREBALL_FAR) return pack(DIR.R, 0)
    if (obs.self.projectileOn === 0 && !busy(obs)) return press(obs, DIR.N, BTN.SPECIAL)
    return pack(DIR.N, 0)
  }
}

/**
 * Exploit bot 7 (LC1, the judge's tinderbox-r3 page loop): walks in to throw range, then stands still and taps Throw as a fresh
 * press every 12 frames (3 decisions) whatever the target does. Unlike throwloop, which throws at every chance and so lands its
 * throws in a rhythm the agent can learn, this one keeps its own cadence, the way a person tapping a key does.
 */
class ThrowTapBot implements FighterBot {
  readonly kind = 'throwtap' as const
  private n: number
  constructor(rng: Rng) {
    this.n = rng.int(3)
  }
  act(obs: FighterObs): number {
    if (obs.phase !== PHASE.FIGHT) return pack(DIR.N, 0)
    if (obs.dx > THROW_RANGE - 2) return pack(DIR.R, 0)
    return this.n++ % 3 === 0 ? press(obs, DIR.N, BTN.THROW) : pack(DIR.N, 0)
  }
}

class Fireball25Bot implements FighterBot {
  readonly kind = 'fireball25' as const
  private remaining: number
  constructor(private readonly rng: Rng) { this.remaining = rng.int(7) }
  act(obs: FighterObs): number {
    if (obs.phase !== PHASE.FIGHT) return pack(DIR.L, 0)
    if (this.remaining-- > 0) return pack(DIR.L, 0)
    this.remaining = 4 + this.rng.int(3)
    return press(obs, DIR.L, BTN.SPECIAL)
  }
}

export function createBot(kind: BotKind, seed: number): FighterBot {
  const rng = makeRng(seed >>> 0)
  switch (kind) {
    case 'random':
      return new RandomBot(rng)
    case 'rushdown':
      return new RushdownBot(rng)
    case 'turtle':
      return new TurtleBot(rng)
    case 'zoner':
      return new ZonerBot(rng)
    case 'throwloop':
      return new ThrowLoopBot(rng)
    case 'backwalk':
      return new BackWalkBot(rng)
    case 'pokeloop':
      return new PokeLoopBot(rng)
    case 'sweepspam':
      return new SweepSpamBot(rng)
    case 'fireball':
      return new FireballBot(rng)
    case 'fireball25':
      return new Fireball25Bot(rng)
    case 'throwtap':
      return new ThrowTapBot(rng)
    default:
      throw new Error(`unknown fighter bot "${kind as string}"`)
  }
}

export interface BotMatch {
  result: Result
  finalHash: string
  frames: number
}

const MAX_FRAMES = 40_000

/**
 * Plays one best-of-3 match between two bots with the env's decision rhythm (a decision every
 * FRAME_SKIP frames, none while the round is not in the FIGHT phase). Seat 0 is bots[0].
 */
/**
 * A bot that slips (people hands, A4): with probability `rate` per decision its answer is replaced by a uniformly random packed input.
 * Default off: a rate of 0 returns the bot itself, so every published measurement stays byte-identical. One draw per decision, always,
 * so the slip stream does not depend on what the bot did.
 */
export function withMistakes(bot: FighterBot, rate: number, rng: Rng): FighterBot {
  if (!(rate > 0)) return bot
  return {
    kind: bot.kind,
    act(obs) {
      const slip = rng.float() < rate
      const wrong = rng.int(N_ACTIONS)
      const a = bot.act(obs)
      return slip ? wrong : a
    },
  }
}

export function playBotMatch(seed: number, bots: [FighterBot, FighterBot], opts: { onDecision?: (packed: number) => void } = {}): BotMatch {
  const s = createState(seed)
  while (s.matchOver === 0 && s.frame < MAX_FRAMES) {
    if (s.phase !== PHASE.FIGHT) {
      stepPacked(s, 0, 0)
      continue
    }
    const packed = [0, 0]
    for (const k of [0, 1] as const) {
      const obs = buildObs(s, k)
      const a = bots[k].act(obs)
      opts.onDecision?.(a)
      const dir = viewDirToScreen(a % N_DIRS, obs.mirrored)
      packed[k] = (a - (a % N_DIRS)) + dir
    }
    for (let f = 0; f < FRAME_SKIP && s.matchOver === 0; f++) stepPacked(s, packed[0]!, packed[1]!)
  }
  const [a, b] = s.wins
  const winner = a > b ? 0 : b > a ? 1 : null
  return { result: { winner, score: [a, b], reason: s.matchOver === 1 ? 'rounds' : 'frame cap' }, finalHash: hashFighterState(s), frames: s.frame }
}
