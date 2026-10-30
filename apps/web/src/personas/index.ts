import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import data from './personas.json'

/**
 * The cast: four characters shared by all six games (design v3). This module holds names, bios and
 * per-game style lines only. Ratings and reaction limits are never stored here; they come from the
 * registries and PRODUCT (see cast.ts).
 */
export interface Persona {
  name: string
  level: string
  avatar: string
  bio: string
  style: Record<GameId, string>
}

export const PERSONAS = data.personas as unknown as Record<Level, Persona>
export const RESULT_TEMPLATES = data.result_reaction_templates as Record<string, string>

export function personaFor(level: Level): Persona {
  return PERSONAS[level]
}

export function styleLine(level: Level, game: GameId): string {
  return PERSONAS[level].style[game]
}

/** Simulation tick rate the frame counts in the level configs are measured at. */
const SIM_HZ = 60

export interface ReactionLimit {
  frames: number
  ms: number
  /** Actions per minute cap, or null when the level has none. */
  apm: number | null
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Human-like reaction limit for a realtime level. Source: the level config, else PRODUCT for the champion. */
export function reactionLimit(level: Level, config: Record<string, unknown> | undefined): ReactionLimit | null {
  const frames = finite(config?.reactionFrames) ? config.reactionFrames : level === 'champion' ? PRODUCT.championMinDelayFrames : null
  if (frames === null) return null
  return { frames, ms: Math.round((frames * 1000) / SIM_HZ), apm: finite(config?.apmCap) ? config.apmCap : null }
}
