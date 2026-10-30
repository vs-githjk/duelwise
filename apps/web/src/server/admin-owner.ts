import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { decodeRecord } from '@duelwise/core/src/match-record'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import { guestLabel } from '../lib/display-name'
import type { HandlerResponse } from './match-handlers'
import { isOwner, playerRef } from './telemetry'

/**
 * The owner's people-and-activity views: totals, a People table, one player's history and the latest finished matches.
 * Every handler answers 404 to anyone who is not on OWNER_EMAILS (the same as an address that does not exist), and no
 * handler returns an email: a player is a short opaque ref, and emails come only from the audited reveal in telemetry-owner.ts.
 * Queries read the guest, user, profile and match tables in a few set-based statements (no query per player).
 */

type Db = PgDatabase<any, typeof schema>
type Env = { OWNER_EMAILS?: string | undefined }
type SessionUser = { id: string; email?: string | null; emailVerified?: boolean | null } | null | undefined

const NOT_FOUND: HandlerResponse<{ error: string }> = { status: 404, body: { error: 'not found' } }
export const PEOPLE_PAGE_SIZE = 20
export const FEED_SIZE = 50
export const TREND_DAYS = 14
const HISTORY_CAP = 500
const SEARCH_MAX = 40
export const LEVELS: readonly Level[] = ['easy', 'medium', 'hard', 'champion']
const GAMES = Object.keys(PRODUCT.games) as GameId[]
const isGame = (g: string): g is GameId => Object.prototype.hasOwnProperty.call(PRODUCT.games, g)
const isLevel = (l: string): l is Level => (LEVELS as readonly string[]).includes(l)
const DAY_MS = 86_400_000

export type PeopleSort = 'last' | 'joined' | 'matches'
export interface PeopleParams {
  sort: PeopleSort
  dir: 'asc' | 'desc'
  page: number
  q: string
}

export interface DayCount {
  day: string
  count: number
}
export interface AdminOverview {
  generatedAt: string
  players: { total: number; guests: number; accounts: number }
  newPerDay: DayCount[]
  matchesPerDay: DayCount[]
  matchesPerGame: Array<{ game: GameId; count: number }>
  feed: FeedRow[]
}
export type MatchView = 'won' | 'lost' | 'draw'
export interface FeedRow {
  matchId: string
  ref: string
  kind: 'guest' | 'user'
  name: string
  hidden: boolean
  game: GameId
  level: Level
  result: MatchView
  at: string
}
export interface PersonRow {
  ref: string
  kind: 'guest' | 'user'
  name: string
  joinedAt: string
  lastSeenAt: string
  matches: number
  perGame: Partial<Record<GameId, number>>
  winsByLevel: Record<Level, number>
  hidden: boolean
}
export interface PeoplePage {
  rows: PersonRow[]
  total: number
  page: number
  pageSize: number
}
export type HistoryResult = MatchView | 'resigned' | 'abandoned' | 'in progress' | 'unknown'
export interface HistoryRow {
  matchId: string
  game: GameId
  level: Level
  result: HistoryResult
  at: string
  /** Counts toward the board: a finished match with a replayed record on a ranked (not Practice) level. */
  counted: boolean
  practice: boolean
  /** Null while the match has not been checked (still running or waiting for its check). */
  valid: boolean | null
  invalidReason: string | null
}
export interface PlayerDetail {
  ref: string
  kind: 'guest' | 'user'
  name: string
  hidden: boolean
  joinedAt: string
  lastSeenAt: string
  matches: HistoryRow[]
  matchesTotal: number
  path: Array<{ game: GameId; cleared: Record<Level, boolean> }>
}

const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)))
const rowsOf = <T>(res: unknown): T[] => (Array.isArray(res) ? (res as T[]) : (((res as { rows?: T[] } | null)?.rows ?? []) as T[]))

