import { COLS, isLegalColumn, type FourState } from '@duelwise/core/src/games/four/rules'
import type { FourObservation } from '@duelwise/core/src/games/four/core'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { stateFromObservation } from '../four/agent'
import { provenKeepers, safeColumns, threatColumns, winningColumns } from '../four/tactics'
import type { Proxy } from './people'
import { PROXY_LEVEL } from './turn-people'

// A5: the Four in a Row panel of test players, built on the game's perfect solver so each one is a stated kind of person, not a weaker copy of an AI.
//   beginner  takes a win in one every time, blocks a one-move threat 60% of the time, otherwise drops where the centre-weighted dice say.
//   average   always wins, always blocks, never hands over a win in one, otherwise centre-weighted dice among the safe columns.
//   strong    plays a column the solver proves keeps the game value (from 10 stones, where the solver is quick), 15% of the time a random legal column.
//             Before 10 stones, or when the solver runs out of budget, or in a lost position, it plays like the average player.
// Deterministic per seed: the only randomness is the seeded rng handed to reset.

export const BEGINNER_BLOCK_RATE = 0.6
export const STRONG_SLIP_RATE = 0.15
/** The solver is used from this many stones; below it a proof costs seconds. */
export const STRONG_SOLVER_FROM = 10
/** Solver budget per move, in nodes (about 0.15 s at the top). */
export const STRONG_SOLVER_NODES = 1_200_000
/** Column weights for the dice: the centre is likeliest. */
export const CENTRE_WEIGHTS: readonly number[] = [1, 2, 3, 4, 3, 2, 1]

export const PROXY_WORDS: Record<Proxy, string> = {
  beginner: `takes a win in one every time, blocks a one-move threat ${Math.round(BEGINNER_BLOCK_RATE * 100)}% of the time, otherwise drops by centre-weighted dice`,
  average: 'always wins and blocks, never hands over a win in one, otherwise centre-weighted dice among the safe columns',
  strong: `plays a column the perfect solver proves keeps the result (from ${STRONG_SOLVER_FROM} stones, else like the average player), ${Math.round(STRONG_SLIP_RATE * 100)}% of the time a random legal column`,
}

function dice(cols: readonly number[], rng: Rng): number {
  let total = 0
  for (const c of cols) total += CENTRE_WEIGHTS[c]!
  let r = rng.float() * total
  for (const c of cols) {
    r -= CENTRE_WEIGHTS[c]!
    if (r < 0) return c
  }
  return cols[cols.length - 1]!
}

const legalColumns = (s: FourState): number[] => Array.from({ length: COLS }, (_, c) => c).filter((c) => isLegalColumn(s, c))

/** The column a test player of this kind drops in position `s`. */
export function proxyMove(proxy: Proxy, s: FourState, rng: Rng): number {
  const legal = legalColumns(s)
  const wins = winningColumns(s)
  if (wins.length > 0) return wins[0]!
  const threats = threatColumns(s)
  if (proxy === 'beginner') {
    if (threats.length > 0 && rng.float() < BEGINNER_BLOCK_RATE) return threats[0]!
    return dice(legal, rng)
  }
  if (threats.length > 0 && proxy === 'average') return threats[0]!
  const safe = safeColumns(s)
  const average = (): number => dice(safe.length > 0 ? safe : legal, rng)
  if (proxy === 'average') return average()
  if (rng.float() < STRONG_SLIP_RATE) return legal[rng.int(legal.length)]!
  if (s.n >= STRONG_SOLVER_FROM) {
    const keep = provenKeepers(s, { maxNodes: STRONG_SOLVER_NODES })
    if (keep !== null && keep !== 'unknown' && keep.size > 0) return dice([...keep].sort((a, b) => a - b), rng)
  }
  if (threats.length > 0) return threats[0]!
  return average()
}

/** One test player as a harness agent. */
export function createProxyAgent(proxy: Proxy, opts: AgentOpts = {}): PreviewAgent {
  let rng: Rng = makeRng(0)
  let seat = opts.seat ?? 1
  return {
    preview: false,
    reset(seed, forSeat) {
      if (forSeat !== undefined) seat = forSeat
      rng = makeRng((seed ^ Math.imul(seat + 1, 0x9e3779b1) ^ 0x5bd1e995) | 0)
    },
    async act(obs, state) {
      const s = (state as FourState | undefined) ?? stateFromObservation(obs as FourObservation)
      return [proxyMove(proxy, s, rng)]
    },
    dispose() {},
  }
}

const LEVEL_PROXY: Record<string, Proxy> = Object.fromEntries((Object.entries(PROXY_LEVEL) as Array<[Proxy, Level]>).map(([p, l]) => [l, p]))

/** The module hook the match harness loads: the level name picks the proxy (easy = beginner, medium = average, hard = strong). */
export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const proxy = LEVEL_PROXY[level]
  if (!proxy) throw new Error(`four people panel: no test player for level ${level}`)
  return createProxyAgent(proxy, opts)
}
