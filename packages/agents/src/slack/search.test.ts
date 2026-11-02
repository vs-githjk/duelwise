import { describe, expect, test } from 'bun:test'
import { PASS, flipsFor, slackCore, type SlackState } from '@duelwise/core/src/games/slack/core'
import { makeRng } from '@duelwise/core/src/rng'
import type { Seat } from '@duelwise/core/src/types'
import {
  discDiff, emptyCount, flipsOf, fromCells, legalMoves, make, startBoard, toCells, unmake,
} from './board'
import { evaluate, searchMove, NODE_BATCH, type SearchOpts } from './search'

function act(s: SlackState, a: number): SlackState {
  const x: [number | null, number | null] = [null, null]
  x[s.turn] = a
  return slackCore.step(s, x)
}

/** Every state of a seeded random match, in order. */
function randomGame(seed: number): SlackState[] {
  const rng = makeRng(seed)
  const out: SlackState[] = []
  let s = slackCore.init(0)
  while (!slackCore.terminal(s)) {
    out.push(s)
    const legal = slackCore.legal(s, s.turn)
    s = act(s, legal[rng.int(legal.length)]!)
  }
  out.push(s)
  return out
}

/** A random-play state with exactly `empties` empty cells and the mover holding a placement. */
function positionsWithEmpties(empties: number, count: number, firstSeed: number): SlackState[] {
  const out: SlackState[] = []
  for (let seed = firstSeed; out.length < count && seed < firstSeed + 5000; seed++) {
    const s = randomGame(seed).find((x) => x.cells.filter((c) => c === 0).length === empties)
    if (s && !slackCore.terminal(s) && !slackCore.legal(s, s.turn).includes(PASS)) out.push(s)
  }
  return out
}

const sign = (seat: Seat) => (seat === 0 ? 1 : -1)

describe('fast board against the core', () => {
  test('moves, flips, make and unmake equal slackCore over 300 random games at every ply', () => {
    let plies = 0
    for (let seed = 1; seed <= 300; seed++) {
      for (const s of randomGame(seed)) {
        plies++
        const b = fromCells(s.cells)
        expect(toCells(b)).toEqual(s.cells)
        for (const seat of [0, 1] as Seat[]) {
          const v = (seat + 1) as 1 | 2
          const ref: number[] = []
          for (let c = 0; c < 64; c++) {
            const f = flipsFor(s.cells, v, c)
            const fast = flipsOf(b, c, sign(seat))
            if (f.length !== fast.length || [...f].sort((p, q) => p - q).join() !== [...fast].sort((p, q) => p - q).join()) {
              throw new Error(`flips differ: seed ${seed} seat ${seat} cell ${c}`)
            }
            if (f.length > 0) ref.push(c)
          }
          expect([...legalMoves(b, sign(seat))].sort((p, q) => p - q)).toEqual(ref)
          if (seat === s.turn && !slackCore.terminal(s)) {
            const core = slackCore.legal(s, seat).filter((a) => a !== PASS)
            expect(ref).toEqual(core)
            for (const m of core) {
              const buf = new Int8Array(64)
              const n = make(b, m, sign(seat), buf)
              expect(toCells(b)).toEqual(act(s, m).cells)
              unmake(b, m, sign(seat), buf, n)
              expect(toCells(b)).toEqual(s.cells)
            }
          }
        }
      }
    }
    expect(plies).toBeGreaterThan(300 * 55)
  })
})

/** Plain negamax with no pruning and no ordering, written against the board primitives only. */
function plainNegamax(b: Int8Array, me: number, depth: number, passed: boolean, evalFn: (b: Int8Array, me: number) => number): number {
  if (depth === 0) return evalFn(b, me)
  const ms = [...legalMoves(b, me)]
  if (ms.length === 0) {
    if (passed) return discDiff(b, me) * 10000
    return -plainNegamax(b, -me, depth, true, evalFn)
  }
  let best = -Infinity
  for (const m of ms) {
    const c = b.slice()
    make(c, m, me, new Int8Array(64))
    best = Math.max(best, -plainNegamax(c, -me, depth - 1, false, evalFn))
  }
  return best
}

/** Brute force to the end of the game: final disc difference for `me`. */
function brute(b: Int8Array, me: number, passed: boolean): number {
  const ms = [...legalMoves(b, me)]
  if (ms.length === 0) return passed ? discDiff(b, me) : -brute(b, -me, true)
  let best = -Infinity
  for (const m of ms) {
    const c = b.slice()
    make(c, m, me, new Int8Array(64))
    best = Math.max(best, -brute(c, -me, false))
  }
  return best
}

