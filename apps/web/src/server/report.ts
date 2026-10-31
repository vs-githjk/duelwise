import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { notLeft } from './competitive'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { decodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import { buildReportBody } from '../report/build'
import { MATERIAL, type ChessEvaluator } from '../report/chess'
import { publicBody } from '../report/copy'
import { humanActionCount } from '../report/walk'
import type { ReportBody } from '../report/types'
export { saveRatingChange, type RatingChange } from './report-store'

type Db = PgDatabase<any, typeof schema>

/** The person looking at a report: a signed-in user, a guest from the cookie, or nobody. */
export interface Viewer {
  userId?: string
  guestId?: string
}

/** What happened to the match as far as training is concerned. Only `stored` means it entered the pool. */
export type Learning =
  | { state: 'stored' }
  | { state: 'checking' }
  | { state: 'stats_only'; reason: 'opt_out' }
  | { state: 'not_used'; reason: 'resigned' | 'abandoned' | 'rejected' | 'not_learning' }

export type ReportStatus = 'ready' | 'resigned' | 'abandoned' | 'rejected' | 'writing' | 'private'

/**
 * Everything the report page shows. A public view is built from the match alone and never holds an
 * account, a guest id, an email, a rating or a device: the only identifier in it is `id`, the match's
 * own random id. The owner view adds the rating, the learning status and the sharing choices.
 */
export interface ReportView {
  id: string
  /** 'owner' only for the player who played the match. */
  mode: 'owner' | 'public'
  status: ReportStatus
  game: GameId
  level: Level
  /** Day the match ended, as YYYY-MM-DD (UTC), or null while it is still going. */
  day: string | null
  body: ReportBody | null
  seed?: number | null
  /** Name shown on a public page: the player's own name only when they chose to show it. */
  playerName: string | null
  owner: null | {
    rating: { before: number; after: number; provisional: boolean } | null
    signedIn: boolean
    learning: Learning
    linkPublic: boolean
    showName: boolean
    /** How this player has done against this persona in this game: their latest settled matches. */
    record: VsRecord
  }
}

/** Wins, losses and draws over the player's latest settled matches in this game at this level, newest first in `recent`. */
export interface VsRecord {
  wins: number
  losses: number
  draws: number
  /** Up to the last five results, newest first. */
  recent: Array<'win' | 'loss' | 'draw'>
}

/** How many settled matches the record looks back over. */
export const RECORD_WINDOW = 30

// The player who played the match: the signed-in user it belongs to, or the guest it was played as. A guest
// who then signs in keeps the guest cookie, so a guest match stays theirs (the guest row was checked by existingGuestId).
const sameCaller = (row: { userId: string | null; guestId: string | null }, who: Viewer): boolean =>
  (who.userId !== undefined && row.userId === who.userId) || (row.userId === null && who.guestId !== undefined && row.guestId === who.guestId)

async function vsRecord(db: Db, row: typeof schema.match.$inferSelect): Promise<VsRecord> {
  const mine = row.userId ? eq(schema.match.userId, row.userId) : and(isNull(schema.match.userId), row.guestId ? eq(schema.match.guestId, row.guestId) : isNull(schema.match.guestId))
  const rows = await db
    .select({ status: schema.match.status, result: schema.match.result, record: schema.match.record, recordValid: schema.match.recordValid })
    .from(schema.match)
    .where(and(mine, eq(schema.match.game, row.game), eq(schema.match.level, row.level), inArray(schema.match.status, ['finished', 'resigned', 'abandoned']), notLeft))
    .orderBy(desc(schema.match.finishedAt), desc(schema.match.startedAt))
    .limit(RECORD_WINDOW)
  const out: VsRecord = { wins: 0, losses: 0, draws: 0, recent: [] }
  for (const m of rows) {
    let o: 'win' | 'loss' | 'draw'
    if (m.status !== 'finished') o = 'loss'
    else {
      if (m.recordValid !== true || !m.record || !m.result) continue
      try {
        const seat = decodeRecord(m.record).humanSeat
        o = m.result.winner === null ? 'draw' : m.result.winner === seat ? 'win' : 'loss'
      } catch {
        continue
      }
    }
    if (o === 'win') out.wins++
    else if (o === 'loss') out.losses++
    else out.draws++
    if (out.recent.length < 5) out.recent.push(o)
  }
  return out
}

export interface ReportDeps {
  /** Loads the chess evaluator; the server passes the value net loader. Default: a material count. */
  chessEvaluator?: () => Promise<ChessEvaluator>
  /** Whether a game stores its records trainable. Default: true. A game that does not stores its matches with the flag off by design. */
  recordsTrainable?: (game: GameId) => boolean
}

/** `trainable` is false for a game that stores its records with the flag off by design; that is not a player's opt-out. */
function learningOf(row: typeof schema.match.$inferSelect, trainable: boolean): Learning {
  if (row.status === 'resigned') return { state: 'not_used', reason: 'resigned' }
  if (row.status === 'abandoned') return { state: 'not_used', reason: 'abandoned' }
  if (row.status === 'finished' && row.recordValid === false) return { state: 'not_used', reason: 'rejected' }
  if (!trainable) return { state: 'not_used', reason: 'not_learning' }
  const flags = row.filterFlags as Record<string, unknown> | null
  if (typeof flags?.deferredCheckAt === 'number') return { state: 'checking' }
  if (!row.trainingAllowed) return { state: 'stats_only', reason: 'opt_out' }
  return { state: 'stored' }
}

/**
 * Loads a report by its public id. Returns null when no match has that id. The match row decides
 * the state; the key moments come from replaying the stored record through the game core, cached
 * after the first build (a material-count chess report is not cached, so a later value net improves it).
 */
export async function getReport(db: Db, id: string, viewer: Viewer, deps: ReportDeps = {}): Promise<ReportView | null> {
  if (typeof id !== 'string' || id.length === 0 || id.length > 80) return null
  const row = (await db.select().from(schema.match).where(eq(schema.match.id, id)).limit(1))[0]
  if (!row) return null
  const meta = (await db.select().from(schema.matchReport).where(eq(schema.matchReport.matchId, id)).limit(1))[0]
  const mine = sameCaller(row, viewer)
  const linkPublic = meta?.linkPublic ?? true
  const game = row.game as GameId
  const level = row.level as Level
  const day = row.finishedAt ? row.finishedAt.toISOString().slice(0, 10) : null

  let playerName: string | null = null
  if (meta?.showName && row.userId) {
    const u = (await db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, row.userId)).limit(1))[0]
    playerName = u?.name ?? null
  }

  const trainable = (deps.recordsTrainable ?? (() => true))(game)
  const owner: ReportView['owner'] = mine
    ? {
        rating: meta && meta.eloBefore !== null && meta.eloAfter !== null ? { before: meta.eloBefore, after: meta.eloAfter, provisional: meta.provisional } : null,
        signedIn: row.userId !== null,
        learning: learningOf(row, trainable),
        linkPublic,
        showName: meta?.showName ?? false,
        record: await vsRecord(db, row),
      }
    : null
  const base = { id, mode: mine ? ('owner' as const) : ('public' as const), game, level, day, playerName, owner, seed: game === 'arena' && row.status !== 'started' ? row.seed : null }

  if (!mine && !linkPublic) return { ...base, status: 'private', day: null, body: null, playerName: null, seed: null }
  if (row.status === 'started') return { ...base, status: 'writing', body: null }
  if (row.status === 'resigned' || row.status === 'abandoned') {
    const ms = row.status === 'resigned' && row.finishedAt ? Math.max(0, row.finishedAt.getTime() - row.startedAt.getTime()) : 0
    const body = row.status === 'resigned' ? simpleBody(game, level, 'You resigned.', 'The player resigned.', ms) : simpleBody(game, level, 'The match was abandoned.', 'The match was abandoned.', ms)
    return { ...base, status: row.status, body: mine ? body : publicBody(body) }
  }
  if (row.recordValid !== true || !row.record) return { ...base, status: 'rejected', body: null }

  // The stored body is written for the player; anyone else gets the same facts worded about "the player".
  const shown = (b: ReportBody): ReportBody => (mine ? b : publicBody(b))
  const cached = meta?.built as { v: 3; body: ReportBody } | null | undefined
  if (cached?.v === 3) return { ...base, status: 'ready', body: shown(cached.body) }
  let rec: MatchRecordV1
  try {
    rec = decodeRecord(row.record)
  } catch {
    return { ...base, status: 'rejected', body: null }
  }
  const ev = game === 'chess' ? await (deps.chessEvaluator ?? (async () => MATERIAL))() : undefined
  const body = buildReportBody(rec, { chessEvaluator: ev })
  if (body.evaluator !== 'material') {
    await db
      .insert(schema.matchReport)
      .values({ matchId: id, built: { v: 3, body } as unknown as Record<string, unknown> })
      .onConflictDoUpdate({ target: schema.matchReport.matchId, set: { built: { v: 3, body } as unknown as Record<string, unknown> } })
  }
  return { ...base, status: 'ready', body: shown(body) }
}