/** Reads untrusted query input into known values. */
export function parsePeopleParams(q: Record<string, unknown> | null | undefined): PeopleParams {
  const d = q ?? {}
  const sort: PeopleSort = d.sort === 'joined' || d.sort === 'matches' ? d.sort : 'last'
  const p = Number(d.page)
  const search = typeof d.q === 'string' ? d.q.trim().slice(0, SEARCH_MAX) : ''
  return { sort, dir: d.dir === 'asc' ? 'asc' : 'desc', page: Number.isInteger(p) && p > 0 && p < 100_000 ? p : 0, q: search }
}

/** The human's result of a finished match from its record, or null when the record cannot be read. */
export function viewOf(result: { winner: 0 | 1 | null } | null, record: Uint8Array | null): MatchView | null {
  if (!result || !record) return null
  try {
    const seat = decodeRecord(record).humanSeat
    return result.winner === null ? 'draw' : result.winner === seat ? 'won' : 'lost'
  } catch {
    return null
  }
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10)
/** One entry per UTC day for the last `days` days, oldest first, with zero for quiet days. */
function fillDays(rows: DayCount[], now: Date, days: number): DayCount[] {
  const by = new Map(rows.map((r) => [r.day, r.count]))
  return Array.from({ length: days }, (_, i) => {
    const day = dayKey(new Date(now.getTime() - (days - 1 - i) * DAY_MS))
    return { day, count: by.get(day) ?? 0 }
  })
}

/** Names and board visibility for a set of account and guest ids: two statements for any number of players. */
async function labelsFor(db: Db, userIds: string[], guestIds: string[]): Promise<Map<string, { name: string; hidden: boolean }>> {
  const out = new Map<string, { name: string; hidden: boolean }>()
  if (userIds.length) {
    const rows = await db
      .select({ id: schema.user.id, name: schema.user.name, display: schema.profile.displayName, show: schema.profile.showOnLeaderboard })
      .from(schema.user)
      .leftJoin(schema.profile, eq(schema.profile.userId, schema.user.id))
      .where(inArray(schema.user.id, userIds))
    for (const r of rows) out.set(`u:${r.id}`, { name: r.display?.trim() || r.name.trim().split(/\s+/)[0] || 'Player', hidden: r.show === false })
  }
  if (guestIds.length) {
    const rows = await db
      .select({ id: schema.guest.id, display: schema.guest.displayName, show: schema.guest.showOnLeaderboard })
      .from(schema.guest)
      .where(inArray(schema.guest.id, guestIds))
    for (const r of rows) out.set(`g:${r.id}`, { name: r.display?.trim() || guestLabel(r.id), hidden: r.show === false })
  }
  return out
}

