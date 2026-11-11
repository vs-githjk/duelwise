import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { GOALS_TO_WIN, LEVEL_MALLET, RULE_MALLET_SPEED } from '@duelwise/core/src/games/puck/constants'
import type { Level } from '@duelwise/core/src/product'
import type { Result } from '@duelwise/core/src/types'
import type { Registry } from '@duelwise/agents/src/registry'
import { playedModel } from '@duelwise/agents/src/puck/models'
import { personaFor, styleLine } from '../../personas'
import { LEVEL_LABEL } from '../../lib/level-info'
import { notYetMeasuredText, peopleGatedSentence } from '../../lib/people-line'
import { PRACTICE_COPY, agentVersionFor, isPublished, reactionText } from '../fighter/strength'

// What the Glasscut page says about an opponent's strength. It says what was measured, in plain words, and only for a level the
// registry publishes; every other level is "In training" with the reason on record. The shared parts (published?, the version a
// record carries, the practice line) are the fighter's.

export { PRACTICE_COPY, agentVersionFor, isPublished }

/** Shown under the level picker whenever a level in training is listed. */
export const PRACTICE_PICKER_NOTE = 'Levels in training have not passed our strength test.'

/** The test bots, by the name the gate writes (a kind or a role), in words a player can picture. */
const BOT_WORDS: Record<string, string> = {
  random: 'the random bot',
  striker: 'the rush bot',
  rush: 'the rush bot',
  goalie: 'the goalie bot',
  turtle: 'the goalie bot',
  banker: 'the bank-shot bot',
  bank: 'the bank-shot bot',
  shadow: 'the shadow bot',
}

export const delayMsFor = (level: Level): number => Math.round((LEVEL_LIMITS.puck[level].delayFrames * 1000) / 60)

/**
 * What an opponent cannot do at a level, from the same config the agent and the trainer use: how late it sees the table and how fast
 * its mallet moves. Your mallet is capped at the rule speed too, so Sable is described as matching it, not as capped below it.
 */
export function limitsText(level: Level): string {
  const speed = LEVEL_MALLET[level].speed
  const hands = speed >= RULE_MALLET_SPEED ? 'Its mallet is as fast as yours.' : `Its mallet moves at most ${speed} table widths a second; yours moves up to ${RULE_MALLET_SPEED}.`
  return `${reactionText(delayMsFor(level))}. ${hands}`
}

/** A level counts as a near miss when its Wilson lower bound is within this of the bar (Marlow: .8978 against .90). */
const NEAR_MISS = 0.02

/** Whether the champion version's gate used bots that see the live game with no reaction delay (outcome A), read from the registry. */
function botsSeeLivePuck(reg: Registry, level: Level): boolean {
  return reg.versions.some((v) => {
    const gate = v.gate as { levels?: Record<string, { botLimits?: unknown }> } | undefined
    return gate?.levels?.[level]?.botLimits === 'live'
  })
}

/**
 * The last strength test's recorded failure for a level in training, as one calm sentence, or null when none is on record. One clause
 * per bot, from its worst seat. Far below the bar it says plainly how many games were won; the confidence-threshold sentence is kept
 * for a near miss only.
 */
