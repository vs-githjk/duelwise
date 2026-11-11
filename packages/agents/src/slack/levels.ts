import { PASS, type SlackObs } from '@duelwise/core/src/games/slack/core'
import type { Level } from '@duelwise/core/src/product'
import type { Rng } from '@duelwise/core/src/types'
import { fromCells, legalMoves, flipsOf } from './board'
import { searchMove, type SearchOpts } from './search'

/**
 * Crosscurrent levels: four different algorithms, not one dial. Pip is a one-ply flip counter with a
 * corner pull; the other three are the SW3 search with growing depth, a mobility term and less noise.
 * Level names follow the product's ids (easy, medium, hard, champion); the personas are Pip, Marlow,
 * Vesper and Sable.
 */
export type SlackLevelConfig =
  | {
      kind: 'greedy'
      /** Added to a corner's flip count. */
      cornerBonus: number
      /** Chance in percent of ignoring the evaluation and playing a random legal move. */
      randomPercent: number
    }
  | {
      kind: 'search'
      depth: number
      mobility: boolean
      noise: number
      /**
       * A wider noise while more than `above` cells are empty, so a known opening line does not repeat. Plain noise 1 on this
       * integer scale (a corner is 120) only splits exact ties, and 50 seeds gave one sequence (measured), so the opening needs more.
       */
      openingNoise?: { above: number; noise: number }
      exactEmpties?: number
      nodeCap?: number
    }

/**
 * Sable's nodeCap is a starting value (estimate), not tuned. SW3 measured about 1.2M nodes a second on
 * the bench position, so 120,000 nodes is roughly a tenth of a second there and longer in a crowded
 * midgame; SW5 measures the real slowest move at this cap, and only that figure may change it.
 */
const OPENING_NOISE = 30

export const SLACK_LEVELS: Record<Level, SlackLevelConfig> = {
  easy: { kind: 'greedy', cornerBonus: 20, randomPercent: 20 },
  medium: { kind: 'search', depth: 3, mobility: false, noise: 4 },
  hard: { kind: 'search', depth: 4, mobility: true, noise: 2 },
  champion: { kind: 'search', depth: 6, mobility: true, noise: 1, openingNoise: { above: 50, noise: OPENING_NOISE }, exactEmpties: 8, nodeCap: 120_000 },
}

const CORNERS = new Set([0, 7, 56, 63])

/**
 * The code a level plays for an observation (cells from the viewer's side: 1 mine, 2 theirs). Depends
 * only on `obs` and the draws taken from `rng`. A forced pass is returned as PASS.
 */
export function chooseSlackAction(level: Level, obs: SlackObs, rng: Rng): number {
  if (!obs.toMove || obs.legal.length === 0) throw new Error('slack agent: seat ' + obs.seat + ' is not to move')
  if (obs.legal.length === 1 && obs.legal[0] === PASS) return PASS
  const cfg = SLACK_LEVELS[level]
  if (cfg.kind === 'greedy') {
    if (rng.int(100) < cfg.randomPercent) return obs.legal[rng.int(obs.legal.length)]!
    const board = fromCells(obs.cells)
    // The viewer's discs are 1, which is the mover of seat 0 in the search board.
    const moves = legalMoves(board, 1)
    let best = -1
    const top: number[] = []
    for (const m of moves) {
      const v = flipsOf(board, m, 1).length + (CORNERS.has(m) ? cfg.cornerBonus : 0)
      if (v > best) {
        best = v
        top.length = 0
      }
      if (v === best) top.push(m)
    }
    return top[rng.int(top.length)]!
  }
  // Observation cells already put the mover as 1, so the search is told seat 0.
  return searchMove(obs.cells, 0, slackSearchOpts(cfg, obs, rng)).move
}

/** The exact options a search level hands to `searchMove` for an observation; the one place the level config meets the search. */
export function slackSearchOpts(cfg: Extract<SlackLevelConfig, { kind: 'search' }>, obs: SlackObs, rng: Rng): SearchOpts {
  return {
    maxDepth: cfg.depth,
    mobility: cfg.mobility,
    noise: cfg.openingNoise && obs.cells.filter((c) => c === 0).length > cfg.openingNoise.above ? cfg.openingNoise.noise : cfg.noise,
    rng,
    ...(cfg.exactEmpties !== undefined ? { exactEmpties: cfg.exactEmpties } : {}),
    ...(cfg.nodeCap !== undefined ? { nodeCap: cfg.nodeCap } : {}),
  }
}
