import { LEVEL_LIMITS } from '@duelwise/core/src/limiter.ts'
import type { Level } from '@duelwise/core/src/product'
import type { Registry } from '@duelwise/agents/src/registry'
import { PRACTICE_COPY, agentVersionFor, isPublished } from '../fighter/strength'

// What the Coldstore page says about an agent's strength (R30). It used to print "site Elo 1091", a number with no unit
// a player can read, resting on a gate whose bots could not aim. Now it says what was measured, in plain words, and only
// for a level the registry publishes. The shared parts (published?, the version a record carries) are the fighter's.

export { PRACTICE_COPY, agentVersionFor, isPublished }

/**
 * "Beats our test bots in at least 6 of 10 games, including ones that peek, strafe and hold an angle; not yet measured against people."
 * The 6 is the lower end of the 95 percent interval of the weakest gate bot, rounded down to a whole game of ten.
 */
export function strengthLine(reg: Registry | null, level: Level): string {
  const m = reg?.measured[level]
  if (!reg?.levels[level] || !m) {
    if (level === 'easy') return 'Practice: not yet measured. Easy reacts slower.'
    if (level === 'medium') return 'Practice: not yet measured. Plays stronger than Easy.'
    if (level === 'hard') return 'Practice: not yet measured. Plays at Hard difficulty.'
    return PRACTICE_COPY
  }
  const atLeast = Math.max(0, Math.min(10, Math.floor(m.ci95[0] * 10 + 1e-9)))
  return `Beats our test bots in at least ${atLeast} of 10 games, including ones that peek, strafe and hold an angle; not yet measured against people.`
}

/** Shown under the level picker whenever a Practice level is listed: the ladder above Easy is not measured. */
export const PRACTICE_PICKER_NOTE = 'Practice levels have not passed our strength test.'

/** "1 headshot", "0 headshots". */
export const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/** What an agent cannot do at a level, built from the same limiter config the agent and the trainer use, so Champion is never called capped. */
export function limitsSentence(level: Level): string {
  const c = LEVEL_LIMITS.arena[level]
  if (level === 'easy') return 'Easy reacts slower and has limited aim and actions. It sees only what its line of sight allows.'
  const ms = Math.round((c.delayFrames * 1000) / 60)
  const cap = c.apmCap === null || c.apmCap === undefined ? null : `cannot press more than ${c.apmCap} actions a minute`
  const aim = c.aimRateDegPerSec === null || c.aimRateDegPerSec === undefined ? null : `cannot turn faster than ${c.aimRateDegPerSec} degrees a second`
  const has = [cap, aim].filter((x): x is string => x !== null)
  const tail = has.length === 2 ? `, ${has[0]} and ${has[1]}` : has.length === 1 ? ` and ${has[0]}` : ''
  if (has.length === 0) return `It sees the match ${ms} ms late. It has no action cap and no aim limit. It sees only what its line of sight allows.`
  return `It sees the match ${ms} ms late${tail}. It sees only what its line of sight allows.`
}

/** What the page shows for a level's limits, from the same config the agent and the trainer use. */
export function limitsText(level: Level): string {
  const c = LEVEL_LIMITS.arena[level]
  const ms = Math.round((c.delayFrames * 1000) / 60)
  const aim = c.aimRateDegPerSec === null || c.aimRateDegPerSec === undefined ? 'no aim limit' : `turns at most ${c.aimRateDegPerSec} degrees a second`
  return `Reacts in ${ms} ms, ${c.apmCap === null ? 'no action cap' : `at most ${c.apmCap} actions a minute`}, ${aim}`
}
