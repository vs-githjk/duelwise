import type { GameId, Level } from '@duelwise/core/src/product'
import { PRODUCT } from '@duelwise/core/src/product'
import { NO_OFFLINE_TICKETS, RATED_NOT_OPEN } from '@duelwise/core/src/rated-path'
import { isSealed } from '@duelwise/core/src/sealed'
import type { Ticket, TicketOwner } from '../server/ticket-issue'
import { CONSUMED, TICKETS, transact } from './offline-db'
import { bundleAgentVersion } from './bundle-version'
import { LEVELS } from './level-info'

export type { Ticket, TicketOwner }

/** A ticket as the browser keeps it (the server's Ticket, as issued). */
export interface TicketStore {
  put(ticket: Ticket): Promise<void>
  list(): Promise<Ticket[]>
  remove(matchId: string): Promise<void>
}

export const ticketStore: TicketStore = {
  async put(ticket) { await transact(TICKETS, 'readwrite', (s) => s.put(ticket)) },
  list: () => transact(TICKETS, 'readonly', (s) => s.getAll()),
  async remove(id) { await transact(TICKETS, 'readwrite', (s) => s.delete(id)) },
}

/** Whether the player now using this browser may play and upload something issued to `owner`. A guest's ticket also serves the same browser once signed in (the server moves it over). */
export function ownsTicket(owner: TicketOwner | undefined, viewer: TicketOwner): boolean {
  if (!owner) return false
  if (owner.userId) return owner.userId === viewer.userId
  return owner.guestId !== null && owner.guestId === viewer.guestId
}

const VIEWER_KEY = 'duelwise.ticket-viewer'
/** Who the server said this browser was at the last refill. Null when never learned (or after sign-out). */
export function rememberedViewer(): TicketOwner | null {
  try {
    const v = JSON.parse(localStorage.getItem(VIEWER_KEY) ?? 'null') as TicketOwner | null
    return v && typeof v === 'object' ? { userId: v.userId ?? null, guestId: v.guestId ?? null } : null
  } catch { return null }
}
export function rememberViewer(viewer: TicketOwner | null): void {
  try { if (viewer) localStorage.setItem(VIEWER_KEY, JSON.stringify(viewer)); else localStorage.removeItem(VIEWER_KEY) } catch { /* storage blocked */ }
}

/** A ticket taken for play. It stays here until the finished record is queued, so a match that was started and never finished can be reported. */
export interface Consumed { matchId: string; game: GameId; owner: TicketOwner; takenAt: number }
export interface ConsumedStore {
  put(item: Consumed): Promise<void>
  list(): Promise<Consumed[]>
  remove(matchId: string): Promise<void>
}
export const consumedStore: ConsumedStore = {
  async put(item) { await transact(CONSUMED, 'readwrite', (s) => s.put(item)) },
  list: () => transact(CONSUMED, 'readonly', (s) => s.getAll()),
  async remove(id) { await transact(CONSUMED, 'readwrite', (s) => s.delete(id)) },
}

/** A ticket taken this long ago with no record queued is reported as abandoned (longer than the longest match plus its grace). */
export const REPORT_AFTER_MS = 2 * 60 * 60 * 1000
/** Entries nobody can report any more (the ticket expired long ago) are dropped. */
export const LEDGER_KEEP_MS = 16 * 24 * 60 * 60 * 1000

/** Pool sizes: levels the player has played keep five tickets, the other levels of a game they open keep two. */
export const PLAYED_POOL = 5
export const OTHER_POOL = 2

/** Games that can have offline tickets: Word Duel keeps its seed on the server, so it plays unranked offline, and a game with no rated path has nothing to count. */
export const ticketGamesFor = (notOpen: readonly GameId[]): GameId[] => (Object.keys(PRODUCT.games) as GameId[]).filter((g) => !isSealed(g) && !notOpen.includes(g) && !NO_OFFLINE_TICKETS.includes(g))
export const TICKET_GAMES: readonly GameId[] = ticketGamesFor(RATED_NOT_OPEN)

const PLAYED_KEY = 'duelwise.played-levels'
type Played = Partial<Record<GameId, Level[]>>

function readPlayed(): Played {
  try { return JSON.parse(localStorage.getItem(PLAYED_KEY) ?? '{}') as Played } catch { return {} }
}
/** Remembers that the player started a counted match at this level, so its pool is kept full. */
export function notePlayed(game: GameId, level: Level): void {
  try {
    const all = readPlayed()
    const levels = new Set(all[game] ?? [])
    levels.add(level)
    localStorage.setItem(PLAYED_KEY, JSON.stringify({ ...all, [game]: [...levels] }))
  } catch { /* storage blocked: pools stay at the smaller size */ }
}
export const playedLevels = (game: GameId): Level[] => (readPlayed()[game] ?? []).filter((l): l is Level => LEVELS.includes(l))

/** A ticket is usable while it has not expired and was issued for the agent version this build plays. */
export function usable(t: Ticket, now: number, version: (game: GameId, level: Level) => string = bundleAgentVersion): boolean {
  return t.expiresAt > now && t.agentVersion === version(t.game, t.level)
}

/**
 * Takes one usable ticket for a game and level out of the store (the soonest to expire first), or null. Used when the server
 * cannot be reached at the start of a match. The ticket is removed first: it is single use, and a crash mid-match must not
 * hand the same one out again.
 */
