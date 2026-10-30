import { sql, type SQL } from 'drizzle-orm'
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
 *   test:  a guest tagged test, a player with a test-tagged match, or (rows from before the column) a player whose
 *          telemetry shows a headless browser.
 *   human: everyone else.
 */
export function classCte(env: { OWNER_EMAILS?: string | undefined }): SQL {
  return sql`
  tm as (
    select case when user_id is not null then 'u:' || user_id else 'g:' || guest_id end as pid,
      bool_or(traffic = 'test') as t, bool_or(traffic = 'owner') as o
    from match where coalesce(user_id, guest_id) is not null group by 1
  ),
  hl as (select distinct player_ref from telemetry_event where device = 'headless'),
  pb as (
    select 'g:' || g.id as pid, ${sql.raw(refSql(`'guest'`, 'g.id'))} as ref, g.created_at as created, false as isowner, g.traffic as gt from guest g
    union all
    select 'u:' || u.id, ${sql.raw(refSql(`'user'`, 'u.id'))}, u.created_at, ${ownerCond(env)}, null from "user" u
  ),
  pc as (
    select pb.pid, pb.ref, pb.created,
      case
        when pb.isowner then 'owner'
        when pb.gt = 'test' or coalesce(tm.t, false) or pb.ref in (select player_ref from hl) then 'test'
        when pb.gt = 'owner' or coalesce(tm.o, false) then 'owner'
        else 'human'
      end as cls
    from pb left join tm on tm.pid = pb.pid
  )`
}

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
