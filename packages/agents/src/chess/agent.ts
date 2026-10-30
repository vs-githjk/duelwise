import registry from '../../registry/chess.json'
import type { ChessObservation, ChessState } from '@duelwise/core/src/games/chess/core'
import { encodeAbs } from '@duelwise/core/src/games/chess/policy-index'
import type { Level } from '@duelwise/core/src/product'
import type { Agent, AgentOpts, PreviewAgent } from '../agent-types'
import { createStubAgent } from '../stub-agent'
import { Searcher, type SearchOpts } from './alphabeta'
import { loadModelBytes, ModelMissingError } from './model-files'
import { createPolicyAgent, type PolicyConfig } from './policy-agent'
import { ValueNet } from './value-eval'

/** Level configs: the same values are written into packages/agents/registry/chess.json. */
export const CHESS_LEVELS: Record<'easy' | 'medium' | 'hard', PolicyConfig> = {
  easy: { band: 'b1100', temperature: 1, topP: 0.9, guard: 'mate' },
  medium: { band: 'b1500', temperature: 1, guard: 'material', guardMargin: 2 },
  hard: { band: 'b1900', temperature: 0, logitMargin: 0.5, guard: 'material', guardMargin: 1 },
}

/** Champion node budget: the value the registry records as measuredNodeBudget (about 1 s a move on the measuring machine). */
export function championNodeBudget(data: { levels: Record<string, { config: Record<string, unknown> }>; unpublishedConfig?: Record<string, Record<string, unknown>> }): number {
  const value = data.levels.champion?.config.measuredNodeBudget ?? data.unpublishedConfig?.champion?.measuredNodeBudget
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('chess Champion node budget is missing from the registry')
  return value
}
export const CHAMPION_NODE_BUDGET = championNodeBudget(registry)

/** Champion: search with the TS value net on a fixed node budget and no time cap. The move depends only on the position,
 *  so the page, the measurement ladder and the server check all play the same move, however fast the device is. */
export const CHAMPION_SEARCH: SearchOpts = { nodeBudget: CHAMPION_NODE_BUDGET, maxDepth: 64 }

/** How long the page may say "thinking" before it shows a slow-device hint. Display only: it never stops the search. */
export const CHAMPION_DISPLAY_GUARD_MS = 3000

export interface ChessAgentOpts extends AgentOpts {
  /** Replace the Champion's budgets (the measurement ladder passes a fixed node budget). */
  search?: SearchOpts
  /** Model bytes given directly (tests); otherwise fetched or read from /agents/chess/v1. */
  valueBytes?: Uint8Array
  policyBytes?: Uint8Array
  /** Transposition table size for the Champion, as a power of two. */
  ttBits?: number
}

export async function createChampionAgent(opts: ChessAgentOpts = {}): Promise<Agent> {
  const net = new ValueNet(opts.valueBytes ?? (await loadModelBytes('value.bin')))
  const searcher = new Searcher(net, opts.ttBits ?? 20)
  return {
    reset() {
      searcher.clear()
    },
    async act(obs, state) {
      const o = obs as ChessObservation
      // Earlier positions of this game (not the current one), so a repeat counts as a draw inside the search.
      const keys = (state as ChessState | undefined)?.keys
      const priorKeys = keys ? keys.slice(0, -1) : undefined
      const r = searcher.search(o.fen, { ...CHAMPION_SEARCH, ...opts.search, priorKeys })
      return [encodeAbs(r.uci)]
    },
    dispose() {},
  }
}

export async function createGameAgent(level: Level, opts: ChessAgentOpts = {}): Promise<PreviewAgent> {
  try {
    if (level === 'champion') return Object.assign(await createChampionAgent(opts), { preview: false })
    const config = CHESS_LEVELS[level]
    const bytes = opts.policyBytes ?? (await loadModelBytes(`policy-${config.band}.onnx`))
    // The value net lets Medium and Hard avoid repeating a position when they are winning; without it they play on as before.
    let value: ValueNet | undefined
    try {
      value = new ValueNet(opts.valueBytes ?? (await loadModelBytes('value.bin')))
    } catch (e) {
      if (!(e instanceof ModelMissingError)) throw e
    }
    return Object.assign(await createPolicyAgent(config, bytes, { seat: opts.seat, value }), { preview: false })
  } catch (e) {
    // A model that is not published yet leaves the level a labelled preview; any other failure is a real error.
    if (!(e instanceof ModelMissingError)) throw e
    return createStubAgent('chess', level, opts)
  }
}
