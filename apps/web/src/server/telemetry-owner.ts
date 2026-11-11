import { and, gte, min, ne, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import type { HandlerResponse } from './match-handlers'
import { isOwner, playerRef } from './telemetry'
import { buildOwnerView, RANGE_MS, type EventRow, type Lens, type OwnerViewBody, type Range } from './telemetry-stats'
import { classCte, zoneFor } from './traffic-sql'

type Db = PgDatabase<any, typeof schema>
type Env = { OWNER_EMAILS?: string | undefined }
type SessionUser = { id: string; email?: string | null; emailVerified?: boolean | null } | null | undefined

export interface OwnerParams {
  range: Range
  game: GameId | undefined
  level: Level | undefined
  page: number
  /** Which traffic the panels show: humans by default. */
  who: Lens
}

const NOT_FOUND: HandlerResponse<{ error: string }> = { status: 404, body: { error: 'not found' } }
/** Most events one view reads; a bigger audience needs a SQL rollup, which this page does not do yet. */
const EVENT_CAP = 50_000
const MAX_REVEAL = 100

/** Reads untrusted query input into known values. */
export function parseOwnerParams(q: Record<string, unknown>): OwnerParams {
  const range = q.range === '24h' || q.range === '30d' ? q.range : '7d'
  const game = typeof q.game === 'string' && Object.prototype.hasOwnProperty.call(PRODUCT.games, q.game) ? (q.game as GameId) : undefined
  const level = q.level === 'easy' || q.level === 'medium' || q.level === 'hard' || q.level === 'champion' ? q.level : undefined
  const p = Number(q.page)
  return { range, game, level, page: Number.isInteger(p) && p > 0 && p < 10_000 ? p : 0, who: q.who === 'owner' || q.who === 'test' || q.who === 'all' ? q.who : 'human' }
}

/** The dashboard data for the owner; everyone else gets the same 404 as an address that does not exist. */
export async function ownerViewHandler(
  db: Db,
  user: SessionUser,
  env: Env,
  q: Record<string, unknown>,
  targetFor: (game: GameId, level: Level) => number | null,
  now: Date = new Date(),
): Promise<HandlerResponse<OwnerViewBody | { error: string }>> {
  if (!isOwner(user, env)) return NOT_FOUND
  const p = parseOwnerParams(q)
  const { zone, zoneFallback } = await zoneFor(db, q.tz)
  // One extra day: a daily range opens at local midnight, which can be up to a day and an hour before now - range, and the comparison period sits before that.
  const from = new Date(now.getTime() - 2 * RANGE_MS[p.range] - 86_400_000)
  const rows = await db.select().from(schema.telemetryEvent).where(and(gte(schema.telemetryEvent.at, from), ne(schema.telemetryEvent.kind, 'friend_match_finished'))).orderBy(sql`${schema.telemetryEvent.at} desc`).limit(EVENT_CAP)
  const events: EventRow[] = rows.map((r) => ({
    at: r.at, kind: r.kind, matchId: r.matchId, game: r.game, level: r.level, persona: r.persona, device: r.device, durationMs: r.durationMs,
    outcome: r.outcome, reason: r.reason, optedOut: r.optedOut, playerRef: r.playerRef, playerKind: r.playerKind,
  }))
  const firstRows = await db
    .select({ ref: schema.telemetryEvent.playerRef, first: min(schema.telemetryEvent.at) })
    .from(schema.telemetryEvent)
    .where(ne(schema.telemetryEvent.kind, 'friend_match_finished'))
    .groupBy(schema.telemetryEvent.playerRef)
  const firstSeen = new Map(firstRows.flatMap((r) => (r.first ? [[r.ref, new Date(r.first)] as const] : [])))
  const providers = new Map<string, string>()
  for (const a of await db.select({ userId: schema.account.userId, providerId: schema.account.providerId }).from(schema.account)) {
    const ref = await playerRef('user', a.userId)
    if (!providers.has(ref)) providers.set(ref, a.providerId)
  }
  // Every event belongs to one class, the class of its player (a player is in exactly one), so the parts add up to the total.
  const classRows = (await db.execute(sql`with ${classCte(env)} select ref, cls from pc`)) as unknown as { rows?: Array<{ ref: string; cls: string }> } | Array<{ ref: string; cls: string }>
  const classOf = new Map((Array.isArray(classRows) ? classRows : (classRows.rows ?? [])).map((r) => [r.ref, r.cls]))
  // A match has its own class: its own tag, else a headless event, else its player's class.
  const since = new Date(from.getTime() - 86_400_000)
  const tagged = new Map((await db.select({ id: schema.match.id, traffic: schema.match.traffic }).from(schema.match).where(gte(schema.match.startedAt, since))).flatMap((m) => (m.traffic ? [[m.id, m.traffic] as const] : [])))
  const clsOf = (e: EventRow): 'human' | 'owner' | 'test' => {
    const own = tagged.get(e.matchId)
    if (own) return own
    if (e.device === 'headless') return 'test'
    const c = classOf.get(e.playerRef)
    return c === 'owner' || c === 'test' || c === 'human' ? c : 'human'
  }
  const view = (list: EventRow[]) => buildOwnerView({ events: list, firstSeen, providers, now, zone, range: p.range, game: p.game, level: p.level, page: p.page, targetFor })
  const by = (c: 'human' | 'owner' | 'test') => view(events.filter((e) => clsOf(e) === c))
  const total = view(events)
  const human = by('human')
  const owner = by('owner')
  const test = by('test')
  const lens = p.who === 'human' ? human : p.who === 'owner' ? owner : p.who === 'test' ? test : total
  return { status: 200, body: { ...lens, zone, zoneFallback, zoneAsked: q.tz !== undefined, lastEventAt: total.lastEventAt, who: p.who, kpisBy: { human: human.kpis, owner: owner.kpis, test: test.kpis, total: total.kpis } } }
}

/**
 * Shows the emails of the asked players to the owner, and logs one audit row for each. The caller
 * (the page) asks only after a confirmation and keeps the answer in memory for that visit.
 */
export async function revealEmailsHandler(
  db: Db,
  user: SessionUser,
  env: Env,
  input: unknown,
  now: Date = new Date(),
): Promise<HandlerResponse<{ emails: Record<string, string> } | { error: string }>> {
  if (!isOwner(user, env) || !user) return NOT_FOUND
  const refs = (input as { refs?: unknown } | null)?.refs
  if (!Array.isArray(refs) || refs.some((r) => typeof r !== 'string')) return { status: 400, body: { error: 'expected { refs }' } }
  if (refs.length > MAX_REVEAL) return { status: 400, body: { error: 'too many players' } }
  const wanted = new Set((refs as string[]).filter((r) => /^pl_[0-9a-f]{8}$/.test(r)))
  const emails: Record<string, string> = {}
  if (wanted.size > 0) {
    for (const u of await db.select({ id: schema.user.id, email: schema.user.email }).from(schema.user)) {
      const ref = await playerRef('user', u.id)
      if (wanted.has(ref)) emails[ref] = u.email
    }
  }
  const ownerRef = await playerRef('user', user.id)
  const found = Object.keys(emails)
  if (found.length > 0) {
    await db.insert(schema.ownerAudit).values(found.map((targetRef) => ({ id: crypto.randomUUID(), at: now, ownerRef, action: 'reveal_email', targetRef })))
  }
  return { status: 200, body: { emails } }
}
