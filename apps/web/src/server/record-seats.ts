import { inArray, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { decodeRecord } from '@duelwise/core/src/match-record'
import * as schema from '../db/schema'

type Db = PgDatabase<any, typeof schema>

/** What the public reads need from a stored record: the human's seat and how many actions they took. */
export interface SeatInfo {
  seat: 0 | 1
  moves: number
}

/**
 * The board, the opponent records and the leaderboard all read the human's seat from the match's gzip record, so each one
 * used to download every record of its window (the heaviest column of the table) on every load. A finished record never
 * changes, so once a record is decoded its answer is kept for this server instance and later reads ask the database for
 * the row's id and record length only, and fetch a record just for a row they have not seen. The key carries the finish time
 * and the byte length, so a row that was rewritten under the same id is read again. Per database handle, bounded.
 */
const memo = new WeakMap<object, Map<string, SeatInfo | null>>()
const MAX_MEMO = 20_000
/** Records fetched per query on a cold instance: about 0.5 MB each, so a first read is a handful of requests, not hundreds. */
const CHUNK = 400

export const seatStats = { fetched: 0, reused: 0 }

/** The scalar a read selects beside the id, so the memo can tell a rewritten row from the one it knows. */
export const recordLen = sql<number | null>`octet_length(${schema.match.record})`

export interface SeatRow {
  id: string
  finishedAt: Date | null
  len: number | null
}

const keyOf = (r: SeatRow) => `${r.id}:${r.finishedAt?.getTime() ?? 0}:${r.len ?? 0}`

/** Seat and own-move count for each row (null when the record is missing or cannot be decoded). Keyed by match id. */
export async function seatsFor(db: Db, rows: SeatRow[]): Promise<Map<string, SeatInfo | null>> {
  let known = memo.get(db)
  if (!known) memo.set(db, (known = new Map()))
  const out = new Map<string, SeatInfo | null>()
  const missing: SeatRow[] = []
  const queued = new Set<string>()
  for (const r of rows) {
    if (!r.len) {
      out.set(r.id, null)
      continue
    }
    const hit = known.get(keyOf(r))
    if (hit !== undefined) {
      seatStats.reused++
      out.set(r.id, hit)
    } else if (!queued.has(keyOf(r))) {
      queued.add(keyOf(r))
      missing.push(r)
    }
  }
  for (let i = 0; i < missing.length; i += CHUNK) {
    const part = missing.slice(i, i + CHUNK)
    const got = await db.select({ id: schema.match.id, record: schema.match.record }).from(schema.match).where(inArray(schema.match.id, part.map((p) => p.id)))
    const byId = new Map(got.map((g) => [g.id, g.record]))
    for (const r of part) {
      seatStats.fetched++
      const bytes = byId.get(r.id)
      let info: SeatInfo | null = null
      if (bytes) {
        try {
          const rec = decodeRecord(bytes)
          info = { seat: rec.humanSeat, moves: rec.actions.filter((a) => a[1] === rec.humanSeat).length }
        } catch {
          info = null
        }
      }
      out.set(r.id, info)
      if (known.size >= MAX_MEMO) known.delete(known.keys().next().value!)
      known.set(keyOf(r), info)
    }
  }
  return out
}

/** The winner out of the result json, so a read does not download the whole result (score, reason) of every row. */
export const winnerCol = sql<number | null>`(${schema.match.result}->>'winner')::int`
