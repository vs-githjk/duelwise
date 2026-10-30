import { describe, expect, test } from 'bun:test'
import { fourFromMoves } from '@duelwise/core/src/games/four/rules'
import { makeRng } from '@duelwise/core/src/rng'
import { solve } from '@duelwise/core/src/games/four/solver'
import { forcedMove, pickVaried, provenKeepers, safeColumns, threatColumns, winningColumns } from './tactics'

// Columns are 0-based; seat 0 moves first, so after an odd number of drops seat 1 is to move.
describe('four tactics', () => {
  test('winningColumns finds the side to move win, threatColumns the opponent one', () => {
    const s = fourFromMoves([0, 1, 0, 1, 0, 2]) // seat 0 has three stacked in column 0 and is to move
    expect(winningColumns(s)).toEqual([0])
    expect(threatColumns(fourFromMoves([0, 1, 0, 1, 0]))).toEqual([0]) // seat 1 to move, seat 0 threatens column 0
    expect(threatColumns(fourFromMoves([3]))).toEqual([])
  })

  test('forcedMove blocks a one-move threat and prefers a win over a block', () => {
    expect(forcedMove(fourFromMoves([0, 6, 0, 6, 0]))).toBe(0)
    expect(forcedMove(fourFromMoves([0, 1, 0, 1, 0, 1]))).toBe(0) // seat 0 wins at column 0; seat 1 also threatens column 1
    expect(forcedMove(fourFromMoves([3]))).toBeNull()
  })

  test('safeColumns drops a move that lets the opponent win', () => {
    const s = fourFromMoves([0, 6, 0, 6, 0]) // seat 1 to move; seat 0 threatens column 0
    expect(safeColumns(s)).toEqual([0])
  })

  test('pickVaried varies among near-equal moves and ignores far-worse ones', () => {
    const s = fourFromMoves([])
    const visits = [0, 10, 380, 400, 390, 12, 0]
    const seen = new Set<number>()
    for (let seed = 0; seed < 60; seed++) seen.add(pickVaried(visits, [0, 0, 0, 0, 0, 0, 0], s, makeRng(seed), { keepShare: 0.5, valueMargin: 0.1 }))
    expect([...seen].sort()).toEqual([2, 3, 4])
  })

  test('pickVaried always plays the forced block, whatever the visits say', () => {
    const s = fourFromMoves([0, 6, 0, 6, 0]) // seat 1 must block column 0
    for (let seed = 0; seed < 20; seed++) expect(pickVaried([1, 300, 300, 300, 300, 300, 300], [0, 0, 0, 0, 0, 0, 0], s, makeRng(seed), { keepShare: 0.5, valueMargin: 0.1 })).toBe(0)
  })

  test('pickVaried drops a near-visited move whose value is clearly worse', () => {
    const s = fourFromMoves([])
    const visits = [0, 0, 380, 400, 390, 0, 0]
    const q = [0, 0, -0.6, 0.3, 0.25, 0, 0]
    const seen = new Set<number>()
    for (let seed = 0; seed < 60; seed++) seen.add(pickVaried(visits, q, s, makeRng(seed), { keepShare: 0.5, valueMargin: 0.2 }))
    expect([...seen].sort()).toEqual([3, 4])
  })

  test('pickVaried with a proven set never leaves it, even when the near-best moves are outside it', () => {
    const s = fourFromMoves([])
    const visits = [0, 0, 380, 400, 390, 0, 0]
    const q = [0, 0, 0.3, 0.3, 0.3, 0, 0]
    const seen = new Set<number>()
    for (let seed = 0; seed < 60; seed++) seen.add(pickVaried(visits, q, s, makeRng(seed), { keepShare: 0.5, valueMargin: 0.2, allowed: new Set([2, 3]) }))
    expect([...seen].sort()).toEqual([2, 3])
    // No near-best move is proven: the most visited proven move is played.
    expect(pickVaried(visits, q, s, makeRng(1), { keepShare: 0.99, valueMargin: 0.01, allowed: new Set([2, 4]) })).toBe(4)
  })

  test('provenKeepers lists the solver moves that keep the value, and nothing for a lost position', () => {
    const won = fourFromMoves([0, 6, 5, 0, 5, 2, 1, 1, 1, 3, 0, 2, 5, 4]) // won for the side to move; the solver keeps columns 3 and 5
    expect(solve(won, { weak: true }).score).toBe(1)
    expect([...provenKeepers(won)!].sort()).toEqual([3, 5])
    const lost = fourFromMoves([3, 6, 6, 0, 4, 2, 4, 6, 0, 4, 3, 6, 5, 5])
    expect(solve(lost, { weak: true }).score).toBe(-1)
    expect(provenKeepers(lost)).toBeNull()
  })

  test('pickVaried with a proven set whose columns all have no visits still plays a proven column', () => {
    const s = fourFromMoves([])
    const visits = [0, 0, 57, 0, 3, 0, 0] // a starved search: only unproven columns were visited
    const q = [0, 0, 0.3, 0, 0.2, 0, 0]
    for (let seed = 0; seed < 30; seed++) expect([3, 5]).toContain(pickVaried(visits, q, s, makeRng(seed), { keepShare: 0.1, valueMargin: 1, allowed: new Set([3, 5]) }))
  })

  test('provenKeepers returns unknown when the node budget or the deadline runs out', () => {
    const slow = fourFromMoves([...'2100256265552'].map(Number))
    expect(provenKeepers(slow, { maxNodes: 50_000 })).toBe('unknown')
    expect(provenKeepers(slow, { deadline: performance.now() - 1 })).toBe('unknown')
  })
})
