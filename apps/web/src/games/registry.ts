import type { ComponentType } from 'react'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'

/**
 * A game is playable when apps/web/src/games/<folder>/index.tsx exists. This file discovers the folders
 * with import.meta.glob, so a lane adds a game by adding a folder and never edits a route.
 * The module's default export is the play page component; an optional `meta.title` names a folder that
 * is not one of the six product games (used by the shell test fixture).
 */
export interface GameModule {
  default: ComponentType
  meta?: { title?: string }
}

const modules = import.meta.glob<GameModule>('./*/index.tsx')

export interface DiscoveredGame {
  /** Folder name; a GameId for the six product games. */
  folder: string
  load: () => Promise<GameModule>
}

const FOLDER = /^\.\/([^/]+)\/index\.tsx$/

export function discoveredGames(): DiscoveredGame[] {
  const out: DiscoveredGame[] = []
  for (const [path, load] of Object.entries(modules)) {
    const m = FOLDER.exec(path)
    if (m) out.push({ folder: m[1]!, load })
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder))
}

export function isPlayable(id: GameId): boolean {
  return discoveredGames().some((g) => g.folder === id)
}

export function loadGame(folder: string): Promise<GameModule> | null {
  return discoveredGames().find((g) => g.folder === folder)?.load() ?? null
}

export function gameBySlug(slug: string): GameId | null {
  for (const [id, cfg] of Object.entries(PRODUCT.games)) if (cfg.slug === slug) return id as GameId
  return null
}

/** Folders that are not product games (fixtures, experiments). They still appear in /play. */
export function extraFolders(): string[] {
  return discoveredGames()
    .map((g) => g.folder)
    .filter((f) => !Object.prototype.hasOwnProperty.call(PRODUCT.games, f))
}
