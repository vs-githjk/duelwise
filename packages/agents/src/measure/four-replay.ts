// The replay exploit probe (judge round 1): a human who plays one memorized winning line blind, seat 0, against a level at its shipped
// simulation counts with the wall-clock cap removed. Shared by the slow variety test and the publish gate.
//   bun /abs/four-replay.ts replay <level> <line> <seed,seed,...>   prints the number of human wins as JSON
//   bun /abs/four-replay.ts siteseat <seed,seed,...>                prints the Champion's points against Hard (Champion seat 1) as JSON
import { fourCore } from '@duelwise/core/src/games/four/core'
import { fourFromMoves, isLegalColumn } from '@duelwise/core/src/games/four/rules'
import type { Level } from '@duelwise/core/src/product'
import { createGameAgent } from '../four/agent'
import { greedyTally } from './four-greedy'

/** One game from the empty board, Hard as seat 0 and the Champion as seat 1 (the only way the site plays), both at their shipped simulation counts and no time cap. Returns the Champion's points. */
export async function siteSeatGame(seed: number): Promise<number> {
  const opts = { search: { timeCapMs: undefined } }
  const hard = await createGameAgent('hard', { seat: 0, ...opts })
  const champ = await createGameAgent('champion', { seat: 1, ...opts })
  hard.reset(seed)
  champ.reset(seed + 99_991)
  let s = fourFromMoves([])
  while (!fourCore.terminal(s)) {
    const seat = fourCore.toAct(s)[0]!
    const m = seat === 0 ? (await hard.act(fourCore.observe(s, 0), s))[0]! : (await champ.act(fourCore.observe(s, 1), s))[0]!
    s = fourCore.step(s, seat === 0 ? [m, null] : [null, m])
  }
  hard.dispose()
  champ.dispose()
  return fourCore.result(s)!.score[1]
}

/** The Champion line the judge found: it won every game while the Champion replayed its own moves. */
export const CHAMPION_LINE = '3332544216000052245'
/** The Hard line the judge found. */
export const HARD_LINE = '333102212300044556665'

/** The human (seat 0) plays its line blind, falling back to the first open column when its column is full. Returns true on a human win. */
export async function replay(level: Level, line: string, seed: number): Promise<boolean> {
  const agent = await createGameAgent(level, { seat: 1, search: { timeCapMs: undefined } })
  agent.reset(seed)
  let s = fourFromMoves([])
  let i = 0
  while (!fourCore.terminal(s)) {
    const seat = fourCore.toAct(s)[0]!
    let m: number
    if (seat === 0) {
      m = Number(line[i++] ?? '3')
      if (!isLegalColumn(s, m)) m = fourCore.legal(s, 0)[0]!
    } else m = (await agent.act(fourCore.observe(s, 1), s))[0]!
    s = fourCore.step(s, seat === 0 ? [m, null] : [null, m])
  }
  agent.dispose()
  const r = fourCore.result(s)!
  return r.score[0] > r.score[1]
}

/** Three independent 20-seed sets (60 games), the last holding the five seeds the judge replayed. The bound must hold on any seed choice. */
export const REPLAY_SEED_SETS: number[][] = [
  Array.from({ length: 20 }, (_, i) => 1000 + i * 37),
  Array.from({ length: 20 }, (_, i) => 7000 + i * 53),
  [11, 222, 3333, 44444, 555555, ...Array.from({ length: 15 }, (_, i) => i + 1)],
]
/** The Champion may lose to the blind line in fewer than this many of the 60 games. */
export const REPLAY_WIN_LIMIT = 4

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2)
  if (mode === 'replay') {
    const [level, line, seedsCsv] = rest
    let wins = 0
    for (const seed of seedsCsv!.split(',').map(Number)) if (await replay(level as Level, line!, seed)) wins++
    console.log(JSON.stringify({ wins }))
  } else if (mode === 'greedy') {
    const [level, seedsCsv] = rest
    const tally = await greedyTally(level as Level, seedsCsv!.split(',').map(Number))
    console.log(JSON.stringify({ ...tally, notWins: tally.draws + tally.losses }))
  } else {
    let points = 0
    for (const seed of rest[0]!.split(',').map(Number)) points += await siteSeatGame(seed)
    console.log(JSON.stringify({ points }))
  }
  process.exit(0)
}