/** A resigned or abandoned match has no replayable end: the report is the outcome and nothing else. */
function simpleBody(game: GameId, level: Level, reason: string, publicReason: string, durationMs = 0): ReportBody {
  return { game, level, outcome: 'loss', reason, publicReason, moves: 0, durationMs, blunders: null, evaluator: 'none', moments: [], series: null, wordRows: null, reaction: null, note: null }
}

/** The few facts the share card needs, for a report that is public. Null for anything the public may not see. */
export async function getCardFacts(db: Db, id: string): Promise<{ game: GameId; level: Level; outcome: 'win' | 'loss' | 'draw'; moves: number; rounds?: { you: number; ai: number } } | null> {
  if (typeof id !== 'string' || id.length === 0 || id.length > 80) return null
  const row = (await db.select().from(schema.match).where(eq(schema.match.id, id)).limit(1))[0]
  if (!row) return null
  const meta = (await db.select().from(schema.matchReport).where(eq(schema.matchReport.matchId, id)).limit(1))[0]
  if (meta && !meta.linkPublic) return null
  const game = row.game as GameId
  const level = row.level as Level
  if (row.status === 'resigned' || row.status === 'abandoned') return { game, level, outcome: 'loss', moves: 0 }
  if (row.status !== 'finished' || row.recordValid !== true || !row.record) return null
  try {
    const rec = decodeRecord(row.record)
    const outcome = rec.result.winner === null ? 'draw' : rec.result.winner === rec.humanSeat ? 'win' : 'loss'
    // The same counts the report page prints, including the round score for a real-time match.
    if (PRODUCT.games[game].kind === 'realtime') return { game, level, outcome, moves: humanActionCount(rec), rounds: { you: rec.result.score[rec.humanSeat], ai: rec.result.score[1 - rec.humanSeat] } }
    return { game, level, outcome, moves: humanActionCount(rec) }
  } catch {
    return null
  }
}

export interface SettingsInput {
  linkPublic?: unknown
  showName?: unknown
}

/** The player changes who can see the report. Returns false when the match is not theirs or does not exist. */
export async function setReportSettings(db: Db, id: string, viewer: Viewer, input: SettingsInput): Promise<boolean> {
  if (typeof id !== 'string' || id.length === 0 || id.length > 80) return false
  const row = (await db.select().from(schema.match).where(eq(schema.match.id, id)).limit(1))[0]
  if (!row || !sameCaller(row, viewer)) return false
  const set: { linkPublic?: boolean; showName?: boolean } = {}
  if (typeof input.linkPublic === 'boolean') set.linkPublic = input.linkPublic
  // A guest has no name to show.
  if (typeof input.showName === 'boolean' && row.userId) set.showName = input.showName
  if (Object.keys(set).length === 0) return true
  await db
    .insert(schema.matchReport)
    .values({ matchId: id, ...set })
    .onConflictDoUpdate({ target: schema.matchReport.matchId, set })
  return true
}
