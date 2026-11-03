import { and, count, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import { NO_OFFLINE_TICKETS, RATED_NOT_OPEN } from '@duelwise/core/src/rated-path'
import { isSealed } from '@duelwise/core/src/sealed'
import type { Seat } from '@duelwise/core/src/types'
import * as schema from '../db/schema'
import { adoptTicket, issueMatchRow, mayUseTicket, trainingFor, type Caller, type HandlerResponse, type StartOptions } from './match-handlers'
import { ABANDONED_ROW, settleAbandoned, type AbandonOptions } from './abandon'
import { TICKET_TTL_MS, type TicketFlags } from './tickets'

type Db = PgDatabase<any, typeof schema>

/** Most tickets one request may ask for, and most unused tickets per player for one game and level. */
export const MAX_TICKETS_PER_REQUEST = 5
export const MAX_OPEN_TICKETS_PER_LEVEL = 5
/** Most unused tickets per player in all, and most issued per player in any one hour: bounds what a script can write. */
export const MAX_OPEN_TICKETS = 80
export const MAX_TICKETS_PER_HOUR = 60

const LEVELS: readonly string[] = ['easy', 'medium', 'hard', 'champion']

/** Who a ticket was issued to. The browser checks it against the signed-in player before it plays or uploads a ticket. */
export interface TicketOwner {
  userId: string | null
  guestId: string | null
}

export interface Ticket {
  matchId: string
  owner: TicketOwner
  game: GameId
  level: Level
  seed: number
  agentVersion: string
  /** The side the server gave this match (games with random sides). Absent on a ticket issued before sides existed, which is seat 0. */
  humanSeat?: Seat
  /** Epoch milliseconds. */
  expiresAt: number
}

export interface TicketsBody {
  tickets: Ticket[]
  /** The player the request was made as; `count: 0` asks for just this. */
  viewer: TicketOwner
}

export type TicketOptions = Pick<StartOptions, 'agentVersion' | 'seed' | 'side' | 'recordsTrainable'> & { now?: () => Date }

const err = (status: number, message: string): HandlerResponse<{ error: string }> => ({ status, body: { error: message } })

const ownerKey = (who: Caller): string => (who.userId ? `u:${who.userId}` : `g:${who.guestId}`)
const viewerOf = (who: Caller): TicketOwner => ({ userId: who.userId ?? null, guestId: who.guestId ?? null })

const mine = (who: Caller) => (who.userId ? eq(schema.match.userId, who.userId) : and(eq(schema.match.guestId, who.guestId!), isNull(schema.match.userId)))

/** One issue at a time per player in this process, so parallel requests see each other's rows (the check below covers other processes). */
const issuing = new Map<string, Promise<unknown>>()
async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = issuing.get(key) ?? Promise.resolve()
  const run = before.catch(() => {}).then(work)
  const tail = run.catch(() => {})
  issuing.set(key, tail)
  try {
    return await run
  } finally {
    if (issuing.get(key) === tail) issuing.delete(key)
  }
}

/** How many unused tickets the player holds for a game and level, in all, and how many were issued in the last hour. */
async function usage(db: Db, who: Caller, game: string, level: string, now: Date): Promise<{ level: number; all: number; hour: number }> {
  const open = and(mine(who), eq(schema.match.status, 'ticket'), gt(sql`(${schema.match.filterFlags}->>'ticketExpiresAt')::bigint`, now.getTime()))
  const [openLevel] = await db.select({ n: count() }).from(schema.match).where(and(open, eq(schema.match.game, game), eq(schema.match.level, level)))
  const [openAll] = await db.select({ n: count() }).from(schema.match).where(open)
  const [lastHour] = await db
    .select({ n: count() })
    .from(schema.match)
    .where(and(mine(who), gt(sql`(${schema.match.filterFlags}->>'ticketIssuedAt')::bigint`, now.getTime() - 60 * 60 * 1000)))
  return { level: openLevel?.n ?? 0, all: openAll?.n ?? 0, hour: lastHour?.n ?? 0 }
}

/**
 * Issues up to `count` tickets for a game and level, through the same row writer a normal start uses (issueMatchRow), so a
 * ticketed match has a server-issued id and seed exactly like an online one. Word Duel has none: its seed never leaves the
 * server, so offline Word is unranked. Rate limited: a per-level pool, a total pool and an hourly cap; hitting a cap issues
 * fewer (or no) tickets rather than failing, because the client only asks to top a pool up. `count: 0` issues nothing and
 * answers who the player is, so the browser can tell whose tickets it holds.
 *
 * The caps are enforced twice. Requests from one player run one at a time inside a process, and after inserting, the counts are
 * read again: a request that finds the caps exceeded (a parallel request in another process committed too) deletes its own
 * newest rows until they hold. The database has no interactive transaction on the serverless driver, so a lock is not available.
 */
