import { and, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { decodeRecord } from '@duelwise/core/src/match-record'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import { guestLabel } from '../lib/display-name'
import { isPractice } from './competitive'
import type { HandlerResponse } from './match-handlers'
import { addDays, dayKeyIn, type ZoneInfo } from './owner-zone'
import { isOwner, playerRef } from './telemetry'
import { addTo, classCte, dayStart, emptySplit, MATCH_CLS, MATCH_PID, type Split, zoneFor } from './traffic-sql'
import type { Traffic } from './traffic'

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
/** A match counts as played when it finished, was resigned or was abandoned. Offline tickets (issued in advance), expired tickets and matches still waiting are never counted as played. */
export const PLAYED = ['finished', 'resigned', 'abandoned'] as const
const PLAYED_SQL = sql.raw(`('finished', 'resigned', 'abandoned')`)

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
/** One day in the asked zone (YYYY-MM-DD), broken down by traffic class; human + owner + test = total. */
export interface DaySplit extends Split {
  day: string
}
export type { Split } from './traffic-sql'
export interface AdminOverview extends ZoneInfo {
  generatedAt: string
  players: { all: Split; guests: Split; accounts: Split }
  newPerDay: DaySplit[]
  matchesPerDay: DaySplit[]
  matchesPerGame: Array<{ game: GameId } & Split>
  feed: FeedRow[]
}
export type MatchView = 'won' | 'lost' | 'draw'
export interface FeedRow {
  matchId: string
  ref: string
  kind: 'guest' | 'user'
  name: string
  hidden: boolean
  traffic: Traffic
  game: GameId
  level: Level
  result: MatchView
  at: string
  /** Played in Practice mode (picked on the setup screen): played and recorded, but unrated. Not the same as a Practice level. */
  practiceMode: boolean
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
  traffic: Traffic
}
export interface PeoplePage {
  rows: PersonRow[]
  total: number
  /** The same total broken down by class (it ignores the page, not the search). */
  totalBy: Split
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
  /** Played in Practice mode (picked on the setup screen): played and recorded, but unrated and never a path clear. Not the same as `practice`, which is a Practice level. */
  practiceMode: boolean
  /** Null while the match has not been checked (still running or waiting for its check). */
  valid: boolean | null
  invalidReason: string | null
}
export interface PlayerDetail {
  ref: string
  kind: 'guest' | 'user'
  name: string
  hidden: boolean
  traffic: Traffic
  joinedAt: string
  lastSeenAt: string
  matches: HistoryRow[]
  /** Matches listed in the history: played ones and ones still in progress. Offline tickets and expired tickets are never listed or counted. */
  matchesTotal: number
  /** Of those, the ones played: finished, resigned or abandoned. */
  playedTotal: number
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

/** One entry per calendar day in the zone for the last `days` days (today included), oldest first, with zeros for quiet days. Days are stepped as dates, so a 23 or 25 hour day neither repeats nor skips. */
function fillSplits(rows: Array<{ day: string; cls: string; count: number }>, now: Date, days: number, zone: string): DaySplit[] {
  const by = new Map<string, Split>()
  for (const r of rows) addTo(by.get(r.day) ?? by.set(r.day, emptySplit()).get(r.day)!, r.cls, Number(r.count))
  const today = dayKeyIn(now, zone)
  return Array.from({ length: days }, (_, i) => {
    const day = addDays(today, -(days - 1 - i))
    return { day, ...(by.get(day) ?? emptySplit()) }
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

/** Totals, trends for the last 14 days and the latest 50 finished matches, every count broken down by traffic class. */
export async function adminOverviewHandler(
  db: Db,
  user: SessionUser,
  env: Env,
  now: Date = new Date(),
  rawZone?: unknown,
): Promise<HandlerResponse<AdminOverview | { error: string }>> {
  if (!isOwner(user, env)) return NOT_FOUND
  const { zone, zoneFallback } = await zoneFor(db, rawZone)
  const from = dayStart(addDays(dayKeyIn(now, zone), -(TREND_DAYS - 1)), zone)
  const endIso = now.toISOString()
  const cte = classCte(env)
  const [playerRows, newRows, dayRows, gameRows, feedRows] = await Promise.all([
    db.execute(sql`with ${cte} select left(pid, 1) as k, cls, count(*)::int as n from pc group by 1, 2`),
    db.execute(sql`
      with ${cte}
      select to_char(created at time zone ${zone}::text, 'YYYY-MM-DD') as day, cls, count(*)::int as count
      from pc where created >= ${from} and created <= ${endIso}::timestamptz group by 1, 2`),
    db.execute(sql`
      with ${cte}
      select to_char(m.finished_at at time zone ${zone}::text, 'YYYY-MM-DD') as day, ${MATCH_CLS} as cls, count(*)::int as count
      from match m left join pc on pc.pid = ${MATCH_PID}
      where m.status in ${PLAYED_SQL} and m.finished_at >= ${from} and m.finished_at <= ${endIso}::timestamptz group by 1, 2`),
    db.execute(sql`
      with ${cte}
      select m.game, ${MATCH_CLS} as cls, count(*)::int as count
      from match m left join pc on pc.pid = ${MATCH_PID} where m.status in ${PLAYED_SQL} group by 1, 2`),
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
        traffic: schema.match.traffic,
        flags: schema.match.filterFlags,
      })
      .from(schema.match)
      .where(and(eq(schema.match.status, 'finished'), isNotNull(schema.match.finishedAt)))
      .orderBy(desc(schema.match.finishedAt))
      .limit(FEED_SIZE),
  ])
  const players = { all: emptySplit(), guests: emptySplit(), accounts: emptySplit() }
  for (const r of rowsOf<{ k: string; cls: string; n: number }>(playerRows)) {
    addTo(players.all, r.cls, Number(r.n))
    addTo(r.k === 'u' ? players.accounts : players.guests, r.cls, Number(r.n))
  }
  const gameSplit = new Map<string, Split>()
  for (const r of rowsOf<{ game: string; cls: string; count: number }>(gameRows)) addTo(gameSplit.get(r.game) ?? gameSplit.set(r.game, emptySplit()).get(r.game)!, r.cls, Number(r.count))
  const feedUsers = [...new Set(feedRows.flatMap((r) => (r.userId ? [r.userId] : [])))]
  const feedGuests = [...new Set(feedRows.flatMap((r) => (!r.userId && r.guestId ? [r.guestId] : [])))]
  const [labels, classes, headlessMatches] = await Promise.all([
    labelsFor(db, feedUsers, feedGuests),
    classesOf(db, env, [...feedUsers.map((i) => `u:${i}`), ...feedGuests.map((i) => `g:${i}`)]),
    feedRows.length ? db.select({ id: schema.telemetryEvent.matchId }).from(schema.telemetryEvent).where(and(eq(schema.telemetryEvent.device, 'headless'), inArray(schema.telemetryEvent.matchId, feedRows.map((r) => r.id)))) : Promise.resolve([]),
  ])
  const headless = new Set(headlessMatches.map((h) => h.id))
  const feed: FeedRow[] = []
  for (const r of feedRows) {
    const result = viewOf(r.result, r.record)
    if (!result || !r.finishedAt || !isGame(r.game) || !isLevel(r.level)) continue
    const kind = r.userId ? 'user' : 'guest'
    const id = r.userId ?? r.guestId
    if (!id) continue
    const label = labels.get(`${r.userId ? 'u' : 'g'}:${id}`)
    feed.push({ matchId: r.id, ref: await playerRef(kind, id), kind, name: label?.name ?? (kind === 'guest' ? guestLabel(id) : 'Player'), hidden: label?.hidden ?? false, traffic: r.traffic ?? (headless.has(r.id) ? 'test' : (classes.get(`${r.userId ? 'u' : 'g'}:${id}`) ?? 'human')), game: r.game, level: r.level, result, at: r.finishedAt.toISOString(), practiceMode: isPractice(r.flags) })
  }
  const body: AdminOverview = {
    zone,
    zoneFallback,
    generatedAt: now.toISOString(),
    players,
    newPerDay: fillSplits(rowsOf<{ day: string; cls: string; count: number }>(newRows), now, TREND_DAYS, zone),
    matchesPerDay: fillSplits(rowsOf<{ day: string; cls: string; count: number }>(dayRows), now, TREND_DAYS, zone),
    matchesPerGame: GAMES.map((game) => ({ game, ...(gameSplit.get(game) ?? emptySplit()) })),
    feed,
  }
  return { status: 200, body }
}

/** The class of each named player ('g:<id>' or 'u:<id>'). */
async function classesOf(db: Db, env: Env, pids: string[]): Promise<Map<string, Traffic>> {
  const out = new Map<string, Traffic>()
  if (pids.length === 0) return out
  const rows = await db.execute(sql`with ${classCte(env)} select pid, cls from pc where pid in (${sql.join(pids.map((p) => sql`${p}`), sql`, `)})`)
  for (const r of rowsOf<{ pid: string; cls: Traffic }>(rows)) out.set(r.pid, r.cls)
  return out
}

export const ACTIVE_DAYS = 30
export interface ActiveUsers extends ZoneInfo {
  generatedAt: string
  /** Distinct players with a finished match today, in the last 7 days (today included) and in the last 30, by class. Days are days in `zone`. */
  dau: Split
  wau: Split
  mau: Split
  /** Players who finished matches on 2 or more distinct days inside the 7-day and the 30-day window. */
  returning7: Split
  returning30: Split
  /** Daily active players for each of the last 30 days, oldest first. */
  perDay: DaySplit[]
}

/**
 * Active players from finished matches, guests and accounts together (a guest who later signs in can count twice), by traffic
 * class. Two set-based statements, whatever the audience: one grouped by day, one grouped by player.
 */
export async function adminActiveHandler(
  db: Db,
  user: SessionUser,
  env: Env,
  now: Date = new Date(),
  rawZone?: unknown,
): Promise<HandlerResponse<ActiveUsers | { error: string }>> {
  if (!isOwner(user, env)) return NOT_FOUND
  const { zone, zoneFallback } = await zoneFor(db, rawZone)
  const today = dayKeyIn(now, zone)
  const w7 = addDays(today, -6)
  const w30 = addDays(today, -(ACTIVE_DAYS - 1))
  // The window is explicit: from 00:00 of the first day on the zone's clock to now. Nothing dated after now is counted, and the database session time zone never matters because every conversion names its zone.
  const start = dayStart(w30, zone)
  const endIso = now.toISOString()
  const cte = classCte(env)
  const played = sql`
    select ${MATCH_PID} as pid, ${MATCH_CLS} as cls, (m.finished_at at time zone ${zone}::text)::date as d
    from match m left join pc on pc.pid = ${MATCH_PID}
    where m.status in ${PLAYED_SQL} and m.finished_at >= ${start} and m.finished_at <= ${endIso}::timestamptz and coalesce(m.user_id, m.guest_id) is not null`
  const [dayRows, totalRows] = await Promise.all([
    db.execute(sql`with ${cte}, m2 as (${played}) select to_char(d, 'YYYY-MM-DD') as day, cls, count(distinct pid)::int as count from m2 group by d, cls`),
    db.execute(sql`
      with ${cte}, m2 as (${played}),
      pp as (
        select pid, cls, count(distinct d) filter (where d >= ${w7}::date)::int as d7, count(distinct d)::int as d30,
          bool_or(d >= ${today}::date) as t, bool_or(d >= ${w7}::date) as w
        from m2 group by pid, cls
      )
      select cls, (count(*) filter (where t))::int as dau, (count(*) filter (where w))::int as wau, count(*)::int as mau,
        (count(*) filter (where d7 >= 2))::int as returning7, (count(*) filter (where d30 >= 2))::int as returning30
      from pp group by cls`),
  ])
  const out = { dau: emptySplit(), wau: emptySplit(), mau: emptySplit(), returning7: emptySplit(), returning30: emptySplit() }
  for (const r of rowsOf<Record<string, number | string>>(totalRows)) {
    for (const k of ['dau', 'wau', 'mau', 'returning7', 'returning30'] as const) addTo(out[k], r.cls, Number(r[k] ?? 0))
  }
  return {
    status: 200,
    body: { zone, zoneFallback, generatedAt: now.toISOString(), ...out, perDay: fillSplits(rowsOf<{ day: string; cls: string; count: number }>(dayRows), now, ACTIVE_DAYS, zone) },
  }
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
      with ${classCte(env)}, ${PEOPLE_CTE},
      s as (
        select case when user_id is not null then 'u' else 'g' end as kind, coalesce(user_id, guest_id) as id,
          (count(*) filter (where status in ${PLAYED_SQL}))::int as matches, max(finished_at) filter (where status in ${PLAYED_SQL}) as last_played
        from match where coalesce(user_id, guest_id) is not null group by 1, 2
      )
      select p.kind, p.id, p.name, p.show, p.joined, coalesce(s.matches, 0) as matches, greatest(p.joined, s.last_played) as last_seen, coalesce(pc.cls, 'human') as cls
      from p left join s on s.kind = p.kind and s.id = p.id left join pc on pc.pid = p.kind || ':' || p.id
      ${where}
      order by ${order}
      limit ${PEOPLE_PAGE_SIZE} offset ${p.page * PEOPLE_PAGE_SIZE}`),
    db.execute(sql`with ${classCte(env)}, ${PEOPLE_CTE} select coalesce(pc.cls, 'human') as cls, count(*)::int as n from p left join pc on pc.pid = p.kind || ':' || p.id ${where} group by 1`),
  ])
  const page = rowsOf<{ kind: 'g' | 'u'; id: string; name: string; show: boolean; joined: unknown; matches: number; last_seen: unknown; cls: Traffic }>(pageRows)
  const totalBy = emptySplit()
  for (const c of rowsOf<{ cls: string; n: number }>(countRows)) addTo(totalBy, c.cls, Number(c.n))
  const total = totalBy.total
  const userIds = page.filter((r) => r.kind === 'u').map((r) => r.id)
  const guestIds = page.filter((r) => r.kind === 'g').map((r) => r.id)
  const mine = [...(userIds.length ? [inArray(schema.match.userId, userIds)] : []), ...(guestIds.length ? [and(isNull(schema.match.userId), inArray(schema.match.guestId, guestIds))] : [])]
  const played = mine.length
    ? await db
        .select({ userId: schema.match.userId, guestId: schema.match.guestId, game: schema.match.game, level: schema.match.level, result: schema.match.result, record: schema.match.record })
        .from(schema.match)
        .where(and(inArray(schema.match.status, [...PLAYED]), or(...mine)))
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
      if (isLevel(m.level) && viewOf(m.result, m.record) === 'won') winsByLevel[m.level]++ // only a finished match has a record
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
      traffic: r.cls,
    })
  }
  return { status: 200, body: { rows, total, totalBy, page: p.page, pageSize: PEOPLE_PAGE_SIZE } }
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
        flags: schema.match.filterFlags,
        startedAt: schema.match.startedAt,
        finishedAt: schema.match.finishedAt,
      })
      .from(schema.match)
      .where(and(own, notInArray(schema.match.status, ['ticket', 'expired'])))
      .orderBy(desc(schema.match.startedAt))
      .limit(HISTORY_CAP),
    db.select({ n: sql<number>`count(*)::int`, played: sql<number>`(count(*) filter (where ${schema.match.status} in ('finished', 'resigned', 'abandoned')))::int` }).from(schema.match).where(and(own, notInArray(schema.match.status, ['ticket', 'expired']))),
  ])
  const label = labels.get(`${who.kind === 'user' ? 'u' : 'g'}:${who.id}`)
  const cleared = new Map<GameId, Record<Level, boolean>>()
  for (const g of GAMES) cleared.set(g, { easy: false, medium: false, hard: false, champion: false })
  const matches: HistoryRow[] = []
  for (const r of rows) {
    if (!isGame(r.game) || !isLevel(r.level)) continue
    const practice = practiceLevels(r.game).has(r.level)
    const practiceMode = isPractice(r.flags)
    const view = r.status === 'finished' ? viewOf(r.result, r.record) : null
    const result: HistoryResult =
      r.status === 'finished' ? (view ?? 'unknown') : r.status === 'resigned' ? 'resigned' : r.status === 'started' || r.status === 'ticket' ? 'in progress' : 'abandoned'
    const valid = r.status === 'finished' ? r.recordValid : r.status === 'resigned' || r.status === 'abandoned' || r.status === 'expired' ? false : null
    // The same rule as the player's own path: a valid finished win clears the stop, Practice levels included.
    if (r.status === 'finished' && r.recordValid === true && view === 'won' && !practiceMode) cleared.get(r.game)![r.level] = true
    matches.push({
      matchId: r.id,
      game: r.game,
      level: r.level,
      result,
      at: (r.finishedAt ?? r.startedAt).toISOString(),
      counted: r.status === 'finished' && r.recordValid === true && !practice && !practiceMode,
      practice,
      practiceMode,
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
    traffic: (await classesOf(db, env, [`${who.kind === 'user' ? 'u' : 'g'}:${who.id}`])).get(`${who.kind === 'user' ? 'u' : 'g'}:${who.id}`) ?? 'human',
    joinedAt: joinedAt.toISOString(),
    lastSeenAt: (newest > joinedAt ? newest : joinedAt).toISOString(),
    matches,
    matchesTotal: Number(totalRow[0]?.n ?? matches.length),
    playedTotal: Number(totalRow[0]?.played ?? 0),
    path: GAMES.map((game) => ({ game, cleared: cleared.get(game)! })),
  }
  return { status: 200, body: detail }
}
