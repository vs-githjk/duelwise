// The 1-ply greedy probe (judge round 2): a bot that takes a win, blocks an open win, otherwise plays the column nearest the centre.
// A Four in a Row level that sees more than one move must never lose or draw to it. Shared by the slow test and the publish gate.
//   bun /abs/four-greedy.ts <level> <seed,seed,...> prints { wins, draws, losses } for the level as JSON (the level plays seat 1 on even seeds, seat 0 on odd)
import { fourCore } from '@duelwise/core/src/games/four/core'
import { fourFromMoves, isLegalColumn, type FourState } from '@duelwise/core/src/games/four/rules'
import type { Level } from '@duelwise/core/src/product'
import { createGameAgent } from '../four/agent'
import { forcedMove } from '../four/tactics'

const CENTRE_FIRST = [3, 2, 4, 1, 5, 0, 6] as const

/** Win now, else block, else the open column nearest the centre. */
export function greedyMove(s: FourState): number {
  const forced = forcedMove(s)
  if (forced !== null) return forced
  return CENTRE_FIRST.find((c) => isLegalColumn(s, c))!
}

export interface GreedyTally {
  wins: number
  draws: number
  losses: number
}

/** One game from the empty board against the greedy bot, at the level's shipped simulation counts and no time cap. The level sits in seat `seat`. Returns the level's points (win 1, draw 0.5). */
export async function greedyGame(level: Level, seat: 0 | 1, seed: number): Promise<number> {
  const agent = await createGameAgent(level, { seat, search: { timeCapMs: undefined } })
  agent.reset(seed)
  let s = fourFromMoves([])
  while (!fourCore.terminal(s)) {
    const toAct = fourCore.toAct(s)[0]!
    const m = toAct === seat ? (await agent.act(fourCore.observe(s, seat), s))[0]! : greedyMove(s)
    s = fourCore.step(s, toAct === 0 ? [m, null] : [null, m])
  }
  agent.dispose()
  return fourCore.result(s)!.score[seat]
}

/** The level plays seat 1 on even seeds and seat 0 on odd ones. */
export async function greedyTally(level: Level, seeds: readonly number[]): Promise<GreedyTally> {
  const t: GreedyTally = { wins: 0, draws: 0, losses: 0 }
  for (const seed of seeds) {
    const p = await greedyGame(level, seed % 2 === 0 ? 1 : 0, seed)
    if (p > 0.75) t.wins++
    else if (p > 0.25) t.draws++
    else t.losses++
  }
  return t
}

/** 40 games for the Champion gate: seeds 5000..5039, so 20 in each seat. */
export const GREEDY_SEEDS: number[] = Array.from({ length: 40 }, (_, i) => 5000 + i)

if (import.meta.main) {
  const [level, seedArg] = process.argv.slice(2)
  console.log(JSON.stringify(await greedyTally(level as Level, (seedArg ?? '').split(',').map(Number))))
  process.exit(0)
}
