import { verifiedStrength } from '../lib/strength-gates'
import { validateRegistry, type Registry } from '@duelwise/agents/src/registry'
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader, setResponseStatus } from '@tanstack/react-start/server'
import type { GameId, Level } from '@duelwise/core/src/product'
import { getServerDb } from './server-db'
import { abandonStale } from './abandon'
import { expireTickets } from './tickets'
import { abandonTicketsHandler, issueTicketsHandler } from './ticket-issue'
import { finishMatchFromUpload, startMatchHandler, sweepDeferredChecks } from './match-handlers'
import { callerFromRequest } from './caller'
import { ratedSiteElo } from './ratings'
import { gameRecordsTrainable } from './stats-fns'

// Registry JSON files ship inside the bundle, so the server can name the agent version without
// reading the disk. A game without a registry yet serves its preview stub, "v1".
const REGISTRIES = import.meta.glob('../../../../packages/agents/registry/*.json', { eager: true, import: 'default' }) as Record<
  string,
  { levels?: Partial<Record<Level, { version?: string }>>; champion?: string; measured?: Partial<Record<Level, { siteElo?: number }>> }
>

export function agentVersionFor(game: GameId, level: Level): string {
  const entry = Object.entries(REGISTRIES).find(([path]) => path.endsWith(`/${game}.json`))?.[1]
  return entry?.levels?.[level]?.version ?? entry?.champion ?? 'v1'
}

export function siteEloFor(game: GameId, level: Level): number | null {
  const entry = Object.entries(REGISTRIES).find(([path]) => path.endsWith(`/${game}.json`))?.[1]
  return entry && validateRegistry(entry).ok && verifiedStrength(entry as Registry, level) ? ratedSiteElo(game, entry.measured?.[level]?.siteElo) : null
}

/**
 * Settles counted matches that outlived their game's limit (a loss for the player, kept out of
 * training). Runs on the write paths and before the leaderboard is read; a failure here must never
 * break the request that triggered it.
 */
export async function sweepAbandoned(db: Awaited<ReturnType<typeof getServerDb>>['db'], now: Date = new Date()): Promise<void> {
  try {
    await abandonStale(db, now, { siteElo: siteEloFor })
    await sweepDeferredChecks(db, now)
    await expireTickets(db, now)
  } catch (e) {
    console.error('abandon sweep failed', e instanceof Error ? e.message : e)
  }
}

export const startMatch = createServerFn({ method: 'POST' })
  .validator((d: unknown) => d)
  .handler(async ({ data }) => {
    const { db } = await getServerDb()
    const who = await callerFromRequest()
    await sweepAbandoned(db)
    const r = await startMatchHandler(db, data, who, { agentVersion: agentVersionFor, recordsTrainable: gameRecordsTrainable, siteElo: siteEloFor, userAgent: getRequestHeader('user-agent') })
    setResponseStatus(r.status)
    return r.body
  })

export const finishMatch = createServerFn({ method: 'POST' })
  .validator((d: unknown) => d)
  .handler(async ({ data }) => {
    const { db } = await getServerDb()
    const who = await callerFromRequest()
    await sweepAbandoned(db)
    // Loaded here, not at the top: the check reaches the agent code and node:fs, which the browser bundle of this file must not contain.
    const { serverFinishOptions } = await import('./finish-options')
    const r = await finishMatchFromUpload(db, data, getRequestHeader('content-length'), who, serverFinishOptions())
    setResponseStatus(r.status)
    return r.body
  })

/** Tops up the caller's pool of offline match tickets (see tickets.ts). Called only while online. */
export const issueTickets = createServerFn({ method: 'POST' })
  .validator((d: unknown) => d)
  .handler(async ({ data }) => {
    const { db } = await getServerDb()
    const who = await callerFromRequest()
    const r = await issueTicketsHandler(db, data, who, { agentVersion: agentVersionFor, recordsTrainable: gameRecordsTrainable })
    setResponseStatus(r.status)
    return r.body
  })

/** Settles offline tickets the browser played on but never sent a record for, as abandoned (a loss for a signed-in player). */
export const abandonTickets = createServerFn({ method: 'POST' })
  .validator((d: unknown) => d)
  .handler(async ({ data }) => {
    const { db } = await getServerDb()
    const who = await callerFromRequest()
    const r = await abandonTicketsHandler(db, data, who, { siteElo: siteEloFor })
    setResponseStatus(r.status)
    return r.body
  })
