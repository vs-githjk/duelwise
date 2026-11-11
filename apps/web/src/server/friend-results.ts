/**
 * The friend head-to-head record (M9). Result only: the game, the two players, who won, when. Never moves, never a rating, never trained on.
 *
 * Nothing here trusts a browser. A result is written only from a proof the relay signed (packages/core/src/duel/result-proof.ts), and
 * the caller must be one of the two people in it (their hashed `ref` is recomputed here from the caller and their device id). Both
 * phones post the same proof; the relay's per-game id is the row key, so the second post writes nothing and the one count-only
 * telemetry event is written only by the post that inserted the row.
 *
 * Who is who: a signed-in person is keyed by a keyed hash of their account, so the record follows them to another phone; a person who is
 * not signed in is keyed by a keyed hash of this browser's friend device id. Neither is the id itself, and neither can be reversed
 * without DUEL_SIGNING_SECRET. Rotating that secret would orphan the existing records (the keys change), so it is not rotated lightly.
 */
import { and, desc, eq, or, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { verifyDuelResult, type DuelResultRecord } from '@duelwise/core/src/duel/result-proof'
import * as schema from '../db/schema'
import { callerRef, playerKey } from './duel-token'
import { recordFriendFinished } from './telemetry'

type Db = PgDatabase<any, typeof schema>

const DEVICE_ID = /^[0-9a-f-]{36}$/i
export interface Tally { you: number; them: number; draws: number }
const zero = (): Tally => ({ you: 0, them: 0, draws: 0 })

export interface HeadToHead {
  /** The friend's name as of their latest game with you. */
  friend: string
  /** This game's record between the two of you, from your side. */
  game: Tally
  /** Every game you have played each other, across games, from your side. Equal to `game` when only one game has been played. */
  all: Tally
  /** How many different games the record spans. */
  gamesPlayed: number
}

export interface FriendDeps {
  /** DUEL_SIGNING_SECRET. Missing or short means head-to-head is off. */
  secret: string | undefined
  /** Who is looking, read only (never creates a guest). */
  viewer: () => Promise<{ userId?: string; guestId?: string }>
}

export type RecordError = 'unavailable' | 'bad-proof' | 'bad-device' | 'not-your-game'
export type RecordResult =
  | { ok: true; card: HeadToHead; ratings: { you?: number; them?: number; friend: string } }
  | { ok: false; error: RecordError }

/** Rows for one pair, grouped to a count per game and winner. One small read. */
async function pairCounts(db: Db, a: string, b: string): Promise<Array<{ game: string; winner: string | null; n: number }>> {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const rows = await db
    .select({ game: schema.friendResult.game, winner: schema.friendResult.winner, n: sql<number>`count(*)::int` })
    .from(schema.friendResult)
    .where(and(eq(schema.friendResult.playerA, lo), eq(schema.friendResult.playerB, hi)))
    .groupBy(schema.friendResult.game, schema.friendResult.winner)
  return rows.map((r) => ({ game: r.game, winner: r.winner, n: Number(r.n) }))
}

export function cardFrom(rows: Array<{ game: string; winner: string | null; n: number }>, me: string, game: string, friend: string): HeadToHead {
  const g = zero()
  const all = zero()
  const seen = new Set<string>()
  for (const r of rows) {
    const k: keyof Tally = r.winner === null ? 'draws' : r.winner === me ? 'you' : 'them'
    all[k] += r.n
    if (r.game === game) g[k] += r.n
    seen.add(r.game)
  }
  return { friend, game: g, all, gamesPlayed: seen.size }
}

/**
 * Verifies the relay's proof, writes the result once, and answers with the head-to-head card for the person asking (so the result
 * screen needs this one call and nothing else). A caller who is not one of the two players writes and learns nothing.
 */
export async function recordFriendResult(db: Db, deps: FriendDeps, input: { proof: unknown; deviceId: unknown }): Promise<RecordResult> {
  if (!deps.secret || deps.secret.length < 16) return { ok: false, error: 'unavailable' }
  if (typeof input.deviceId !== 'string' || !DEVICE_ID.test(input.deviceId)) return { ok: false, error: 'bad-device' }
  const rec: DuelResultRecord | null = await verifyDuelResult(input.proof, deps.secret)
  if (!rec || !(rec.game in PRODUCT.games)) return { ok: false, error: 'bad-proof' }
  const who = await deps.viewer()
  const myRef = await callerRef(deps.secret, { ...(who.userId ? { userId: who.userId } : {}) }, input.deviceId)
  const mine = rec.players.findIndex((p) => p.ref === myRef)
  if (mine < 0) return { ok: false, error: 'not-your-game' }
  const me = rec.players[mine]!
  const them = rec.players[1 - mine]!
  const [a, b] = me.pid < them.pid ? [me, them] : [them, me]
  const inserted = await db
    .insert(schema.friendResult)
    .values({ id: rec.id, game: rec.game, playerA: a.pid, playerB: b.pid, nameA: a.name, nameB: b.name, winner: rec.winner === null ? null : rec.players[rec.winner]!.pid, finishedAt: new Date(rec.at) })
    .onConflictDoNothing()
    .returning({ id: schema.friendResult.id })
  if (inserted.length) await recordFriendFinished(db, { id: rec.id, game: rec.game })
  const card = cardFrom(await pairCounts(db, me.pid, them.pid), me.pid, rec.game, them.name)
  return { ok: true, card, ratings: { ...(me.rating !== undefined ? { you: me.rating } : {}), ...(them.rating !== undefined ? { them: them.rating } : {}), friend: them.name } }
}

export interface FriendRow {
  /** The friend's key, opaque, only for React keys. */
  key: string
  name: string
  you: number
  them: number
  draws: number
  games: number
  /** Latest game played together. */
  lastGame: GameId
  lastAt: string
}

/** The people you have played, newest first, with your record against each. One read of your latest games. */
export async function friendsOf(db: Db, pid: string, limit = 50): Promise<FriendRow[]> {
  const mineSql = or(eq(schema.friendResult.playerA, pid), eq(schema.friendResult.playerB, pid))
  const rows = await db.select().from(schema.friendResult).where(mineSql).orderBy(desc(schema.friendResult.finishedAt)).limit(1000)
  const by = new Map<string, FriendRow>()
  for (const r of rows) {
    const mineIsA = r.playerA === pid
    const key = mineIsA ? r.playerB : r.playerA
    const row = by.get(key) ?? { key, name: mineIsA ? r.nameB : r.nameA, you: 0, them: 0, draws: 0, games: 0, lastGame: r.game as GameId, lastAt: r.finishedAt.toISOString() }
    if (r.winner === null) row.draws++
    else if (r.winner === pid) row.you++
    else row.them++
    row.games++
    by.set(key, row)
  }
  return [...by.values()].slice(0, limit)
}

export async function friendsForViewer(db: Db, deps: FriendDeps, input: { deviceId: unknown }): Promise<{ ok: true; friends: FriendRow[] } | { ok: false; error: RecordError }> {
  if (!deps.secret || deps.secret.length < 16) return { ok: false, error: 'unavailable' }
  if (typeof input.deviceId !== 'string' || !DEVICE_ID.test(input.deviceId)) return { ok: false, error: 'bad-device' }
  const who = await deps.viewer()
  return { ok: true, friends: await friendsOf(db, await playerKey(deps.secret, { ...(who.userId ? { userId: who.userId } : {}) }, input.deviceId)) }
}

/** Account deletion: every friend result the person is in goes, along with the name stored in it. */
export async function deleteFriendResults(db: Db, pid: string): Promise<void> {
  await db.delete(schema.friendResult).where(or(eq(schema.friendResult.playerA, pid), eq(schema.friendResult.playerB, pid)))
}