describe('search', () => {
  test('alpha-beta at depth 4 returns the plain negamax value on 50 positions', () => {
    let checked = 0
    for (let seed = 1; checked < 50 && seed < 400; seed++) {
      const states = randomGame(seed)
      const s = states[6 + (seed % 30)]
      if (!s || slackCore.terminal(s)) continue
      const seat = s.turn
      if (slackCore.legal(s, seat).includes(PASS)) continue
      const b = fromCells(s.cells)
      for (const mobility of [false, true]) {
        const r = searchMove(s.cells, seat, { maxDepth: 4, mobility })
        const evalFn = (x: Int8Array, me: number) => evaluate(x, me, mobility)
        expect(r.value).toBe(plainNegamax(b, sign(seat), 4, false, evalFn))
        expect(r.depth).toBe(4)
        expect(slackCore.legal(s, seat)).toContain(r.move)
      }
      checked++
    }
    expect(checked).toBe(50)
  })

  test('the exact solve agrees with brute force on 30 positions at 8 empties', () => {
    const ps = positionsWithEmpties(8, 30, 1000)
    expect(ps.length).toBe(30)
    for (const s of ps) {
      const seat = s.turn
      const b = fromCells(s.cells)
      const truth = brute(b, sign(seat), false)
      const r = searchMove(s.cells, seat, { maxDepth: 2, exactEmpties: 8 })
      expect(r.exact).toBe(true)
      expect(r.value).toBe(truth * 10000)
      // The move it picks is one of the best moves by brute force.
      const values = slackCore.legal(s, seat).map((m) => {
        const c = b.slice()
        make(c, m, sign(seat), new Int8Array(64))
        return -brute(c, -sign(seat), false)
      })
      expect(values[slackCore.legal(s, seat).indexOf(r.move)]).toBe(Math.max(...values))
    }
  })

  test('the exact solve is off above its empties threshold', () => {
    const s = slackCore.init(0)
    const r = searchMove(s.cells, 0, { maxDepth: 2, exactEmpties: 8 })
    expect(r.exact).toBe(false)
    expect(r.depth).toBe(2)
  })

  test('a node cap is never passed by more than one batch and the last finished depth answers', () => {
    const s = randomGame(7)[24]!
    for (const cap of [50, 400, 5000, 60000]) {
      const r = searchMove(s.cells, s.turn, { maxDepth: 12, nodeCap: cap })
      expect(r.nodes).toBeLessThanOrEqual(cap + NODE_BATCH)
      expect(r.depth).toBeLessThan(12)
      expect(slackCore.legal(s, s.turn)).toContain(r.move)
      if (r.depth > 0) {
        // The move is exactly what a search to that depth, with no cap, would pick.
        const again = searchMove(s.cells, s.turn, { maxDepth: r.depth })
        expect(r.move).toBe(again.move)
        expect(r.value).toBe(again.value)
      }
    }
    // A cap too small to finish depth 1 still answers with a legal move.
    const tiny = searchMove(s.cells, s.turn, { maxDepth: 6, nodeCap: 1 })
    expect(tiny.depth).toBe(0)
    expect(slackCore.legal(s, s.turn)).toContain(tiny.move)
  })

  test('the same input with the same rng gives the same move, and a different rng can differ', () => {
    const s = slackCore.init(0)
    const opts = (seed: number): SearchOpts => ({ maxDepth: 3, noise: 100, rng: makeRng(seed) })
    const first = searchMove(s.cells, s.turn, opts(5))
    const second = searchMove(s.cells, s.turn, opts(5))
    expect(second).toEqual(first)
    const moves = new Set<number>()
    for (let seed = 1; seed <= 60; seed++) moves.add(searchMove(s.cells, s.turn, opts(seed)).move)
    expect(moves.size).toBeGreaterThan(1)
  })

  test('noise with no rng is refused', () => {
    expect(() => searchMove(slackCore.init(0).cells, 0, { maxDepth: 2, noise: 3 })).toThrow()
  })

  test('with no moves it answers pass', () => {
    // Seat 0 has no placement here while seat 1 does, so the only action is pass.
    const rows = [
      'ox......', '........', '........', '........', '........', '........', '........', '........',
    ].join('')
    const cells = rows.split('').map((ch) => (ch === 'x' ? 1 : ch === 'o' ? 2 : 0))
    const r = searchMove(cells, 0, { maxDepth: 3 })
    expect(slackCore.legal({ cells, turn: 0 }, 0)).toEqual([PASS])
    expect(r.move).toBe(PASS)
  })

  test('a corner is taken where it wins outright', () => {
    // 8-empty positions where the corner is the only move that wins, found by brute force.
    const found: SlackState[] = []
    for (let seed = 2000; found.length < 6 && seed < 12000; seed++) {
      const s = randomGame(seed).find((x) => x.cells.filter((c) => c === 0).length === 8)
      if (!s || slackCore.terminal(s)) continue
      const legal = slackCore.legal(s, s.turn)
      if (legal.includes(PASS) || legal.length < 2) continue
      const b = fromCells(s.cells)
      const me = sign(s.turn)
      const vals = legal.map((m) => {
        const c = b.slice()
        make(c, m, me, new Int8Array(64))
        return -brute(c, -me, false)
      })
      const wins = legal.filter((_, i) => vals[i]! > 0)
      if (wins.length === 1 && [0, 7, 56, 63].includes(wins[0]!)) found.push(s)
    }
    expect(found.length).toBeGreaterThanOrEqual(3)
    for (const s of found) {
      const heuristic = searchMove(s.cells, s.turn, { maxDepth: 2 })
      expect([0, 7, 56, 63]).toContain(heuristic.move)
      const solved = searchMove(s.cells, s.turn, { maxDepth: 2, exactEmpties: 8 })
      expect([0, 7, 56, 63]).toContain(solved.move)
    }
  }, 60000)
})

describe('speed', () => {
  test('benchmark position: nodes per second', () => {
    const s = randomGame(3)[20]!
    const cells = s.cells
    expect(emptyCount(fromCells(cells))).toBe(64 - 4 - 20)
    const t0 = performance.now()
    const r = searchMove(cells, s.turn, { maxDepth: 12, nodeCap: 400_000, mobility: true })
    const ms = performance.now() - t0
    const nps = Math.round((r.nodes / ms) * 1000)
    console.log(`[bench] ${r.nodes} nodes in ${ms.toFixed(0)} ms = ${nps} nodes/s, depth ${r.depth}`)
    expect(nps).toBeGreaterThan(100_000)
    expect(startBoard()[27]).toBe(-1)
  })
})
