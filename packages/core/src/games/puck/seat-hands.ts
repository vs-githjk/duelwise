import { DelayedStates, HumanLimiter, LEVEL_LIMITS, UNLIMITED, type LimiterConfig } from '../../limiter'
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

/**
 * People profiles (Nov 10 retune, A3): how a beginner, an average and a strong person play air hockey in the browser. All three move the
 * rule mallet (speed 6, default acceleration); they differ in reaction delay, hand noise and how long a target is held. The noise and the
 * hold are the Medium, Hard and Champion levels' own numbers, so there is one table of hands, not a second one to drift.
 */
export const PEOPLE_PROFILES = ['beginner', 'average', 'strong'] as const
export type PeopleProfile = (typeof PEOPLE_PROFILES)[number]
const PEOPLE_HANDS_LEVEL = { beginner: 'medium', average: 'hard', strong: 'champion' } as const
const PEOPLE_DELAY_FRAMES = { beginner: 18, average: 15, strong: 12 } as const

export interface PeopleHands {
  delayFrames: number
  noiseSd: number
  minHoldFrames: number
}

export function peopleHands(profile: PeopleProfile): PeopleHands {
  const lv = PEOPLE_HANDS_LEVEL[profile]
  return { delayFrames: PEOPLE_DELAY_FRAMES[profile], noiseSd: LEVEL_MALLET[lv].targetNoise, minHoldFrames: LEVEL_LIMITS.puck[lv].minHoldFrames }
}

/** The level whose noise and hold a profile uses (the measurement's bot agents take a level for these). */
export const peopleHandsLevel = (profile: PeopleProfile): Level => PEOPLE_HANDS_LEVEL[profile]

/** Scripted bots a people profile can drive, in sentinel order. The mouse is the stand-in for a person; the rest are the league's bots. */
export const PEOPLE_BOT_KINDS = ['mouse', 'striker', 'goalie', 'banker', 'shadow'] as const
export type PeopleBotKind = (typeof PEOPLE_BOT_KINDS)[number]
/** The env's action sentinel (first head) for a scripted bot on a people profile: -1 - (16 * (profile index + 1) + kind index). Plain bots keep -1 - index (< 16). */
export function peopleSentinel(kind: PeopleBotKind, profile: PeopleProfile): number {
  return -1 - (16 * (PEOPLE_PROFILES.indexOf(profile) + 1) + PEOPLE_BOT_KINDS.indexOf(kind))
}

export class SeatHands {
  limiter: HumanLimiter
  readonly noise: Rng
  readonly botSeed: number
  noiseSd: number
  private readonly cfg: LimiterConfig
  private readonly bots: Array<PuckBot | undefined> = []

  /** `k` is the seat (0 or 1); each seat gets its own streams so two seats never share a draw. */
  constructor(seed: number, readonly k: 0 | 1, level: Level | undefined) {
    this.cfg = level ? LEVEL_LIMITS.puck[level] : UNLIMITED
    this.limiter = new HumanLimiter(this.cfg, makeRng((seed + 7919 * (k + 1)) >>> 0))
    this.noise = makeRng((seed + 15485863 * (k + 1)) >>> 0)
    this.botSeed = (seed + 104729 * (k + 1)) >>> 0
    this.noiseSd = level ? LEVEL_MALLET[level].targetNoise : 0
  }

  /**
   * Gives the seat a person's hands (people profile): the profile's noise and hold, with the level's own view delay kept so the seat's
   * recorded views stay readable. Training env only, before the seat's first input.
   */
  usePeopleHands(profile: PeopleProfile, seed: number): void {
    const h = peopleHands(profile)
    this.noiseSd = h.noiseSd
    this.limiter = new HumanLimiter({ ...this.cfg, minHoldFrames: h.minHoldFrames }, makeRng((seed + 7919 * (this.k + 1)) >>> 0))
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
