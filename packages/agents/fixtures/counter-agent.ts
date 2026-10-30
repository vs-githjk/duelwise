import type { Level } from '@duelwise/core/src/product'
import type { AgentOpts, PreviewAgent } from '../src/agent-types'
import { createStubAgent } from '../src/stub-agent'
import { createCounterGame } from '@duelwise/core/src/testing/counter-game'

// Test factory for the worker: random legal counter-game agent (the stub with the counter core injected,
// because cores cannot be sent to a worker).
export async function createGameAgent(level: Level, opts?: AgentOpts): Promise<PreviewAgent> {
  return createStubAgent('four', level, { ...opts, core: createCounterGame('four') })
}
