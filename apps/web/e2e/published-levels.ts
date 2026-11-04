import { visibleRegistry } from '../src/lib/strength-gates'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type LevelName = 'easy' | 'medium' | 'hard' | 'champion'
export const ALL_LEVELS: readonly LevelName[] = ['easy', 'medium', 'hard', 'champion']

/** The levels a game's registry publishes, read from the same file the page reads, so a spec follows the registry and never a fixed list. */
export function publishedLevels(game: 'fighter' | 'arena' | 'fleet' | 'slack' | 'penalty'): LevelName[] {
  const reg = visibleRegistry(JSON.parse(readFileSync(join(import.meta.dirname, '../../../packages/agents/registry', `${game}.json`), 'utf8')))
  return ALL_LEVELS.filter((l) => reg.levels[l] !== undefined)
}

/** Whether a game's registry says its agent learns from human matches (it picks the training lines the pages show). */
export function learnsFromHumans(game: 'fighter' | 'arena'): boolean {
  const reg = JSON.parse(readFileSync(join(import.meta.dirname, '../../../packages/agents/registry', `${game}.json`), 'utf8')) as { learnsFromHumans: boolean }
  return reg.learnsFromHumans === true
}
