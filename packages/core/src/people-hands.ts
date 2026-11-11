import type { LimiterConfig } from './limiter'

// People profiles for the fighter (Tinderbox) and the arena (Coldstore), Nov 10 retune (A4). A test player is a scripted bot that plays with
// a person's hands instead of the tested level's: a reaction delay, an input rate cap, a minimum hold, (arena) a turn rate and aim noise, and a
// wrong-input rate. They follow the air hockey profiles (games/puck/seat-hands.ts): a beginner reacts 18 frames (300 ms) late, an average person
// 15 (250 ms), a strong person 12 (200 ms), and each takes its input cap, hold and aim from the next level up the ladder (Medium, Hard, then no cap).
// The arena's average person aims 400 deg/s, the same as the existing human-proxy bot (HUMAN_PROXY_LIMITS).
// The wrong-input rate is the share of decisions that become a random input (a slip, a mashed key): 10%, 5% and 2%. These numbers are builder
// choices, stated here so a reviewer can argue with them; the estimate carries them in its plain descriptions (proxies).

export const PEOPLE_PROFILES = ['beginner', 'average', 'strong'] as const
export type PeopleProfile = (typeof PEOPLE_PROFILES)[number]

export const PEOPLE_DELAY_FRAMES: Record<PeopleProfile, number> = { beginner: 18, average: 15, strong: 12 }
export const PEOPLE_MISTAKE_RATE: Record<PeopleProfile, number> = { beginner: 0.1, average: 0.05, strong: 0.02 }

/** The fighter's hands for a profile: its reaction delay, presses per minute cap and minimum hold. */
export const FIGHTER_PEOPLE_LIMITS: Record<PeopleProfile, LimiterConfig> = {
  beginner: { delayFrames: 18, apmCap: 160, minHoldFrames: 6, buttonBits: false },
  average: { delayFrames: 15, apmCap: 240, minHoldFrames: 4, buttonBits: false },
  strong: { delayFrames: 12, apmCap: null, minHoldFrames: 1, buttonBits: false },
}

/** The arena's hands for a profile: the same plus a turn rate (deg/s) and aim noise (deg). */
export const ARENA_PEOPLE_LIMITS: Record<PeopleProfile, LimiterConfig> = {
  beginner: { delayFrames: 18, apmCap: 160, minHoldFrames: 6, aimRateDegPerSec: 220, aimNoiseDeg: 4, buttonBits: true },
  average: { delayFrames: 15, apmCap: 240, minHoldFrames: 4, aimRateDegPerSec: 400, aimNoiseDeg: 1.5, buttonBits: true },
  strong: { delayFrames: 12, apmCap: null, minHoldFrames: 1, aimRateDegPerSec: 540, aimNoiseDeg: 0, buttonBits: true },
}

/**
 * The env's action sentinel (first head) for a scripted bot on a people profile: -1 - (16 * (profile index + 1) + kind index), where the kind
 * index is the game's bot order (FIGHTER_BOT_KINDS, ARENA_BOT_KINDS). Plain sentinels are -1 - index with index below 16. The trainer's
 * league.py builds the same number from the same table.
 */
export const peopleSentinelIndex = (profile: PeopleProfile, kindIndex: number): number => 16 * (PEOPLE_PROFILES.indexOf(profile) + 1) + kindIndex
export const isPeopleSentinelIndex = (index: number): boolean => index >= 16

/** A people sentinel index back to its profile and kind index, or null when it names neither. */
export function decodePeopleSentinel(index: number, kindCount: number): { profile: PeopleProfile; kind: number } | null {
  const profile = PEOPLE_PROFILES[(index >> 4) - 1]
  const kind = index & 15
  return profile === undefined || kind >= kindCount ? null : { profile, kind }
}
