import type { Level } from '@duelwise/core/src/product'
import type { Tally } from '../../server/stats'

export const LEVEL_NAME: Record<Level, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard', champion: 'Champion' }

/** A fraction as a percentage string. The suffix is added here so copy never carries a typed number. */
export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`
}

export function rate(t: Tally): number | null {
  return t.games > 0 ? t.wins / t.games : null
}

/** Whole-point change between two tallies, or null when either has no games. */
export function deltaPoints(now: Tally, before: Tally): number | null {
  const a = rate(now)
  const b = rate(before)
  return a === null || b === null ? null : Math.round((a - b) * 100)
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `-${Math.abs(n)}` : '0'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Oct 21", in UTC so the server and the browser agree. */
export function shortDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

export function compactCount(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)
}

/**
 * A measured value as the registry's metric implies: head-to-head scores and win rates are fractions
 * shown as percentages; anything else (for example average guesses) is a plain number.
 */
export function measuredText(metric: string, v: number): string {
  return /score vs|win rate|rate/i.test(metric) ? pct(v) : v.toFixed(2)
}

export function playerMetric(metric: string): string {
  return /score vs scripted/i.test(metric) ? 'score against a test opponent' : metric
}
