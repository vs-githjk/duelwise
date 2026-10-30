import type { Level } from '@duelwise/core/src/product'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { createStubAgent } from '../stub-agent'

/** The random-legal-move baseline for the Four in a Row ladder, as a module the harness can load by path. */
export async function createGameAgent(level: Level, opts?: AgentOpts): Promise<PreviewAgent> {
  return createStubAgent('four', level, opts)
}
