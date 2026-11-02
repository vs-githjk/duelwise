import { sql, type SQL } from 'drizzle-orm'
import { resolveZone, type ZoneInfo } from './owner-zone'
import { ownerEntries } from './telemetry'
import { TRAFFIC_CLASSES, type Traffic } from './traffic'

/** SQL for the opaque player code of a row: the same hash as playerRef() ('pl_' plus the first 8 hex digits of sha256 of "kind:id"). */
export const refSql = (kind: string, id: string) => `'pl_' || left(encode(sha256(convert_to(${kind} || ':' || ${id}, 'UTF8')), 'hex'), 8)`

/** The OWNER_EMAILS check of isOwner() in SQL: the id is on the list, or the email is on it and verified. */
function ownerCond(env: { OWNER_EMAILS?: string | undefined }): SQL {
  const list = ownerEntries(env)
  if (list.length === 0) return sql`false`
  const items = sql.join(list.map((e) => sql`${e}`), sql`, `)
  return sql`(lower(u.id) in (${items}) or (u.email_verified and lower(u.email) in (${items})))`
}

/**
 * A CTE named pc with one row per player (every guest and every account): pid ('g:<id>' or 'u:<id>'), ref (the opaque player
 * code), created, and cls, the player's class. Each player is in exactly one class, and a match takes its player's class, so
 * human + owner + test always equals the total.
 *   owner: an account on OWNER_EMAILS; a guest first seen on the owner's device (guest.traffic) or with owner-tagged matches.
 *   test:  only a player with a test signal (a guest tagged test, a test-tagged match, or, for rows from before the column,
 *          a headless telemetry event) and NO human signal (a human-tagged guest or match). One stray test run never makes
 *          a real player Test.
 *   human: everyone else.
 * A match has its own class: its own traffic tag, else test when its telemetry shows a headless browser, else its player's
 * class (MATCH_CLS), so match counts follow the match, not the person.
 */
export function classCte(env: { OWNER_EMAILS?: string | undefined }): SQL {
  return sql`
  tm as (
    select case when user_id is not null then 'u:' || user_id else 'g:' || guest_id end as pid,
      bool_or(traffic = 'test') as t, bool_or(traffic = 'owner') as o, bool_or(traffic = 'human') as h
    from match where coalesce(user_id, guest_id) is not null and status in ('finished', 'resigned', 'abandoned') group by 1
  ),
  hl as (select distinct player_ref from telemetry_event where device = 'headless'),
  hm as (select distinct match_id from telemetry_event where device = 'headless'),
  pb as (
    select 'g:' || g.id as pid, ${sql.raw(refSql(`'guest'`, 'g.id'))} as ref, g.created_at as created, false as isowner, g.traffic as gt from guest g
    union all
    select 'u:' || u.id, ${sql.raw(refSql(`'user'`, 'u.id'))}, u.created_at, ${ownerCond(env)}, null from "user" u
  ),
  pc as (
    select pb.pid, pb.ref, pb.created,
      case
        when pb.isowner then 'owner'
        when (pb.gt = 'test' or coalesce(tm.t, false) or pb.ref in (select player_ref from hl)) and not (coalesce(tm.h, false) or coalesce(pb.gt = 'human', false)) then 'test'
        when pb.gt = 'owner' or coalesce(tm.o, false) then 'owner'
        else 'human'
      end as cls
    from pb left join tm on tm.pid = pb.pid
  )`
}

/** The class of one match row m (joined to pc): its own tag, else a headless telemetry event, else its player's class. */
export const MATCH_CLS = sql.raw(`coalesce(m.traffic, case when m.id in (select match_id from hm) then 'test' end, pc.cls, 'human')`)

/** The join key of a match row to pc.pid. */
export const MATCH_PID = sql.raw(`case when m.user_id is not null then 'u:' || m.user_id else 'g:' || m.guest_id end`)

export interface Split {
  human: number
  owner: number
  test: number
  total: number
}
export const emptySplit = (): Split => ({ human: 0, owner: 0, test: 0, total: 0 })
export const isClass = (c: unknown): c is Traffic => (TRAFFIC_CLASSES as readonly unknown[]).includes(c)
/** Adds `n` to a class of a split and to its total; an unknown class counts as human. */
export function addTo(s: Split, cls: unknown, n: number): void {
  s[isClass(cls) ? cls : 'human'] += n
  s.total += n
}

/**
 * The zone to use for a request: the asked one when Intl knows it and the database accepts it, else UTC (flagged). The name only ever
 * reaches SQL as a bound parameter. Checking it against the database too means an odd name Intl knows but Postgres does not cannot fail a page.
 */
const goodZones = new Set<string>()
/** Postgres says this for a name it does not know: time zone "Mars/Base" not recognized. Matched on the text of the error and its causes, because drizzle wraps driver errors and the exact shape on Neon is not verified. */
const notRecognised = (e: unknown): boolean => {
  for (let err = e as { message?: unknown; cause?: unknown } | undefined, depth = 0; err && depth < 5; err = err.cause as typeof err, depth++) {
    if (typeof err.message === 'string' && /time ?zone .*not recognized|unknown time ?zone|invalid value for .*time ?zone/i.test(err.message)) return true
  }
  return false
}
export async function zoneFor(db: { execute: (q: SQL) => Promise<unknown> }, raw: unknown): Promise<ZoneInfo> {
  const z = resolveZone(raw)
  if (z.zoneFallback || goodZones.has(z.zone)) return z
  try {
    await db.execute(sql`select now() at time zone ${z.zone}::text`)
    goodZones.add(z.zone)
    return z
  } catch (e) {
    // Only a name the database does not know falls back to UTC. A dropped connection or any other failure goes up to the normal error path instead of showing UTC numbers with a false zone message.
    if (notRecognised(e)) return { zone: 'UTC', zoneFallback: true }
    throw e
  }
}
/**
 * SQL for "this timestamp falls on `day` (YYYY-MM-DD) or later on the zone's calendar". Compares local dates rather than an instant, so a
 * midnight that happens twice (clocks going back at 00:00) keeps both of its hours. The instant test is a wide pre-filter that lets an index work.
 */
export const onOrAfterDay = (col: SQL, day: string, zone: string) =>
  sql`(${col} >= ((${day}::date - 2)::timestamp at time zone 'UTC') and (${col} at time zone ${zone}::text)::date >= ${day}::date)`
