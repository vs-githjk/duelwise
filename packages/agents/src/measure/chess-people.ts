import type { Level } from '@duelwise/core/src/product'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { loadModelBytes } from '../chess/model-files'
import { createPolicyAgent, type PolicyConfig } from '../chess/policy-agent'
import type { Proxy } from './people'
import { PROXY_LEVEL } from './turn-people'

// A5: the chess panel of test players: the three human-imitation nets (trained on Lichess games by rating band, so they predict what people of that
// strength play) sampled at temperature 1, with no search, no tactical guard and no repetition filter. This is the Maia approach: a net trained on
// human games plays like those humans, blunders included. beginner = b1100, average = b1500, strong = b1900. The level under test keeps its own guard,
// temperature and margin, so a level that is a net plus a safety net is compared with people who have no safety net.

export const PROXY_CONFIG: Record<Proxy, PolicyConfig> = {
  beginner: { band: 'b1100', temperature: 1 },
  average: { band: 'b1500', temperature: 1 },
  strong: { band: 'b1900', temperature: 1 },
}

export const PROXY_WORDS: Record<Proxy, string> = {
  beginner: 'the human-imitation net for players rated about 1100, sampled at temperature 1 (no search, no safety net)',
  average: 'the human-imitation net for players rated about 1500, sampled at temperature 1 (no search, no safety net)',
  strong: 'the human-imitation net for players rated about 1900, sampled at temperature 1 (no search, no safety net)',
}

const LEVEL_PROXY: Record<string, Proxy> = Object.fromEntries((Object.entries(PROXY_LEVEL) as Array<[Proxy, Level]>).map(([p, l]) => [l, p]))

/** One test player as a harness agent. */
export async function createProxyAgent(proxy: Proxy, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const config = PROXY_CONFIG[proxy]
  const bytes = await loadModelBytes(`policy-${config.band}.onnx`)
  return Object.assign(await createPolicyAgent(config, bytes, { seat: opts.seat }), { preview: false })
}

/** The module hook the match harness loads: the level name picks the proxy (easy = beginner, medium = average, hard = strong). */
export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const proxy = LEVEL_PROXY[level]
  if (!proxy) throw new Error(`chess people panel: no test player for level ${level}`)
  return createProxyAgent(proxy, opts)
}
