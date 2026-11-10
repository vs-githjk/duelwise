import type { Rng } from '../../types'
import { makeRng } from '../../rng'
import { MALLET_R, PUCK_R } from './constants'
import type { PuckObs } from './core'

// Scripted opponents for tests, league seeding and measurement. A bot sees what an agent sees: a PuckObs in its
// own view (it defends y = 0, the table runs to y = 2) with the puck and the other mallet delayed below
// Champion (the env decides), and answers with a point in its own half (x and y each 0..1). The env adds the
// level's target noise and the hold rule, so a bot is held to the same hands as an agent.

export type PuckBotKind = 'random' | 'striker' | 'goalie' | 'banker' | 'shadow' | 'pip' | 'mouse'
// Order matters: the env hands a seat to bot index i with the first action head = -1 - i, and the league
// trainer (league.py BOTS["puck"]) uses the first five in this order. New bots are appended, never inserted.
export const ALL_BOT_KINDS: readonly PuckBotKind[] = ['random', 'striker', 'goalie', 'banker', 'shadow', 'pip']
// The mouse is not in this list on purpose: the env and its pinned rollout fingerprints (and the Python league) index bots by this order,
// and the mouse is a measurement-only stand-in for a person (createBot builds it, no sentinel plays it).

export interface PuckBot {
  readonly kind: PuckBotKind
  /** A point in the bot's own half. The returned array is reused between calls. */
  act(obs: PuckObs): [number, number]
}

const HOME_Y = 0.22
const REACH = MALLET_R + PUCK_R
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Where a puck at (x, y) moving (vx, vy) will be in x when it reaches y = line, bouncing off the side walls. */
export function arrivalX(x: number, y: number, vx: number, vy: number, line: number): number {
  if (vy > -1e-6) return x
  const t = (line - y) / vy
  const w = 1 - 2 * PUCK_R
  const span = 2 * w
  let u = x + vx * t - PUCK_R
  u -= Math.floor(u / span) * span
  if (u > w) u = span - u
  return u + PUCK_R
}

/**
 * Line up behind the puck on the line from the puck to the aim point, then drive through it. Returns the target.
 * Inside the own half only; a puck against the goal line is hit from the side.
 */
function attack(o: PuckObs, aimX: number, aimY: number, out: [number, number]): [number, number] {
  const [px, py] = o.puck
  const [mx, my] = o.me
  let dx = aimX - px
  let dy = aimY - py
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < 1e-6) {
    dx = 0
    dy = 1
  } else {
    dx /= len
    dy /= len
  }
  const rx = mx - px
  const ry = my - py
  const along = rx * dx + ry * dy
  const side = Math.abs(rx * dy - ry * dx)
  if (along < -0.08 && side < 0.07) {
    // Behind it and on the line: go through the puck toward the aim.
    out[0] = clamp01(px + dx * 0.16)
    out[1] = clamp01(py + dy * 0.16)
  } else {
    out[0] = clamp01(px - dx * (REACH + 0.1))
    out[1] = clamp01(py - dy * (REACH + 0.1))
  }
  return out
}

function defend(o: PuckObs, x: number, out: [number, number]): [number, number] {
  out[0] = clamp01(x)
  out[1] = HOME_Y
  return out
}

abstract class Base implements PuckBot {
  abstract readonly kind: PuckBotKind
  protected readonly out: [number, number] = [0.5, HOME_Y]
  abstract act(obs: PuckObs): [number, number]
}

class RandomBot extends Base {
  readonly kind = 'random' as const
  constructor(private readonly rng: Rng) {
    super()
  }
  act(): [number, number] {
    this.out[0] = this.rng.float()
    this.out[1] = this.rng.float()
    return this.out
  }
}

