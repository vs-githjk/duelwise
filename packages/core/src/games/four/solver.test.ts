import { describe, expect, test } from 'bun:test'
import { fourCore, fourFromMoves, solve, type FourState } from './index'
import { makeRng } from '../../rng'

// Independent reference: plain 6x7 array board, memoised minimax with the same scoring
// convention (a win with the k-th stone of the winner scores 22 - k for the winner).
function bruteScores(state: FourState): { score: number; cols: number[] } {
  const g: number[][] = Array.from({ length: 7 }, () => [])
  for (let c = 0; c < 7; c++) {
    for (let r = 0; r < state.h[c]!; r++) {
      const bit = c * 7 + r
      const lo = bit < 32 ? (state.bb[0]! >>> bit) & 1 : (state.bb[1]! >>> (bit - 32)) & 1
      g[c]!.push(lo ? 1 : 2)
    }
  }
  const wins = (c: number, r: number, p: number): boolean => {
    for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
      let n = 1
      for (const sgn of [1, -1]) {
        let x = c + dc * sgn
        let y = r + dr * sgn
        while (x >= 0 && x < 7 && y >= 0 && y < 6 && g[x]![y] === p) {
          n++
          x += dc * sgn
          y += dr * sgn
        }
      }
      if (n >= 4) return true
    }
    return false
  }
  const memo = new Map<string, number>()
  const key = () => g.map((col) => col.join('')).join('|')
  // value for the player to move, n stones already placed
  const value = (n: number): number => {
    if (n === 42) return 0
    const k = key()
    const hit = memo.get(k)
    if (hit !== undefined) return hit
    const p = n % 2 === 0 ? 1 : 2
    let best = -100
    for (let c = 0; c < 7; c++) {
      if (g[c]!.length >= 6) continue
      const r = g[c]!.length
      g[c]!.push(p)
      const v = wins(c, r, p) ? 21 - (n >> 1) : -value(n + 1)
      g[c]!.pop()
      if (v > best) best = v
    }
    memo.set(k, best)
    return best
  }
  const n0 = state.n
  const p0 = n0 % 2 === 0 ? 1 : 2
  const per: number[] = []
  for (let c = 0; c < 7; c++) {
    if (g[c]!.length >= 6) {
      per.push(-100)
      continue
    }
    const r = g[c]!.length
    g[c]!.push(p0)
    per.push(wins(c, r, p0) ? 21 - (n0 >> 1) : -value(n0 + 1))
    g[c]!.pop()
  }
  const score = Math.max(...per)
  return { score, cols: per.flatMap((v, c) => (v === score ? [c] : [])) }
}

function randomPosition(seed: number, stones: number): FourState {
  const rng = makeRng(seed)
  for (;;) {
    let s = fourCore.init(seed)
    while (!fourCore.terminal(s) && s.n < stones) {
      const seat = s.n % 2 === 0 ? 0 : 1
      const l = fourCore.legal(s, seat as 0 | 1)
      const a: [number | null, number | null] = [null, null]
      a[seat] = l[rng.int(l.length)]!
      s = fourCore.step(s, a)
    }
    if (!fourCore.terminal(s)) return s
  }
}

describe('perfect solver', () => {
  test('200 seeded positions with at most 14 empty cells match brute-force minimax', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const empty = 4 + (seed % 11) // 4..14
      const pos = randomPosition(seed, 42 - empty)
      const want = bruteScores(pos)
      const got = solve(pos)
      expect({ seed, score: got.score, best: got.bestMoves }).toEqual({ seed, score: want.score, best: want.cols })
    }
  }, 120_000)

  test('weak solve gives the outcome sign and keeps every exact best move', () => {
    for (let seed = 301; seed <= 360; seed++) {
      const pos = randomPosition(seed, 42 - (4 + (seed % 11)))
      const want = bruteScores(pos)
      const got = solve(pos, { weak: true })
      expect({ seed, score: got.score }).toEqual({ seed, score: Math.sign(want.score) + 0 })
      for (const c of want.cols) expect(got.bestMoves).toContain(c)
    }
  }, 120_000)

  test('weak solve lists every column that keeps the win, not only the immediate winning ones', () => {
    const s = fourFromMoves([0, 6, 1, 6, 2, 5])
    const r = solve(s, { weak: true })
    expect(r.score).toBe(1)
    for (const c of [1, 3, 4]) expect(r.bestMoves).toContain(c)
    // The exact (strong) solve of the same position still returns the fastest win only.
    expect(solve(s).bestMoves).toEqual([3])
  })

  test('weak solve reports a win on the 42nd stone as +1, not a draw', () => {
    const s = fourFromMoves([3,3,6,3,6,2,5,0,3,2,6,5,2,4,3,3,4,2,0,1,4,1,1,2,2,6,0,6,4,5,6,5,5,4,5,0,1,1,4,1,0])
    const r = solve(s, { weak: true })
    expect(r.score).toBe(1)
    expect(r.bestMoves).toEqual([0])
  })

  test('an immediate win scores by stone number and is the only best move', () => {
    const s = fourFromMoves([0, 0, 1, 1, 2, 2]) // seat 0 to play column 3 or... horizontal 0,1,2 then 3
    const r = solve(s)
    expect(r.bestMoves).toEqual([3])
    expect(r.score).toBe(21 - (s.n >> 1))
  })

  test('a forced loss is found and every move is equally bad', () => {
    // seat 0 holds 1,2,3 on the bottom row with both ends open: seat 1 to move cannot stop both
    const s = fourFromMoves([1, 6, 2, 6, 3])
    expect(s.n).toBe(5)
    const r = solve(s)
    expect(r.score).toBe(-(21 - (6 >> 1)))
    expect(r.bestMoves).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  test('rejects a finished game', () => {
    expect(() => solve(fourFromMoves([0, 0, 1, 1, 2, 2, 3]))).toThrow()
  })

  test('positions with at least 16 stones solve in under 1 s', () => {
    for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
      const pos = randomPosition(seed, 16)
      expect(pos.n).toBe(16)
      const t0 = performance.now()
      const r = solve(pos)
      const ms = performance.now() - t0
      expect(r.bestMoves.length).toBeGreaterThan(0)
      expect(ms).toBeLessThan(1000)
    }
  }, 30_000)
})
