import { PASS, type SlackObs } from '@duelwise/core/src/games/slack/core'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { fromCells, flipsOf, legalMoves } from '../slack/board'
import { searchMove } from '../slack/search'
import type { Proxy } from './people'
import { PROXY_LEVEL } from './turn-people'

// A6: the Crosscurrent panel of test players: a person's disc-flipping game, not a weaker copy of the AI.
//   beginner  counts discs: plays the move that flips the most, no idea that corners matter, and 35% of the time any legal move.
//   average   looks two moves ahead with the corner and edge weights, a wide wobble in its judgement, and 10% of the time any legal move.
//   strong    looks four moves ahead with mobility, a smaller wobble, and 5% of the time any legal move.
// Deterministic per seed. Crosscurrent has no hidden information, so these are all the people the panel needs.

export interface SlackProxyConfig {
  kind: 'greedy' | 'search'
  /** Chance in percent of any legal move instead of the evaluated one. */
  randomPercent: number
  depth?: number
  mobility?: boolean
  noise?: number
}

export const PROXY_CONFIG: Record<Proxy, SlackProxyConfig> = {
  beginner: { kind: 'greedy', randomPercent: 35 },
  average: { kind: 'search', randomPercent: 10, depth: 2, mobility: false, noise: 12 },
  strong: { kind: 'search', randomPercent: 5, depth: 4, mobility: true, noise: 6 },
}

export const PROXY_WORDS: Record<Proxy, string> = {
  beginner: 'flips the most discs every move (no sense of corners), 35% of the time any legal move',
  average: 'looks two moves ahead with corner and edge weights and a wide wobble, 10% of the time any legal move',
  strong: 'looks four moves ahead with mobility and a small wobble, 5% of the time any legal move',
}

/** The cell a test player of this kind plays for an observation. A forced pass is PASS. */
export function proxyMove(proxy: Proxy, obs: SlackObs, rng: Rng, cfg: SlackProxyConfig = PROXY_CONFIG[proxy]): number {
  if (!obs.toMove || obs.legal.length === 0) throw new Error('slack people: seat is not to move')
  if (obs.legal.length === 1 && obs.legal[0] === PASS) return PASS
  if (rng.int(100) < cfg.randomPercent) return obs.legal[rng.int(obs.legal.length)]!
  if (cfg.kind === 'greedy') {
    const board = fromCells(obs.cells)
    let best = -1
    const top: number[] = []
    for (const m of legalMoves(board, 1)) {
      const v = flipsOf(board, m, 1).length
      if (v > best) {
        best = v
        top.length = 0
      }
      if (v === best) top.push(m)
    }
    return top[rng.int(top.length)]!
  }
  return searchMove(obs.cells, 0, { maxDepth: cfg.depth!, mobility: cfg.mobility ?? false, noise: cfg.noise ?? 0, rng }).move
}

export function createProxyAgent(proxy: Proxy, opts: AgentOpts = {}): PreviewAgent {
  let seat = opts.seat ?? 1
  let rng: Rng = makeRng(0)
  return {
    preview: false,
    reset(seed, forSeat) {
      if (forSeat !== undefined) seat = forSeat
      rng = makeRng((seed ^ Math.imul(seat + 1, 0x9e3779b1) ^ 0x2545f491) | 0)
    },
    async act(obs) {
      return [proxyMove(proxy, obs as SlackObs, rng)]
    },
    dispose() {},
  }
}

const LEVEL_PROXY: Record<string, Proxy> = Object.fromEntries((Object.entries(PROXY_LEVEL) as Array<[Proxy, Level]>).map(([p, l]) => [l, p]))

/** The module hook the match harness loads: the level name picks the proxy (easy = beginner, medium = average, hard = strong). */
export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const proxy = LEVEL_PROXY[level]
  if (!proxy) throw new Error(`slack people panel: no test player for level ${level}`)
  return createProxyAgent(proxy, opts)
}