/** Rushes every puck in its half and shoots at the post farthest from the keeper; blocks a fast shot coming straight at it. */
class StrikerBot extends Base {
  readonly kind = 'striker' as const
  act(o: PuckObs): [number, number] {
    const [px, py, pvx, pvy] = o.puck
    if (py >= 1) return defend(o, 0.5 + (px - 0.5) * 0.4, this.out)
    if (pvy < -2.2) return defend(o, arrivalX(px, py, pvx, pvy, HOME_Y), this.out)
    // Aim at the post farther from the keeper, just inside the mouth (the mouth is 0.34 wide around x = 0.5).
    return attack(o, o.them[0] < 0.5 ? 0.6 : 0.4, 2, this.out)
  }
}

/** Slides along its goal line with the puck. Steps out only to clear a slow puck close to the goal. */
class GoalieBot extends Base {
  readonly kind = 'goalie' as const
  act(o: PuckObs): [number, number] {
    const [px, py, pvx, pvy] = o.puck
    const slow = pvx * pvx + pvy * pvy < 0.6
    if (py < 0.6 && slow) return attack(o, px, 2, this.out)
    if (py < 1 && pvy < -0.3) return defend(o, arrivalX(px, py, pvx, pvy, HOME_Y), this.out)
    return defend(o, 0.5 + (px - 0.5) * 0.7, this.out)
  }
}

/** Like the striker but aims at the far side wall so the puck banks into the goal. Picks the wall away from the keeper. */
class BankerBot extends Base {
  readonly kind = 'banker' as const
  private wall = 0
  constructor(private readonly rng: Rng) {
    super()
  }
  act(o: PuckObs): [number, number] {
    const [px, py, pvx, pvy] = o.puck
    if (py >= 1) {
      // Choose the wall for the next shot while the puck is away.
      const k = o.them[0]
      this.wall = k < 0.42 ? 1 : k > 0.58 ? 0 : this.rng.int(2)
      return defend(o, 0.5 + (px - 0.5) * 0.4, this.out)
    }
    if (pvy < -2.2) return defend(o, arrivalX(px, py, pvx, pvy, HOME_Y), this.out)
    // The goal mirrored across the wall: a straight line at it bounces once and ends in the mouth.
    return attack(o, this.wall === 0 ? -0.5 : 1.5, 2, this.out)
  }
}

/**
 * A keeper that learns the opponent's habit: it counts the lanes the opponent shoots down (left bank, straight,
 * right bank, by the angle the puck leaves with) and stands where the most used lane arrives. Clears slow pucks.
 */
class ShadowBot extends Base {
  readonly kind = 'shadow' as const
  private readonly count = [1, 1, 1]
  private readonly arrive = [0.25, 0.5, 0.75]
  private lastVy = 0
  act(o: PuckObs): [number, number] {
    const [px, py, pvx, pvy] = o.puck
    // A shot: the puck was not heading at me last decision and now it is, fast, from the opponent's half.
    if (py > 1 && pvy < -1.5 && this.lastVy > -0.5) {
      const lane = pvx / -pvy < -0.35 ? 0 : pvx / -pvy > 0.35 ? 2 : 1
      this.count[lane]!++
      const ax = arrivalX(px, py, pvx, pvy, 0)
      this.arrive[lane] = this.arrive[lane]! * 0.7 + ax * 0.3
    }
    this.lastVy = pvy
    const slow = pvx * pvx + pvy * pvy < 0.6
    if (py < 0.6 && slow) return attack(o, 0.5, 2, this.out)
    if (py < 1 && pvy < -0.3) return defend(o, arrivalX(px, py, pvx, pvy, HOME_Y), this.out)
    let best = 1
    if (this.count[0]! > this.count[best]!) best = 0
    if (this.count[2]! > this.count[best]!) best = 2
    return defend(o, this.arrive[best]!, this.out)
  }
}

/**
 * Easy's scripted policy, Pip: a beginner. It tracks the puck's x on defence and hits toward the middle of the goal
 * when the puck is slow on its side. It plays like a beginner on purpose, and the flaws are the part a player can learn:
 * - one habit: every shot goes at the middle of the goal, never at a corner;
 * - late reactions: it only reads a shot once the puck is in its half, and half the time it keeps its old guess;
 * - misses: now and then a swing at a slow puck is a hand's width off.
 * It never reads the score. The returned point is in its own half, like every bot's.
 */
