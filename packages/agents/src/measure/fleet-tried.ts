import type { Level } from '@duelwise/core/src/product'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { createGameAgent as createFleetAgent } from '../fleet/agent'
import { FLEET_LEVELS, type FleetLevel } from '../fleet/levels'

// A6: the Stormglass agent under test in a people measurement: the shipped level, plus an optional override from FLEET_PEOPLE_OVERRIDE
// (JSON: { "<level>": { "followRate": 0.2, "hunt": "random" } }), merged into the level table when this module loads. Unset, it plays the shipped level.
export const OVERRIDE_ENV = 'FLEET_PEOPLE_OVERRIDE'

export function overrideFor(level: Level, raw: string | undefined = process.env[OVERRIDE_ENV]): Partial<FleetLevel> | undefined {
  if (!raw) return undefined
  return (JSON.parse(raw) as Record<string, Partial<FleetLevel>>)[level]
}

for (const level of Object.keys(FLEET_LEVELS) as Level[]) {
  const over = overrideFor(level)
  if (over) FLEET_LEVELS[level] = { ...FLEET_LEVELS[level], ...over }
}

export const createGameAgent = (level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> => createFleetAgent(level, opts)
