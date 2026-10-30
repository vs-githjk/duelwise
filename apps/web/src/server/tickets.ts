import { and, eq, lt, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import * as schema from '../db/schema'

type Db = PgDatabase<any, typeof schema>

/**
 * Offline match tickets. A ticket is a match row the server issued ahead of play (same match id and seed an online start
 * issues) so a phone with no signal can still play a counted match. It has status 'ticket', which the abandon rule and the open
 * match cap never touch, so an unused ticket can never be scored as a loss. Uploading a record for it turns the row into a
 * 'started' match (once, compare-and-set) and the normal replay, agent check and rating path runs. Its bookkeeping lives in
 * the row's filterFlags: no schema change.
 */
export const TICKET_TTL_MS = 14 * 24 * 60 * 60 * 1000

export interface TicketFlags {
  ticketIssuedAt: number
  ticketExpiresAt: number
  /** The player's own training choice at issue time, for the match_started event written when the ticket is used. */
  ticketPlayerAllowed: boolean
  ticketUsedAt?: number
}

export type TicketTaken = { ok: true; startedAt: Date; playerAllowed: boolean } | { ok: false; status: number; message: string }

/**
 * Turns a ticket into a started match, exactly once. Past its expiry the ticket is marked 'expired' and refused (410);
 * a second use, or a race between two uploads, is refused (409). The match then starts "now" so the abandon clock runs from
 * the upload, not from the day the ticket was issued.
 */
export async function takeTicket(db: Db, row: { id: string; filterFlags: Record<string, unknown> | null }, now: Date = new Date()): Promise<TicketTaken> {
  const flags = (row.filterFlags ?? {}) as Partial<TicketFlags>
  if (typeof flags.ticketExpiresAt !== 'number' || flags.ticketExpiresAt <= now.getTime()) {
    await db.update(schema.match).set({ status: 'expired', finishedAt: now, trainingAllowed: false, invalidReason: 'ticket expired' }).where(and(eq(schema.match.id, row.id), eq(schema.match.status, 'ticket')))
    return { ok: false, status: 410, message: 'this offline match ticket expired' }
  }
  const taken = await db
    .update(schema.match)
    .set({ status: 'started', startedAt: now, filterFlags: sql`coalesce(${schema.match.filterFlags}, '{}'::jsonb) || ${JSON.stringify({ ticketUsedAt: now.getTime() })}::jsonb` })
    .where(and(eq(schema.match.id, row.id), eq(schema.match.status, 'ticket')))
    .returning({ id: schema.match.id })
  if (taken.length === 0) return { ok: false, status: 409, message: 'this offline match ticket was already used' }
  return { ok: true, startedAt: now, playerAllowed: flags.ticketPlayerAllowed ?? true }
}

/** Marks every unused ticket past its expiry as 'expired'. Not a loss for anyone. Returns how many. */
export async function expireTickets(db: Db, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(schema.match)
    .set({ status: 'expired', finishedAt: now, trainingAllowed: false, invalidReason: 'ticket expired' })
    .where(and(eq(schema.match.status, 'ticket'), lt(sql`(${schema.match.filterFlags}->>'ticketExpiresAt')::bigint`, now.getTime())))
    .returning({ id: schema.match.id })
  return rows.length
}
