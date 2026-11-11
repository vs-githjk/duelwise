import type { Level } from '@duelwise/core/src/product'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { createGameAgent as createPenaltyAgent } from '../penalty/agent'
import { PENALTY_LEVELS, type PenaltyLevelConfig } from '../penalty/levels'

// A7: the Twelve Yards agent under test in a people measurement: the shipped level, plus an optional override of its settings from PENALTY_PEOPLE_OVERRIDE
// (JSON: { "<level>": { "read": 0.4 } }). The settings are merged into the level table when this module loads, in each process that loads it, so the child
// processes the harness starts see them. Unset, it plays exactly the shipped level. A measurement script only, never imported by the site.
export const OVERRIDE_ENV = 'PENALTY_PEOPLE_OVERRIDE'

export function overrideFor(level: Level, raw: string | undefined = process.env[OVERRIDE_ENV]): Partial<PenaltyLevelConfig> | undefined {
  if (!raw) return undefined
  return (JSON.parse(raw) as Record<string, Partial<PenaltyLevelConfig>>)[level]
}

for (const level of Object.keys(PENALTY_LEVELS) as Level[]) {
  const over = overrideFor(level)
  if (over) PENALTY_LEVELS[level] = { ...PENALTY_LEVELS[level], ...over } as PenaltyLevelConfig
}

export const createGameAgent = (level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> => createPenaltyAgent(level, opts)