export async function issueTicketsHandler(db: Db, input: unknown, who: Caller, opts: TicketOptions = {}): Promise<HandlerResponse<TicketsBody | { error: string }>> {
  if (typeof input !== 'object' || input === null) return err(400, 'expected { game, level, count }')
  const { game, level, count: wanted } = input as { game?: unknown; level?: unknown; count?: unknown }
  if (typeof game !== 'string' || !Object.prototype.hasOwnProperty.call(PRODUCT.games, game)) return err(400, 'unknown game')
  if (typeof level !== 'string' || !LEVELS.includes(level)) return err(400, 'unknown level')
  if (RATED_NOT_OPEN.includes(game as GameId)) return err(400, `${PRODUCT.games[game as GameId].displayName} has no rated matches yet, so no offline tickets`)
  if (NO_OFFLINE_TICKETS.includes(game as GameId)) return err(400, `${PRODUCT.games[game as GameId].displayName} has no offline tickets: Rated needs a connection`)
  if (isSealed(game as GameId)) return err(400, `${PRODUCT.games[game as GameId].displayName} has no offline tickets`)
  if (typeof wanted !== 'number' || !Number.isInteger(wanted) || wanted < 0) return err(400, 'count must be a whole number, 0 or more')
  if (!who.userId && !who.guestId) return err(401, 'no player')
  const viewer = viewerOf(who)
  if (wanted === 0) return { status: 200, body: { tickets: [], viewer } }

  return exclusive(ownerKey(who), async () => {
    const now = (opts.now ?? (() => new Date()))()
    // Tickets for an agent the server has since replaced can never be checked, so they stop counting against the pool right away.
    const current = (opts.agentVersion ?? (() => 'v1'))(game as GameId, level as Level)
    await db
      .update(schema.match)
      .set({ status: 'expired', finishedAt: now, trainingAllowed: false, invalidReason: 'agent updated' })
      .where(and(mine(who), eq(schema.match.status, 'ticket'), eq(schema.match.game, game), eq(schema.match.level, level), ne(schema.match.agentVersion, current)))
    const before = await usage(db, who, game, level, now)
    const room = Math.min(
      Math.min(wanted, MAX_TICKETS_PER_REQUEST),
      MAX_OPEN_TICKETS_PER_LEVEL - before.level,
      MAX_OPEN_TICKETS - before.all,
      MAX_TICKETS_PER_HOUR - before.hour,
    )
    if (room <= 0) return { status: 200 as const, body: { tickets: [], viewer } }

    const { trainingAllowed, playerAllowed } = await trainingFor(db, who, game as GameId, opts)
    const tickets: Ticket[] = []
    const owner: TicketOwner = { userId: who.userId ?? null, guestId: who.userId ? null : who.guestId! }
    for (let i = 0; i < room; i++) {
      const flags: TicketFlags = { ticketIssuedAt: now.getTime(), ticketExpiresAt: now.getTime() + TICKET_TTL_MS, ticketPlayerAllowed: playerAllowed }
      const row = await issueMatchRow(db, who, game as GameId, level as Level, trainingAllowed, opts, { status: 'ticket', filterFlags: flags as unknown as Record<string, unknown> })
      tickets.push({ matchId: row.matchId, owner, game: game as GameId, level: level as Level, seed: row.seed, agentVersion: row.agentVersion, ...(row.humanSeat === undefined ? {} : { humanSeat: row.humanSeat }), expiresAt: flags.ticketExpiresAt })
    }
    // Read the counts again: rows another process committed meanwhile show up now, and this request gives back what no longer fits.
    const after = await usage(db, who, game, level, now)
    const over = Math.max(0, after.level - MAX_OPEN_TICKETS_PER_LEVEL, after.all - MAX_OPEN_TICKETS, after.hour - MAX_TICKETS_PER_HOUR)
    const giveBack = Math.min(over, tickets.length)
    if (giveBack > 0) {
      const drop = tickets.splice(tickets.length - giveBack, giveBack)
      await db.delete(schema.match).where(and(inArray(schema.match.id, drop.map((t) => t.matchId)), eq(schema.match.status, 'ticket')))
    }
    return { status: 200 as const, body: { tickets, viewer } }
  })
}

/** Most ticket ids one report may name. */
export const MAX_REPORTED_TICKETS = 20

/**
 * The browser reports offline tickets it handed out for play but never sent a record for (the player closed the tab on a losing
 * match). The server settles each one as abandoned, which charges a signed-in player the loss exactly as an online abandon does,
 * so playing on a ticket cannot be used to dodge a loss. Answers the ids that are settled (now, or earlier by a record or expiry)
 * so the browser can forget them; ids that belong to someone else are not answered.
 */
export async function abandonTicketsHandler(db: Db, input: unknown, who: Caller, opts: AbandonOptions & { now?: () => Date } = {}): Promise<HandlerResponse<{ settled: string[] } | { error: string }>> {
  if (typeof input !== 'object' || input === null) return err(400, 'expected { matchIds }')
  const ids = (input as { matchIds?: unknown }).matchIds
  if (!Array.isArray(ids) || ids.length > MAX_REPORTED_TICKETS || !ids.every((x) => typeof x === 'string')) return err(400, `matchIds must be a list of at most ${MAX_REPORTED_TICKETS} ids`)
  if (!who.userId && !who.guestId) return err(401, 'no player')
  const now = (opts.now ?? (() => new Date()))()
  const settled: string[] = []
  for (const id of ids as string[]) {
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, id)).limit(1))[0]
    if (!row) { settled.push(id); continue }
    if (!mayUseTicket(row, who)) continue
    if (row.status !== 'ticket') { settled.push(id); continue }
    if (!row.userId && who.userId) await adoptTicket(db, id, who.userId)
    const taken = await db
      .update(schema.match)
      .set({ status: 'abandoned', startedAt: now, finishedAt: now, trainingAllowed: false, invalidReason: 'abandoned', filterFlags: { abandoned: true, offlineTicket: true } })
      .where(and(eq(schema.match.id, id), eq(schema.match.status, 'ticket')))
      .returning(ABANDONED_ROW)
    if (taken.length) await settleAbandoned(db, row.game as GameId, taken, now, opts)
    settled.push(id)
  }
  return { status: 200, body: { settled } }
}
