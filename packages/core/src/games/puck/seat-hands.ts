import { DelayedStates, HumanLimiter, LEVEL_LIMITS, UNLIMITED } from '../../limiter'
import type { Level } from '../../product'
import { makeRng } from '../../rng'
import type { Rng } from '../../types'
import { ALL_BOT_KINDS, createBot, type PuckBot, type PuckBotKind } from './bots'
import { GRID, LEVEL_MALLET, NO_INPUT } from './constants'
import { noise } from './encode'
import { unitToCell } from './input'
import { blankState, copyState, type PuckState } from './state'

// The one definition of how a seat's hands work, shared by the training env (env.ts) and the page match
// (apps/web/src/games/puck/loop.ts) so they cannot drift: the bot reaction delay rule, the target noise stream,
// the limiter stream, the bot seed, and the noise -> cell -> limiter step that turns a target into a mallet input.

/** Frames a scripted bot's view lags: the level's delay below Champion; 0 at Champion and with no level unless `championBotDelay` says otherwise (R15). */
export function botDelayFor(level: Level | undefined, championBotDelay = 0): number {
  if (level === undefined) return 0
  return level === 'champion' ? championBotDelay : LEVEL_LIMITS.puck[level].delayFrames
}

/** The history a delayed bot reads, or undefined when its delay is 0. */
export function botHistory(delay: number): DelayedStates<PuckState> | undefined {
  return delay > 0 ? new DelayedStates<PuckState>(delay, blankState, copyState) : undefined
}

export class SeatHands {
  readonly limiter: HumanLimiter
  readonly noise: Rng
  readonly botSeed: number
  readonly noiseSd: number
  private readonly bots: Array<PuckBot | undefined> = []

  /** `k` is the seat (0 or 1); each seat gets its own streams so two seats never share a draw. */
  constructor(seed: number, readonly k: 0 | 1, level: Level | undefined) {
    this.limiter = new HumanLimiter(level ? LEVEL_LIMITS.puck[level] : UNLIMITED, makeRng((seed + 7919 * (k + 1)) >>> 0))
    this.noise = makeRng((seed + 15485863 * (k + 1)) >>> 0)
    this.botSeed = (seed + 104729 * (k + 1)) >>> 0
    this.noiseSd = level ? LEVEL_MALLET[level].targetNoise : 0
  }

  /** The seat's scripted bot at an ALL_BOT_KINDS index, created once. */
  botAt(index: number): PuckBot {
    return (this.bots[index] ??= createBot(ALL_BOT_KINDS[index] as PuckBotKind, this.botSeed + index))
  }

  bot(kind: PuckBotKind): PuckBot {
    return this.botAt(ALL_BOT_KINDS.indexOf(kind))
  }

  /** A target (0..1 each axis, in the seat's own half) -> the level's hand noise -> a cell code -> the limiter. Returns the mallet input code, NO_INPUT while nothing is held. */
  act(ux: number, uy: number, frame: number): number {
    if (this.noiseSd > 0) {
      ux += noise(this.noise) * this.noiseSd
      uy += noise(this.noise) * this.noiseSd
    }
    const code = unitToCell(ux) + GRID * unitToCell(uy)
    // The limiter holds [direction channel, button channel]; the first channel is the target code plus one (0 is "none yet").
    const held = this.limiter.act([code + 1, 0], frame)
    return held[0] === 0 ? NO_INPUT : held[0]! - 1
  }
}
