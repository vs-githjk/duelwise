import type { Level } from '@duelwise/core/src/product'
import type { Registry } from '@duelwise/agents/src/registry'
import { PRACTICE_COPY } from '../games/fighter/strength'

export const LEVELS: readonly Level[] = ['easy', 'medium', 'hard', 'champion']

export const LEVEL_LABEL: Record<Level, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard', champion: 'Champion' }
export function isPracticeReason(reason?: string): boolean {
  return reason !== undefined && /no snapshot cleared|stays Practice|stays in training|Wilson lower bound .* is below/i.test(reason)
}

/**
 * Plain words for a level that is not published. The registry keeps the raw gate failure (numbers, intervals) for
 * the maintainers; players only get this sentence, which names the level below it.
 */
export function inTrainingCopy(level: Level, reason?: string): string {
  const name = LEVEL_LABEL[level]
  const below = LEVELS[LEVELS.indexOf(level) - 1]
  if (reason === undefined) {
    return below ? `${name} has not yet proven it beats ${LEVEL_LABEL[below]}.` : `${name} has not been measured yet.`
  }
  // R32: a level whose training finished but whose snapshots did not clear the scripted-bot gate is playable Practice.
  // A held level (arena.ts publish --hold) says "it stays Practice" in its reason; same playable Practice copy.
  if (isPracticeReason(reason)) return PRACTICE_COPY
  const beats = /(\w+) does not beat (\w+)/i.exec(reason)
  if (beats) return `${cap(beats[1]!)} has not yet proven it beats ${cap(beats[2]!)}.`
  // The level itself may have beaten the one below; it is held back because that one failed its own gate.
  const gate = /(\w+) did not pass its gate/i.exec(reason)
  if (gate) return `${name} is waiting until ${cap(gate[1]!)} is published.`
  return `${name} is still being measured.`
}

function cap(word: string): string {
  const w = word.toLowerCase()
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/** What the level picker shows for one level. Every field comes from the registry; nothing is invented. */
export interface LevelInfo {
  /** True until the level has a measured block in the registry. */
  preview: boolean
  practice?: boolean
  /** Measured strength string such as "site Elo 1000", only when measured. */
  strength?: string
  /** Set when the level failed its gate: this plain sentence is shown and the level is not selectable. */
  inTraining?: string
  /** True when the registry ships a model for the level, published or not. Practice may play it even while it is in training. */
  loadable?: boolean
}

export function levelInfoFromRegistry(reg: Registry | null): Record<Level, LevelInfo> {
  const out = {} as Record<Level, LevelInfo>
  for (const level of LEVELS) {
    const measured = reg?.measured[level]
    const published = Boolean(reg?.levels[level]) && Boolean(measured)
    out[level] = {
      preview: !published,
      practice: !published && (reg?.game === 'arena' || isPracticeReason(reg?.unpublished?.[level])),
      strength: measured ? `site Elo ${Math.round(measured.siteElo)}` : undefined,
      loadable: Boolean(reg?.levels[level]),
      inTraining: reg?.unpublished?.[level] ? inTrainingCopy(level, reg.unpublished[level]) : undefined,
    }
  }
  return out
}
