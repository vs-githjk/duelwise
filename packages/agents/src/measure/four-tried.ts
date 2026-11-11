import type { Level } from '@duelwise/core/src/product'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { createGameAgent as createFourAgent, type FourLevelConfig } from '../four/agent'

// A5: the Four in a Row agent under test in a people measurement: the shipped level with the simulation counts and no time cap (as four.ts), plus an
// optional override of its settings from FOUR_PEOPLE_OVERRIDE (JSON: { "<level>": { "sims": 12, "temperature": 0.5 } }), so a tuning try is one env var
// and the child processes the harness starts see it too. With the variable unset it plays exactly the shipped level.
export const OVERRIDE_ENV = 'FOUR_PEOPLE_OVERRIDE'

export function overrideFor(level: Level, raw: string | undefined = process.env[OVERRIDE_ENV]): Partial<FourLevelConfig> | undefined {
  if (!raw) return undefined
  const all = JSON.parse(raw) as Record<string, Partial<FourLevelConfig>>
  return all[level]
}

export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  return createFourAgent(level, { ...opts, config: overrideFor(level), search: { timeCapMs: undefined } })
}
