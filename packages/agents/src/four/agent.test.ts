import { describe, expect, test } from 'bun:test'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { fourFromMoves, type FourState } from '@duelwise/core/src/games/four/rules'
import { makeRng } from '@duelwise/core/src/rng'
import { createGameAgent } from './agent'
import { threatColumns, winningColumns } from './tactics'

/** Positions reached by random play where the side to move can win at once, or must block a one-move threat. */
function probes(wantWin: boolean, count: number): FourState[] {
  const rng = makeRng(wantWin ? 91 : 17)
  const out: FourState[] = []
  for (let guard = 0; out.length < count && guard < 20000; guard++) {
    let s = fourFromMoves([])
    while (!fourCore.terminal(s)) {
      const win = winningColumns(s).length > 0
      const threat = threatColumns(s).length > 0
      if (s.n > 4 && (wantWin ? win : !win && threat)) {
        out.push(s)
        break
      }
      const seat = fourCore.toAct(s)[0]!
      const legal = fourCore.legal(s, seat)
      const m = legal[rng.int(legal.length)]!
      s = fourCore.step(s, seat === 0 ? [m, null] : [null, m])
    }
  }
  return out
}

describe('Medium sees one move ahead', () => {
  test('always takes an immediate win and always blocks an open one-move threat, on 60 probes each, 3 seeds', async () => {
    const agent = await createGameAgent('medium', { seat: 0 })
    const wins = probes(true, 60)
    const blocks = probes(false, 60)
    expect(wins.length).toBe(60)
    expect(blocks.length).toBe(60)
    let missedWins = 0
    let missedBlocks = 0
    for (const seed of [1, 2, 3]) {
      for (const s of wins) {
        agent.reset(seed)
        const m = (await agent.act(fourCore.observe(s, fourCore.toAct(s)[0]!), s))[0]!
        if (!winningColumns(s).includes(m)) missedWins++
      }
      for (const s of blocks) {
        agent.reset(seed)
        const m = (await agent.act(fourCore.observe(s, fourCore.toAct(s)[0]!), s))[0]!
        if (!threatColumns(s).includes(m)) missedBlocks++
      }
    }
    agent.dispose()
    expect({ missedWins, missedBlocks }).toEqual({ missedWins: 0, missedBlocks: 0 })
  }, 120_000)
})

describe('Champion stays inside its time cap on slow solver positions', () => {
  // These 13-stone positions took 2 to 5 s (and the 12-stone one 10 s) when the weak solver ran with no limit after the search.
  test('13-stone positions where the solver is slowest finish under the 1.5 s budget (2 s allowed for machine noise)', async () => {
    const agent = await createGameAgent('champion', { seat: 1 })
    for (const m of ['2100256265552', '2100256265556', '2100256265554']) {
      const s = fourFromMoves([...m].map(Number))
      agent.reset(1)
      const t = performance.now()
      const [a] = await agent.act(fourCore.observe(s, fourCore.toAct(s)[0]!), s)
      const ms = performance.now() - t
      expect(ms).toBeLessThan(2000)
      expect(s.h[a as number]!).toBeLessThan(6)
    }
    agent.dispose()
  }, 60_000)
})
