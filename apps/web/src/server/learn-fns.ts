import { and, eq, gt, sql } from 'drizzle-orm'
import { createServerFn } from '@tanstack/react-start'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import { getServerDb } from './server-db'
import { gameRecordsTrainable, registryFor } from './stats-fns'
import { getGameStats, trainingEligible, withRegistryRuns } from './stats'
import type { ChampionFacts } from '../lib/learn-copy'

export interface LearnVersion {
  version: string
  parent: string | null
  promotedAt: string | null
  humanMatchesUsed: number
  isChampion: boolean
  /** The gate sentence from the registry, shortened to one line. */
  rule: string | null
}

export interface LearnView {
  game: GameId
  /** The one honesty switch: this game's records are trainable, so its agent learns from people. */
  learns: boolean
  weekly: Array<{ start: string; levels: Partial<Record<Level, { games: number; wins: number }>> }>
  versions: LearnVersion[]
  champion: ChampionFacts | null
  /** Finished, replay-valid matches since the champion shipped. */
  sinceCount: number
  /** Of those, the ones a training run may pick from: the player allowed training and no filter flagged it. Eligible is not used: a run samples from them. */
  sinceEligible: number
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function gateFacts(gate: unknown): ChampionFacts['gate'] {
  if (!isObj(gate) || typeof gate.score !== 'number' || typeof gate.n !== 'number' || !Array.isArray(gate.ci95) || gate.ci95.length !== 2) return null
  const [a, b] = gate.ci95
  return typeof a === 'number' && typeof b === 'number' ? { score: gate.score, n: gate.n, ci95: [a, b] } : null
}

const oneLine = (rule: string): string => {
  const first = rule.replace(/^R\d+:\s*/, '').split(/[;:]/)[0]!.trim()
  return first.length > 110 ? `${first.slice(0, 107)}...` : first
}

/** Everything the "watch the AI learn" graph and its words need for one game, from the match store and the registry. Nothing is invented. */
export const getLearnView = createServerFn({ method: 'GET' })
  .validator((d: unknown) => {
    const game = (d as { game?: unknown } | null)?.game
    if (typeof game !== 'string' || !Object.prototype.hasOwnProperty.call(PRODUCT.games, game)) throw new Error('unknown game')
    return { game: game as GameId }
  })
  .handler(async ({ data }): Promise<LearnView> => {
    const { db } = await getServerDb()
    const reg = registryFor(data.game)
    const learns = gameRecordsTrainable(data.game)
    const stats = withRegistryRuns(await getGameStats(db, data.game, new Date(), undefined, learns), reg)
    const championRow = reg?.versions.find((v) => v.version === reg.champion) ?? null
    const versions: LearnVersion[] = [...(reg?.versions ?? [])]
      .sort((a, b) => (b.promotedAt ?? b.createdAt).localeCompare(a.promotedAt ?? a.createdAt))
      .map((v) => ({
        version: v.version,
        parent: v.parent,
        promotedAt: v.promotedAt ?? null,
        humanMatchesUsed: v.humanMatchesUsed,
        isChampion: v.version === reg?.champion,
        rule: isObj(v.gate) && typeof v.gate.rule === 'string' ? oneLine(v.gate.rule) : null,
      }))
    let sinceCount = 0
    let sinceEligible = 0
    if (championRow?.promotedAt && learns) {
      const since = new Date(championRow.promotedAt)
      const rows = await db
        .select({ filterFlags: schema.match.filterFlags, trainingAllowed: schema.match.trainingAllowed })
        .from(schema.match)
        .where(and(eq(schema.match.game, data.game), eq(schema.match.status, 'finished'), eq(schema.match.recordValid, true), sql`${schema.match.filterFlags}->>'deferredCheckAt' is null`, gt(schema.match.finishedAt, since)))
      sinceCount = rows.length
      sinceEligible = rows.filter(trainingEligible).length
    }
    return {
      game: data.game,
      learns,
      weekly: stats.weekly.map((w) => ({ start: w.start, levels: w.levels })),
      versions,
      champion: championRow ? { version: championRow.version, parent: championRow.parent, humanMatchesUsed: championRow.humanMatchesUsed, gate: gateFacts(championRow.gate) } : null,
      sinceCount,
      sinceEligible,
    }
  })