const PIP_HOME_Y = 0.12
const PIP_SHOT_SPEED = 0.4
const PIP_LEAN = 0.3
const PIP_ATTACK_Y = 0.75
const PIP_SEES_SHOT_Y = 0.8
const PIP_REACT = 0.5
const PIP_MISS = 0.4
const PIP_MISS_BY = 0.12

class PipBot extends Base {
  readonly kind = 'pip' as const
  private guess = 0.5
  private offBy = 0
  private swinging = false
  constructor(private readonly rng: Rng) {
    super()
  }
  act(o: PuckObs): [number, number] {
    const [px, py, pvx, pvy] = o.puck
    const out = this.out
    out[1] = PIP_HOME_Y
    // Far end, drifting away, or slow out past the middle of its half: stand in front of the goal, leaning toward the puck.
    if (py >= 1 || pvy > PIP_SHOT_SPEED || (pvy >= -PIP_SHOT_SPEED && py > PIP_ATTACK_Y)) {
      this.swinging = false
      this.guess = clamp01(0.5 + (px - 0.5) * PIP_LEAN)
      out[0] = this.guess
      return out
    }
    // A shot coming at the goal: meet it where it will arrive, but only once it is in this half and only some of the time.
    if (pvy < -PIP_SHOT_SPEED) {
      this.swinging = false
      if (py < PIP_SEES_SHOT_Y && this.rng.float() < PIP_REACT) this.guess = arrivalX(px, py, pvx, pvy, PIP_HOME_Y)
      out[0] = clamp01(this.guess)
      return out
    }
    // Slow on this side: hit it toward the middle of the goal. A fresh swing is sometimes off to one side.
    if (!this.swinging) {
      this.swinging = true
      this.offBy = this.rng.float() < PIP_MISS ? (this.rng.float() < 0.5 ? -PIP_MISS_BY : PIP_MISS_BY) : 0
    }
    attack(o, 0.5, 2, out)
    out[0] = clamp01(out[0] + this.offBy)
    return out
  }
}

/**
 * A scripted stand-in for a good person at a mouse (the judge's driver went 1-1 against Vesper with 180 ms of delay). It has no
 * hands of its own: the measurement gives it the rule mallet and about 11 frames of reaction (MOUSE_DELAY_FRAMES). It never reads the score.
 * - a fast shot at its goal: meet it where it arrives (bounces included), in front of the goal;
 * - the puck in its half and slow enough to play: line up behind it and drive through it at the open side of the goal
 *   (the post the keeper is farther from, just inside the mouth);
 * - the puck away: wait in front of the goal, leaning with the puck.
 */
export const MOUSE_DELAY_FRAMES = 11
class MouseBot extends Base {
  readonly kind = 'mouse' as const
  act(o: PuckObs): [number, number] {
    const [px, py, pvx, pvy] = o.puck
    if (py >= 1) return defend(o, 0.5 + (px - 0.5) * 0.5, this.out)
    if (pvy < -2.2) return defend(o, arrivalX(px, py, pvx, pvy, HOME_Y), this.out)
    return attack(o, o.them[0] < 0.5 ? 0.58 : 0.42, 2, this.out)
  }
}

export function createBot(kind: PuckBotKind, seed: number): PuckBot {
  switch (kind) {
    case 'random':
      return new RandomBot(makeRng(seed >>> 0))
    case 'striker':
      return new StrikerBot()
    case 'goalie':
      return new GoalieBot()
    case 'banker':
      return new BankerBot(makeRng(seed >>> 0))
    case 'shadow':
      return new ShadowBot()
    case 'pip':
      return new PipBot(makeRng((seed ^ 0x9e3779b9) >>> 0))
    case 'mouse':
      return new MouseBot()
  }
}
