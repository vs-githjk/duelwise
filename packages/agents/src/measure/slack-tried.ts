import type { Level } from '@duelwise/core/src/product'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { createGameAgent as createSlackAgent } from '../slack/agent'
import { SLACK_LEVELS, type SlackLevelConfig } from '../slack/levels'

// A6: the Crosscurrent agent under test in a people measurement: the shipped level, plus an optional override of its settings from SLACK_PEOPLE_OVERRIDE
// (JSON: { "<level>": { "randomPercent": 30 } }). The settings are merged into the level table when this module loads, in each process that loads it,
// so the child processes the harness starts see them. Unset, it plays exactly the shipped level. A measurement script only, never imported by the site.
export const OVERRIDE_ENV = 'SLACK_PEOPLE_OVERRIDE'

export function overrideFor(level: Level, raw: string | undefined = process.env[OVERRIDE_ENV]): Partial<SlackLevelConfig> | undefined {
  if (!raw) return undefined
  return (JSON.parse(raw) as Record<string, Partial<SlackLevelConfig>>)[level]
}

for (const level of Object.keys(SLACK_LEVELS) as Level[]) {
  const over = overrideFor(level)
  if (over) SLACK_LEVELS[level] = { ...SLACK_LEVELS[level], ...over } as SlackLevelConfig
}

export const createGameAgent = (level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> => createSlackAgent(level, opts)