export function practiceResult(reg: Registry | null, level: Level): string | null {
  if (!reg || isPublished(reg, level)) return null
  const reason = reg.unpublished?.[level]
  if (!reason) return null
  const worst = new Map<string, { wins: number; n: number; lower: number; bar: number }>()
  for (const m of reason.matchAll(/(\w+): (\d+) of (\d+), Wilson lower bound ([\d.]+) on seat \d is below ([\d.]+)/g)) {
    const bot = BOT_WORDS[m[1]!]
    if (!bot) continue
    const row = { wins: Number(m[2]), n: Number(m[3]), lower: Number(m[4]), bar: Number(m[5]) }
    const seen = worst.get(bot)
    if (!seen || row.lower < seen.lower) worst.set(bot, row)
  }
  if (worst.size === 0) return null
  const rows = [...worst.entries()]
  const list = (xs: string[]): string => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]!)
  if (rows.every(([, r]) => r.bar - r.lower <= NEAR_MISS)) {
    return `Last test: it beat ${list(rows.map(([bot, r]) => `${bot} in ${r.wins} of ${r.n} games`))}, just short of the bar. That did not clear the confidence threshold for publication.`
  }
  const lead = `Last test: it won ${list(rows.map(([bot, r]) => `${r.wins} of ${r.n} against ${bot}`))}.`
  if (level !== 'champion' || !botsSeeLivePuck(reg, level)) return lead
  return `${lead} Those bots see the live puck with no reaction delay; ${personaFor(level).name} reacts at ${delayMsFor(level)} ms.`
}

/** Whether a level's gate ran its bots on the human seat's rule mallet (the Nov 10 human-hands gate), read from the registry. */
function botsHaveYourHands(reg: Registry, level: Level): boolean {
  return reg.versions.some((v) => {
    const gate = v.gate as { levels?: Record<string, { botLimits?: unknown }> } | undefined
    return gate?.levels?.[level]?.botLimits === 'human-hands'
  })
}

/** Pip in training: a script, so the In training line says what it is rather than calling it an early version. */
export const SCRIPTED_PRACTICE_COPY = 'In training: a simple script for learning the controls; it has not passed our strength test.'

/** "Beats our test bots in at least 6 of 10 games, including the bank-shot bot; not yet measured against people." (real players when the card has a people line) */
export function strengthLine(reg: Registry | null, level: Level): string {
  const m = reg?.measured[level]
  if (!reg?.levels[level] || !m) return reg?.unpublishedConfig?.[level]?.scripted === true ? SCRIPTED_PRACTICE_COPY : PRACTICE_COPY
  const atLeast = Math.max(0, Math.min(10, Math.floor(m.ci95[0] * 10 + 1e-9)))
  const bot = /scripted (\w+) bot/.exec(m.metric)?.[1]
  const close = bot && BOT_WORDS[bot] ? `, including ${BOT_WORDS[bot]}` : ''
  const bots = botsHaveYourHands(reg, level) ? 'our test bots, whose mallets are as fast as yours,' : 'our test bots'
  return `Beats ${bots} in at least ${atLeast} of 10 games${close}; ${notYetMeasuredText(reg, level)}.${peopleGatedSentence(reg, level, BOT_WORDS)}`
}

export interface AgentCard {
  /** "Marlow, Medium". */
  title: string
  training: boolean
  /** The measured line, or the In training line. */
  strength: string
  /** Why it is still in training, from the registry, or null. */
  why: string | null
  limits: string
  /** How it plays, and whether it is hand-written or trained. Null while In training: the line (Marlow shares Vesper's network) describes a build that may not exist yet. */
  style: string | null
}

export function agentCard(reg: Registry | null, level: Level): AgentCard {
  const published = isPublished(reg, level)
  return {
    title: `${personaFor(level).name}, ${LEVEL_LABEL[level]}`,
    training: !published,
    strength: strengthLine(reg, level),
    // Only for a level that plays the network the test measured; a level on the preview network has no test of its own on record.
    why: reg && !playedModel(reg, level).measured ? null : practiceResult(reg, level),
    limits: limitsText(level),
    style: published ? styleLine(level, 'puck') : null,
  }
}

/** How the match ended, as the result panel's reason. The score is not repeated: the result chip beside it already shows it. */
export function resultReason(r: Result, _humanSeat: 0 | 1 = 0): string {
  switch (r.reason) {
    case 'goals':
      return `First to ${GOALS_TO_WIN}`
    case 'time':
      return 'Time was up'
    case 'sudden':
      return 'Level at time, the next goal won it'
    case 'draw':
      return 'Still level at the hard cap'
    default:
      return ''
  }
}
