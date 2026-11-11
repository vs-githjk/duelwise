import type { Level } from '@duelwise/core/src/product'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { CHAMPION_NODE_BUDGET, CHESS_LEVELS, createChampionAgent } from '../chess/agent'
import { loadModelBytes, ModelMissingError } from '../chess/model-files'
import { createPolicyAgent, type PolicyConfig } from '../chess/policy-agent'
import { ValueNet } from '../chess/value-eval'

// A5: the chess agent under test in a people measurement: the shipped level, with the Champion on its measured node budget and no time cap (as chess.ts),
// plus an optional override from CHESS_PEOPLE_OVERRIDE (JSON: { "<level>": { "temperature": 0.7, "guardMargin": 3 }, "champion": { "nodeBudget": 40000 } }).
// With the variable unset it plays exactly the shipped level.
export const OVERRIDE_ENV = 'CHESS_PEOPLE_OVERRIDE'

export type ChessOverride = Partial<PolicyConfig> & { nodeBudget?: number }

export function overrideFor(level: Level, raw: string | undefined = process.env[OVERRIDE_ENV]): ChessOverride | undefined {
  if (!raw) return undefined
  return (JSON.parse(raw) as Record<string, ChessOverride>)[level]
}

export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const over = overrideFor(level)
  if (level === 'champion') {
    const nodeBudget = over?.nodeBudget ?? CHAMPION_NODE_BUDGET
    return Object.assign(await createChampionAgent({ ...opts, search: { nodeBudget, timeCapMs: undefined } }), { preview: false })
  }
  const { nodeBudget: _ignored, ...policy } = over ?? {}
  const config: PolicyConfig = { ...CHESS_LEVELS[level as 'easy' | 'medium' | 'hard'], ...policy }
  const bytes = await loadModelBytes(`policy-${config.band}.onnx`)
  let value: ValueNet | undefined
  try {
    value = new ValueNet(await loadModelBytes('value.bin'))
  } catch (e) {
    if (!(e instanceof ModelMissingError)) throw e
  }
  return Object.assign(await createPolicyAgent(config, bytes, { seat: opts.seat, value }), { preview: false })
}