/** Totals, trends for the last 14 days and the latest 50 finished matches. */
export async function adminOverviewHandler(
  db: Db,
  user: SessionUser,
  env: Env,
  now: Date = new Date(),
): Promise<HandlerResponse<AdminOverview | { error: string }>> {
  if (!isOwner(user, env)) return NOT_FOUND
  const from = new Date(now.getTime() - (TREND_DAYS - 1) * DAY_MS)
  from.setUTCHours(0, 0, 0, 0)
  const fromIso = from.toISOString()
  const [totalRow, newRows, dayRows, gameRows, feedRows] = await Promise.all([
    db.execute(sql`select (select count(*) from guest)::int as guests, (select count(*) from "user")::int as accounts`),
    db.execute(sql`
      select to_char(d at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::int as count
      from (select created_at as d from guest where created_at >= ${fromIso}::timestamptz union all select created_at from "user" where created_at >= ${fromIso}::timestamptz) x
      group by 1`),
    db.execute(sql`
      select to_char(finished_at at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::int as count
      from match where status = 'finished' and finished_at >= ${fromIso}::timestamptz group by 1`),
    db.execute(sql`select game, count(*)::int as count from match where status = 'finished' group by game`),
    db
      .select({
        id: schema.match.id,
        game: schema.match.game,
        level: schema.match.level,
        userId: schema.match.userId,
        guestId: schema.match.guestId,
        result: schema.match.result,
        record: schema.match.record,
        finishedAt: schema.match.finishedAt,
      })
      .from(schema.match)
      .where(and(eq(schema.match.status, 'finished'), isNotNull(schema.match.finishedAt)))
      .orderBy(desc(schema.match.finishedAt))
      .limit(FEED_SIZE),
  ])
  const t = rowsOf<{ guests: number; accounts: number }>(totalRow)[0] ?? { guests: 0, accounts: 0 }
  const labels = await labelsFor(
    db,
    [...new Set(feedRows.flatMap((r) => (r.userId ? [r.userId] : [])))],
    [...new Set(feedRows.flatMap((r) => (!r.userId && r.guestId ? [r.guestId] : [])))],
  )
  const feed: FeedRow[] = []
  for (const r of feedRows) {
    const result = viewOf(r.result, r.record)
    if (!result || !r.finishedAt || !isGame(r.game) || !isLevel(r.level)) continue
    const kind = r.userId ? 'user' : 'guest'
    const id = r.userId ?? r.guestId
    if (!id) continue
    const label = labels.get(`${r.userId ? 'u' : 'g'}:${id}`)
    feed.push({ matchId: r.id, ref: await playerRef(kind, id), kind, name: label?.name ?? (kind === 'guest' ? guestLabel(id) : 'Player'), hidden: label?.hidden ?? false, game: r.game, level: r.level, result, at: r.finishedAt.toISOString() })
  }
  const body: AdminOverview = {
    generatedAt: now.toISOString(),
    players: { total: Number(t.guests) + Number(t.accounts), guests: Number(t.guests), accounts: Number(t.accounts) },
    newPerDay: fillDays(rowsOf<DayCount>(newRows).map((r) => ({ day: r.day, count: Number(r.count) })), now, TREND_DAYS),
    matchesPerDay: fillDays(rowsOf<DayCount>(dayRows).map((r) => ({ day: r.day, count: Number(r.count) })), now, TREND_DAYS),
    matchesPerGame: GAMES.map((game) => ({ game, count: Number(rowsOf<{ game: string; count: number }>(gameRows).find((g) => g.game === game)?.count ?? 0) })),
    feed,
  }
  return { status: 200, body }
}

const SORT_SQL: Record<PeopleSort, string> = { last: 'last_seen', joined: 'joined', matches: 'matches' }

/** Every guest and account as one row: label (typed name, else first name or "guest" and 4 characters), joined date, board switch. */
const PEOPLE_CTE = sql`
  p as (
    select 'g' as kind, g.id as id, g.created_at as joined, g.show_on_leaderboard as show,
      coalesce(nullif(trim(g.display_name), ''), 'guest ' || right(regexp_replace(g.id, '[^0-9a-fA-F]', '', 'g'), 4)) as name
    from guest g
    union all
    select 'u', u.id, u.created_at, coalesce(pr.show_on_leaderboard, true),
      coalesce(nullif(trim(pr.display_name), ''), nullif(split_part(trim(u.name), ' ', 1), ''), 'Player')
    from "user" u left join profile pr on pr.user_id = u.id
  )`

