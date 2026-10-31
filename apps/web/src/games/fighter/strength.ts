import type { Level } from '@duelwise/core/src/product'
import type { Registry } from '@duelwise/agents/src/registry'

// What the fighter page says about an agent's strength (R30). It used to print "site Elo 2768", a number with no
// unit a player can read, anchored to levels that are not published. Now it says what was measured, in plain words,
// and only for a level the registry publishes.

/** R32: shown for every level the registry does not publish. The level stays playable; it carries no Elo or strength number. */
export const PRACTICE_COPY = 'In training: an early version that has not passed our strength test yet.'

/**
 * How a reaction delay compares to a person, in words a player can check: the AI is made to wait before it reacts, a handicap, not a head start.
 * A simple reaction takes most people about 200 to 300 ms, so 200 is a sharp human and under 150 is faster than a person can react.
 */
export function reactionText(ms: number): string {
  const how = ms >= 250 ? 'like an average person' : ms >= 200 ? 'like a sharp human' : ms >= 150 ? 'quicker than most people' : 'faster than a person can react'
  return `Waits ${ms} ms before reacting, ${how}`
}

export function isPublished(reg: Registry | null, level: Level): boolean {
  return Boolean(reg?.levels[level]) && Boolean(reg?.measured[level])
}

/** Plain words for the gate bots, used to say which one was the closest call. */
const BOT_WORDS: Record<string, string> = {
  rushdown: 'the rushdown bot',
  turtle: 'the turtle bot',
  random: 'the random bot',
  zoner: 'the hold-back fireball bot',
  throwloop: 'the bot that repeatedly throws',
  backwalk: 'the bot that backs away',
  pokeloop: 'the crouch-poke bot',
  sweepspam: 'the sweep-spam bot',
  fireball: 'the range-fireball bot',
  throwtap: 'the throw-tap bot',
  fireball25: 'the fast hold-back fireball bot',
}

/**
 * LC1 (tinderbox-r3): what the last strength test measured for a Practice level, in the registry's own words ("throwtap: 235 of 400, ...").
 * Only the bots the test lost on are named; a level with no recorded failure gets no sentence, so the page never invents a result.
 */
export function practiceResult(reg: Registry | null, level: Level): string | null {
  if (!reg || isPublished(reg, level)) return null
  const reason = reg.unpublished?.[level]
  if (!reason) return null
  const lost = [...reason.matchAll(/(\w+): (\d+) of (\d+),/g)].filter((m) => BOT_WORDS[m[1]!])
  const seats = [...reason.matchAll(/(\w+) on seat ([01]): (\d+) wins, (\d+) draws of (\d+)/g)].filter((m) => BOT_WORDS[m[1]!])
  const hardLoss = /champion does not beat hard/i.test(reason)
  if (lost.length === 0 && seats.length === 0) return hardLoss ? 'Last test: it did not beat Hard head to head.' : null
  const parts = lost.map((m) => `${BOT_WORDS[m[1]!]} in ${m[2]} of ${m[3]} games`)
  const results = [
    ...(parts.length ? [`it beat ${parts.join(' and ')}`] : []),
    ...seats.map((m) => `against ${BOT_WORDS[m[1]!]} on seat ${m[2]}, it won ${m[3]} and drew ${m[4]} of ${m[5]} games`),
  ]
  return `Last test: ${results.join('; ')}. The results did not clear the confidence threshold for publication.${hardLoss ? ' It did not beat Hard head to head.' : ''}`
}

/** The gate bot a published level's measured metric names as its weakest, in plain words, or null. */
function weakestBotWords(metric: string): string | null {
  const bot = /scripted (\w+) bot/.exec(metric)?.[1]
  return bot ? (BOT_WORDS[bot] ?? null) : null
}

/** True when the registry's ladder says Champion beat Hard head to head with a lower bound above one half. */
function championBeatsHard(reg: Registry): boolean {
  const ladder = (reg.versions[0]?.gate as { ladder?: { pairs?: Array<{ lower: string; upper: string; lowerBound: number }> } } | undefined)?.ladder
  return Boolean(ladder?.pairs?.some((p) => p.lower === 'hard' && p.upper === 'champion' && p.lowerBound > 0.5))
}

/**
 * "Beats our test bots in at least 6 of 10 games, including loop tricks; not yet measured against people."
 * The 6 is the lower end of the 95 percent interval of the weakest gate bot, rounded down to a whole game of ten.
 */
export function strengthLine(reg: Registry | null, level: Level): string {
  const m = reg?.measured[level]
  if (!reg?.levels[level] || !m) return PRACTICE_COPY
  const atLeast = Math.max(0, Math.min(10, Math.floor(m.ci95[0] * 10 + 1e-9)))
  const weakest = weakestBotWords(m.metric)
  const close = weakest ? ` Its closest call was ${weakest}.` : ''
  const vsHard = level === 'champion' && championBeatsHard(reg) ? ' It also beats Hard head to head.' : ''
  return `Beats our test bots in at least ${atLeast} of 10 games, including loop tricks; not yet measured against people.${close}${vsHard}`
}

/**
 * What an agent's limits mean for the player, from the same config the agent runs on. Champion has no action cap, so it must
 * not be described as capped: it is limited by its reaction delay only.
 */
export function limitsExplainer(delayMs: number, apmCap: number | null): string {
  return apmCap === null
    ? `It sees the match ${delayMs} ms late and has no limit on how fast it presses, so its reaction delay is its only handicap.`
    : `It sees the match ${delayMs} ms late and presses at most ${apmCap} actions a minute.`
}

/** The agent version a match record carries: the registry's version for a published level, else "preview". */
export function agentVersionFor(reg: Registry | null, level: Level): string {
  return reg?.levels[level]?.version ?? 'preview'
}
