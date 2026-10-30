import type { GameId } from '../product'
import type { MatchRecordV1 } from '../match-record'

/** Why a stored match may not feed training. One reason per match: the first rule that rejects it. */
export type RejectReason =
  | 'unfinished'
  | 'abandoned'
  | 'replay_invalid'
  | 'training_not_allowed'
  | 'too_short'
  | 'duplicate'
  | 'synthetic'
  | 'inhuman_timing'

export const REJECT_REASONS: readonly RejectReason[] = [
  'unfinished',
  'abandoned',
  'replay_invalid',
  'training_not_allowed',
  'too_short',
  'duplicate',
  'synthetic',
  'inhuman_timing',
]

/** What the filters see of one stored match: the database row plus its decoded record. */
export interface FilterRow {
  id: string
  game: GameId
  status: string
  recordValid: boolean | null
  trainingAllowed: boolean
  filterFlags: Record<string, unknown> | null
  /** The decoded match record, or null when the match never uploaded one. */
  record: MatchRecordV1 | null
}

export type FilterResult = { ok: true } | { ok: false; reason: RejectReason; detail: string }

/** State shared across one pass over many rows (duplicate detection). */
export interface FilterContext {
  seen: Set<string>
}

export const newFilterContext = (): FilterContext => ({ seen: new Set() })

export const reject = (reason: RejectReason, detail: string): FilterResult => ({ ok: false, reason, detail })
export const PASS: FilterResult = { ok: true }

const flag = (row: FilterRow, key: string): boolean => row.filterFlags?.[key] === true

const SYNTHETIC_ID = /^(synthetic|test|dev|fixture|bot)[-_:]/i

/**
 * Rules every game shares, in order: the match must be finished with a record, not abandoned or resigned,
 * replay-verified, allowed by its player (the row and the record agree), and not synthetic (made by a test,
 * a dev tool or a bot rather than played by a person).
 */
export function commonFilter(row: FilterRow): FilterResult {
  if (row.status === 'started' || !row.record) return reject('unfinished', row.record ? `status ${row.status}` : 'no record uploaded')
  if (row.status === 'abandoned' || row.status === 'resigned' || flag(row, 'abandoned') || flag(row, 'resigned')) {
    return reject('abandoned', `status ${row.status}`)
  }
  if (row.status !== 'finished') return reject('unfinished', `status ${row.status}`)
  if (row.recordValid !== true) return reject('replay_invalid', row.recordValid === null ? 'never replay-checked' : 'did not replay')
  if (!row.trainingAllowed || !row.record.trainingAllowed) return reject('training_not_allowed', 'the player did not allow training')
  if (flag(row, 'synthetic') || flag(row, 'dev') || SYNTHETIC_ID.test(row.record.matchId) || SYNTHETIC_ID.test(row.id)) {
    return reject('synthetic', 'made by a test, dev tool or bot')
  }
  return PASS
}

/** A stable key for "the same match uploaded twice": game, seed, seat and every action. */
export function duplicateKey(r: MatchRecordV1): string {
  return `${r.game}|${r.seed}|${r.humanSeat}|${r.actions.map((a) => a.join(',')).join(';')}`
}

/** Rejects a match whose key was seen before in this pass; remembers the key otherwise. */
export function duplicateFilter(row: FilterRow, ctx: FilterContext): FilterResult {
  const key = duplicateKey(row.record!)
  if (ctx.seen.has(key)) return reject('duplicate', 'same seed and actions as an earlier match')
  ctx.seen.add(key)
  return PASS
}

export const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length === 0 ? NaN : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