/** One page of the People table: sorted and searched in SQL, then the page's matches read in one statement. */
export async function adminPeopleHandler(
  db: Db,
  user: SessionUser,
  env: Env,
  q: Record<string, unknown> | null | undefined,
): Promise<HandlerResponse<PeoplePage | { error: string }>> {
  if (!isOwner(user, env)) return NOT_FOUND
  const p = parsePeopleParams(q)
  const like = `%${p.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const where = p.q ? sql`where name ilike ${like} escape '\\'` : sql``
  const order = sql.raw(`${SORT_SQL[p.sort]} ${p.dir} nulls last, kind, id`)
  const [pageRows, countRows] = await Promise.all([
    db.execute(sql`
      with ${PEOPLE_CTE},
      s as (
        select case when user_id is not null then 'u' else 'g' end as kind, coalesce(user_id, guest_id) as id,
          (count(*) filter (where status = 'finished'))::int as matches, max(coalesce(finished_at, started_at)) as last_played
        from match where coalesce(user_id, guest_id) is not null group by 1, 2
      )
      select p.kind, p.id, p.name, p.show, p.joined, coalesce(s.matches, 0) as matches, greatest(p.joined, s.last_played) as last_seen
      from p left join s on s.kind = p.kind and s.id = p.id
      ${where}
      order by ${order}
      limit ${PEOPLE_PAGE_SIZE} offset ${p.page * PEOPLE_PAGE_SIZE}`),
    db.execute(sql`with ${PEOPLE_CTE} select count(*)::int as n from p ${where}`),
  ])
  const page = rowsOf<{ kind: 'g' | 'u'; id: string; name: string; show: boolean; joined: unknown; matches: number; last_seen: unknown }>(pageRows)
  const total = Number(rowsOf<{ n: number }>(countRows)[0]?.n ?? 0)
  const userIds = page.filter((r) => r.kind === 'u').map((r) => r.id)
  const guestIds = page.filter((r) => r.kind === 'g').map((r) => r.id)
  const mine = [...(userIds.length ? [inArray(schema.match.userId, userIds)] : []), ...(guestIds.length ? [and(isNull(schema.match.userId), inArray(schema.match.guestId, guestIds))] : [])]
  const played = mine.length
    ? await db
        .select({ userId: schema.match.userId, guestId: schema.match.guestId, game: schema.match.game, level: schema.match.level, result: schema.match.result, record: schema.match.record })
        .from(schema.match)
        .where(and(eq(schema.match.status, 'finished'), or(...mine)))
    : []
  const mineBy = new Map<string, typeof played>()
  for (const m of played) {
    const key = m.userId ? `u:${m.userId}` : `g:${m.guestId}`
    mineBy.set(key, [...(mineBy.get(key) ?? []), m])
  }
  const rows: PersonRow[] = []
  for (const r of page) {
    const perGame: Partial<Record<GameId, number>> = {}
    const winsByLevel: Record<Level, number> = { easy: 0, medium: 0, hard: 0, champion: 0 }
    for (const m of mineBy.get(`${r.kind}:${r.id}`) ?? []) {
      if (!isGame(m.game)) continue
      perGame[m.game] = (perGame[m.game] ?? 0) + 1
      if (isLevel(m.level) && viewOf(m.result, m.record) === 'won') winsByLevel[m.level]++
    }
    rows.push({
      ref: await playerRef(r.kind === 'u' ? 'user' : 'guest', r.id),
      kind: r.kind === 'u' ? 'user' : 'guest',
      name: r.name,
      joinedAt: toDate(r.joined).toISOString(),
      lastSeenAt: toDate(r.last_seen).toISOString(),
      matches: Number(r.matches),
      perGame,
      winsByLevel,
      hidden: r.show === false,
    })
  }
  return { status: 200, body: { rows, total, page: p.page, pageSize: PEOPLE_PAGE_SIZE } }
}

/** Finds the guest or account behind a ref by hashing the ids of the asked kind (the ref is one-way). */
async function resolveRef(db: Db, ref: string, kinds: Array<'user' | 'guest'>): Promise<{ kind: 'user' | 'guest'; id: string } | null> {
  for (const kind of kinds) {
    const ids = kind === 'user' ? await db.select({ id: schema.user.id }).from(schema.user) : await db.select({ id: schema.guest.id }).from(schema.guest)
    for (const { id } of ids) if ((await playerRef(kind, id)) === ref) return { kind, id }
  }
  return null
}

/** One player: the full match history (newest first, capped at 500) and the adventure path per game. */
export async function adminPlayerHandler(
  db: Db,
  user: SessionUser,
  env: Env,
  input: unknown,
  practiceLevels: (game: GameId) => ReadonlySet<Level>,
): Promise<HandlerResponse<PlayerDetail | { error: string }>> {
  if (!isOwner(user, env)) return NOT_FOUND
  const ref = (input as { ref?: unknown } | null)?.ref
  if (typeof ref !== 'string' || !/^pl_[0-9a-f]{8}$/.test(ref)) return { status: 400, body: { error: 'expected { ref }' } }
  const who = await resolveRef(db, ref, ['user', 'guest'])
  if (!who) return NOT_FOUND
  const own = who.kind === 'user' ? eq(schema.match.userId, who.id) : and(isNull(schema.match.userId), eq(schema.match.guestId, who.id))
  const [labels, joinedRow, rows, totalRow] = await Promise.all([
    labelsFor(db, who.kind === 'user' ? [who.id] : [], who.kind === 'guest' ? [who.id] : []),
    who.kind === 'user'
      ? db.select({ at: schema.user.createdAt }).from(schema.user).where(eq(schema.user.id, who.id))
      : db.select({ at: schema.guest.createdAt }).from(schema.guest).where(eq(schema.guest.id, who.id)),
    db
      .select({
        id: schema.match.id,
        game: schema.match.game,
        level: schema.match.level,
        status: schema.match.status,
        result: schema.match.result,
        record: schema.match.record,
        recordValid: schema.match.recordValid,
        invalidReason: schema.match.invalidReason,
        startedAt: schema.match.startedAt,
        finishedAt: schema.match.finishedAt,
      })
      .from(schema.match)
      .where(own)
      .orderBy(desc(schema.match.startedAt))
      .limit(HISTORY_CAP),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.match).where(own),
  ])
  const label = labels.get(`${who.kind === 'user' ? 'u' : 'g'}:${who.id}`)
  const cleared = new Map<GameId, Record<Level, boolean>>()
  for (const g of GAMES) cleared.set(g, { easy: false, medium: false, hard: false, champion: false })
  const matches: HistoryRow[] = []
  for (const r of rows) {
    if (!isGame(r.game) || !isLevel(r.level)) continue
    const practice = practiceLevels(r.game).has(r.level)
    const view = r.status === 'finished' ? viewOf(r.result, r.record) : null
    const result: HistoryResult =
      r.status === 'finished' ? (view ?? 'unknown') : r.status === 'resigned' ? 'resigned' : r.status === 'started' || r.status === 'ticket' ? 'in progress' : 'abandoned'
    const valid = r.status === 'finished' ? r.recordValid : r.status === 'resigned' || r.status === 'abandoned' || r.status === 'expired' ? false : null
    // The same rule as the player's own path: a valid finished win clears the stop, Practice levels included.
    if (r.status === 'finished' && r.recordValid === true && view === 'won') cleared.get(r.game)![r.level] = true
    matches.push({
      matchId: r.id,
      game: r.game,
      level: r.level,
      result,
      at: (r.finishedAt ?? r.startedAt).toISOString(),
      counted: r.status === 'finished' && r.recordValid === true && !practice,
      practice,
      valid,
      invalidReason: r.invalidReason ?? (r.status === 'finished' && r.recordValid === false ? 'record did not replay' : null),
    })
  }
  const joinedAt = joinedRow[0]?.at ?? new Date(0)
  const newest = rows[0] ? (rows[0].finishedAt ?? rows[0].startedAt) : joinedAt
  const detail: PlayerDetail = {
    ref,
    kind: who.kind,
    name: label?.name ?? (who.kind === 'guest' ? guestLabel(who.id) : 'Player'),
    hidden: label?.hidden ?? false,
    joinedAt: joinedAt.toISOString(),
    lastSeenAt: (newest > joinedAt ? newest : joinedAt).toISOString(),
    matches,
    matchesTotal: Number(totalRow[0]?.n ?? matches.length),
    path: GAMES.map((game) => ({ game, cleared: cleared.get(game)! })),
  }
  return { status: 200, body: detail }
}
