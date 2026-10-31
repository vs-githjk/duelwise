import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import type { Registry } from '@duelwise/agents/src/registry'
import { LEVELS, inTrainingCopy } from '../lib/level-info'
import { strengthLine as fighterStrengthLine } from '../games/fighter/strength'
import { strengthLine as arenaStrengthLine } from '../games/arena/strength'
import { reactionLimit, type ReactionLimit } from './index'

export type CastCell =
  | { state: 'measured'; strength: string; reaction: ReactionLimit | null }
  | { state: 'in-training'; reason: string; practice: boolean }

export interface CastRow {
  game: GameId
  displayName: string
  realtime: boolean
  cells: Record<Level, CastCell>
}

/** One row per game for the "The AI" table. Every value is read from the game's registry file. */
export function buildCast(registries: Partial<Record<GameId, Registry | null>>): CastRow[] {
  return (Object.keys(PRODUCT.games) as GameId[]).map((game) => {
    const reg = registries[game] ?? null
    const realtime = PRODUCT.games[game].kind === 'realtime'
    const cells = {} as Record<Level, CastCell>
    for (const level of LEVELS) {
      const measured = reg?.measured[level]
      const entry = reg?.levels[level]
      cells[level] =
        measured && entry
          ? { state: 'measured', strength: realtime ? (game === 'arena' ? arenaStrengthLine(reg, level) : fighterStrengthLine(reg, level)) : `site Elo ${Math.round(measured.siteElo)}`, reaction: realtime ? reactionLimit(level, entry.config) : null }
          : { state: 'in-training', practice: true, reason: game === 'arena' ? arenaStrengthLine(reg, level) : reg?.unpublished?.[level] ? inTrainingCopy(level, reg.unpublished[level]) : 'In training' }
    }
    return { game, displayName: PRODUCT.games[game].displayName, realtime, cells }
  })
}
