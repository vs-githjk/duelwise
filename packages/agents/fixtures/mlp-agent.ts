import { join } from 'node:path'
import type { Level } from '@duelwise/core/src/product'
import { getCore } from '@duelwise/core/src/games/index'
import type { AgentOpts, PreviewAgent } from '../src/agent-types'
import { OrtSession } from '../src/runtime/ort-session'

interface CounterObs {
  total: number
  target: number
}

/**
 * Fixture agent for harness tests: the 4 -> 256 -> 256 -> 3 MLP scores the three counter-game moves
 * and the agent plays the best legal one. The weights are random, so the play is arbitrary but fixed.
 */
export async function createGameAgent(_level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const seat = opts.seat ?? 1
  const bytes = new Uint8Array(await Bun.file(join(import.meta.dir, 'mlp-2x256.onnx')).arrayBuffer())
  const session = await OrtSession.create(bytes)
  return {
    preview: false,
    reset() {},
    async act(obs, state) {
      const core = opts.core ?? getCore('four')
      const { total, target } = obs as CounterObs
      const x = new Float32Array([total / 20, target / 20, (target - total) / 20, 1])
      const { logits } = await session.run('x', x, [1, 4])
      const legal = core.legal(state, seat).map((a) => core.encodeAction(a))
      let best = legal[0]!
      for (const a of legal) if (logits![a - 1]! > logits![best - 1]!) best = a
      return [best]
    },
    dispose() {
      void session.dispose()
    },
  }
}
