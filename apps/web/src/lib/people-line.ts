import type { GameId, Level } from '@duelwise/core/src/product'
import type { Registry } from '@duelwise/agents/src/registry'

type PeopleBlock = NonNullable<Registry['measured'][Level]>['people']

/**
 * Real matches count only from this many matches and this many different players (the same bars as REAL_MIN_MATCHES and REAL_MIN_PLAYERS in
 * packages/agents/src/measure/people.ts; a test pins them equal). Not imported: that module reads files and must stay out of the web bundle.
 */
export const REAL_MIN_MATCHES = 40
export const REAL_MIN_PLAYERS = 10
const realCountsFor = (r: { n: number; players: number } | null | undefined): boolean => Boolean(r) && r!.n >= REAL_MIN_MATCHES && r!.players >= REAL_MIN_PLAYERS

/** "about 7", "about 8 or 9", "more than 9": a score out of ten, said the way a person says it. */
function inTens(score: number): string {
  if (score >= 0.93) return 'more than 9'
  const t = score * 10
  const lo = Math.floor(t)
  const f = t - lo
  if (Math.abs(f - 0.5) < 0.06) return `about ${lo} or ${lo + 1}`
  return `about ${f < 0.5 ? lo : lo + 1}`
}

/**
 * D10: what a level card may say about winning. Never a percentage, never "against people": the only source is the people block, which
 * is measured against test players that play like ordinary people, and the line says "in our tests". It appears only where the band was hit
 * ("tuned to win ...") or where luck holds a level under its band and the measured ceiling is published as such. A level off its band says nothing.
 * Real matches would earn a percentage only from 100 matches at the level; none do yet, so none is shown.
 */
export function peopleLine(people: PeopleBlock, game?: GameId): string | undefined {
  if (!people) return undefined
  if (game === 'chess' && !realCountsFor((people as { real?: { n: number; players: number } | null }).real)) return undefined
  if (people.verdict === 'in-band') return `Tuned to win ${inTens(people.calibrated)} in 10 against an average player in our tests.`
  if (people.verdict === 'ceiling') return `In our tests it wins ${inTens(people.calibrated)} in 10 against an average player, the most we could tune it to.`
  return undefined
}


/** True when the level's gate waived the scripted-bot bars because the people test sets it (Easy and Medium only; see peopleGated in the gate). */
export function isPeopleGated(reg: Registry, level: Level): boolean {
  return reg.versions.some((v) => {
    const gate = v.gate as { levels?: Record<string, { peopleGated?: unknown }> } | undefined
    return gate?.levels?.[level]?.peopleGated === true
  })
}

/**
 * How a realtime strength line ends its first sentence. A level whose card carries a people line is already "tuned" against test players, so
 * saying it is "not yet measured against people" would contradict that line: it says real players instead.
 */
export function notYetMeasuredText(reg: Registry, level: Level): string {
  return peopleLine(reg.measured[level]?.people, reg.game) !== undefined ? 'not yet measured against real players' : 'not yet measured against people'
}

/**
 * For a people-gated level, the bot it loses to and why that is fine. Said only when the measured weakest-bot interval sits wholly below one half
 * (the level really loses to it in most games); `words` names the bots in plain words. Empty when the level is not people-gated or the bot is unknown.
 */
export function peopleGatedSentence(reg: Registry, level: Level, words: Record<string, string>): string {
  const m = reg.measured[level]
  if (!m || !isPeopleGated(reg, level) || !(m.ci95[1] < 0.5)) return ''
  const bot = /scripted (\w+) bot/.exec(m.metric)?.[1]
  const name = bot ? words[bot] : undefined
  return name ? ` It loses to ${name} in most games; this level is set by the people test.` : ''
}