export async function takeLocalTicket(
  game: GameId,
  level: Level,
  store: TicketStore = ticketStore,
  now = Date.now(),
  version?: (game: GameId, level: Level) => string,
  viewer: TicketOwner | null = rememberedViewer(),
  ledger: ConsumedStore = consumedStore,
): Promise<Ticket | null> {
  // Another player's ticket (a sign-out or a different account on this device) would be refused on upload: never hand it out.
  const mine = (await store.list()).filter((t) => t.game === game && t.level === level && usable(t, now, version) && (!viewer || ownsTicket(t.owner, viewer))).sort((a, b) => a.expiresAt - b.expiresAt)
  const pick = mine[0]
  if (!pick) return null
  // The ledger entry is written first: if the tab dies right after, the match is still on record as started.
  await ledger.put({ matchId: pick.matchId, game: pick.game, owner: pick.owner, takenAt: now }).catch(() => {})
  await store.remove(pick.matchId)
  return pick
}

/** The match's record is queued, so the server will hear of it from the upload: it is no longer an unfinished offline match. */
export const settleConsumed = (matchId: string, ledger: ConsumedStore = consumedStore): Promise<void> => ledger.remove(matchId).catch(() => {})

/** Forgets what belongs to the person who just signed out: unused tickets and who this browser was. Never throws. */
export async function forgetTickets(store: { clear(): Promise<void> } = { clear: () => transact(TICKETS, 'readwrite', (s) => s.clear()).then(() => undefined) }): Promise<void> {
  rememberViewer(null)
  try { await store.clear() } catch { /* nothing stored or storage blocked */ }
}

export interface TicketApi {
  issue(input: { game: GameId; level: Level; count: number; sides?: 1 }): Promise<Ticket[]>
  /** Who the server sees this browser as. Absent in a test double that does not care about owners. */
  viewer?(): Promise<TicketOwner>
  /** Reports ticket matches that were started and never finished; answers the ids the server has settled. */
  abandon?(matchIds: string[]): Promise<string[]>
}

export const serverTicketApi: TicketApi = {
  async issue(input) {
    const { issueTickets } = await import('../server/matches')
    const r = (await issueTickets({ data: input })) as { tickets: Ticket[] } | { error: string }
    if ('error' in r) throw new Error(r.error)
    return r.tickets
  },
  async viewer() {
    const { issueTickets } = await import('../server/matches')
    const r = (await issueTickets({ data: { game: 'four', level: 'easy', count: 0 } })) as { viewer: TicketOwner } | { error: string }
    if ('error' in r) throw new Error(r.error)
    return r.viewer
  },
  async abandon(matchIds) {
    const { abandonTickets } = await import('../server/matches')
    const r = (await abandonTickets({ data: { matchIds } })) as { settled: string[] } | { error: string }
    if ('error' in r) throw new Error(r.error)
    return r.settled
  },
}

let refilling: Promise<unknown> = Promise.resolve()
/**
 * Tops up the pools for one game (or every ticket game) while online. Drops expired tickets and ones for an agent version this
 * build does not play, then asks the server only for what is missing. Never throws: tickets are a convenience.
 */
export function refillTickets(games: readonly GameId[] = TICKET_GAMES, api: TicketApi = serverTicketApi, store: TicketStore = ticketStore, now = Date.now(), ledger: ConsumedStore = consumedStore): Promise<number> {
  // One refill at a time (two pages opening together must not both top up the same pool); later calls wait their turn.
  const run = refilling.then(async () => {
    let added = 0
    try {
      const viewer = (await api.viewer?.()) ?? null
      if (viewer) {
        // Whoever is signed in now may differ from whoever the tickets were issued to: those tickets would be refused on upload.
        rememberViewer(viewer)
        await reportUnfinished(api, ledger, viewer, now).catch(() => 0)
      }
      const have = await store.list()
      for (const t of have) if (!usable(t, now) || (viewer && !ownsTicket(t.owner, viewer))) await store.remove(t.matchId)
      const live = have.filter((t) => usable(t, now) && (!viewer || ownsTicket(t.owner, viewer)))
      for (const game of games) {
        if (!TICKET_GAMES.includes(game)) continue
        const played = new Set(playedLevels(game))
        for (const level of LEVELS) {
          const target = played.has(level) ? PLAYED_POOL : OTHER_POOL
          const need = target - live.filter((t) => t.game === game && t.level === level).length
          if (need <= 0) continue
          for (const t of await api.issue({ game, level, count: need, sides: 1 })) {
            await store.put(t)
            added++
          }
        }
      }
    } catch { /* offline or rate limited: try again on the next visit */ }
    return added
  })
  refilling = run.catch(() => {})
  return run
}

/**
 * Tells the server about offline tickets this browser played on and never finished (the tab was closed on a losing match), so the
 * server can charge the loss as it does for an online abandon. Entries of another player are left alone until they are old.
 */
export async function reportUnfinished(api: TicketApi, ledger: ConsumedStore, viewer: TicketOwner, now = Date.now()): Promise<number> {
  if (!api.abandon) return 0
  const all = await ledger.list()
  for (const c of all) if (now - c.takenAt > LEDGER_KEEP_MS) await ledger.remove(c.matchId)
  const due = all.filter((c) => now - c.takenAt <= LEDGER_KEEP_MS && now - c.takenAt >= REPORT_AFTER_MS && ownsTicket(c.owner, viewer))
  let reported = 0
  for (let i = 0; i < due.length; i += 20) {
    const ids = due.slice(i, i + 20).map((c) => c.matchId)
    const done = await api.abandon(ids)
    for (const id of done) await ledger.remove(id)
    reported += done.length
  }
  return reported
}
