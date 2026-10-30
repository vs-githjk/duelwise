import { expect, test } from 'bun:test'
import { fourCore, solve } from './index'

// Run explicitly: bun test packages/core/src/games/four/solver.slow.test.ts
// FOUR_STRONG=1 also runs the exact-score solve of the empty board (much slower).
test('empty board: the centre column is the only winning first move (first player wins)', () => {
  const t0 = performance.now()
  const r = solve(fourCore.init(0), { ttBits: 23, weak: true })
  const secs = ((performance.now() - t0) / 1000).toFixed(1)
  console.log(`REPORTED solved game (weak): outcome ${r.score}, bestMoves ${JSON.stringify(r.bestMoves)}, nodes ${r.nodes}, ${secs} s`)
  expect(r.score).toBe(1)
  expect(r.bestMoves).toEqual([3])
}, 3_600_000)

test.if(process.env.FOUR_STRONG === '1')('empty board exact score is +1 (win with the last possible stone)', () => {
  const t0 = performance.now()
  const r = solve(fourCore.init(0), { ttBits: 24 })
  const secs = ((performance.now() - t0) / 1000).toFixed(1)
  console.log(`REPORTED solved game (strong): score ${r.score}, bestMoves ${JSON.stringify(r.bestMoves)}, nodes ${r.nodes}, ${secs} s`)
  expect(r.score).toBe(1)
  expect(r.bestMoves).toEqual([3])
}, 86_400_000)
