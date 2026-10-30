import { describe, expect, test } from 'bun:test'
import { fourCore, fourFromMoves, fourEncoder } from '@duelwise/core/src/games/four'
import { makeRng } from '@duelwise/core/src/rng'
import { maskedSoftmax, uniformEvaluator, batchEvaluator } from './evaluator'
import { PuctSearch, puctSearch, search, selectCode } from './puct'

const four = (moves: number[]) => fourFromMoves(moves)
const base = { actionCount: 7, sims: 200 }
const uni = uniformEvaluator<ReturnType<typeof four>>(7)

describe('PUCT with a uniform evaluator', () => {
  test('plays an immediate win', async () => {
    // Seat 0 has three in column 0, seat 1 three in column 1 (seat 0 to move): column 0 wins.
    const s = four([0, 1, 0, 1, 0, 1])
    const r = await puctSearch(fourCore, s, uni, base)
    expect(r.best).toBe(0)
    expect(r.visits[0]!).toBeGreaterThan(r.visits.reduce((a, b) => a + b, 0) * 0.5)
    expect(r.value).toBeGreaterThan(0.5)
  })

  test('blocks an immediate loss', async () => {
    // Seat 1 threatens column 1 (three stones stacked) and it is seat 0's move with no win of its own.
    const s = four([0, 1, 2, 1, 2, 1])
    expect(fourCore.toAct(s)).toEqual([0])
    const r = await puctSearch(fourCore, s, uni, base)
    expect(r.best).toBe(1)
  })

  test('visits sum to sims and are zero on illegal columns', async () => {
    // Column 3 full: stack 6 stones alternately without a win (3,3,3,3,3,3).
    const s = four([3, 3, 3, 3, 3, 3])
    const r = await puctSearch(fourCore, s, uni, { ...base, sims: 123 })
    expect(r.visits.reduce((a, b) => a + b, 0)).toBe(123)
    expect(r.visits[3]).toBe(0)
    expect(r.policy.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
  })

  test('deterministic per rng, with and without root noise', async () => {
    const s = four([3, 4])
    const run = (seed: number, noise: boolean) =>
      puctSearch(fourCore, s, uni, { ...base, sims: 60, rng: makeRng(seed), dirichlet: noise ? { alpha: 1, eps: 0.25 } : undefined })
    expect((await run(5, true)).visits).toEqual((await run(5, true)).visits)
    expect((await run(5, false)).visits).toEqual((await run(6, false)).visits)
    expect((await run(5, true)).visits).not.toEqual((await run(6, true)).visits)
  })

  test('terminal root has no visits and no best move', async () => {
    const s = four([0, 1, 0, 1, 0, 1, 0])
    expect(fourCore.terminal(s)).toBe(true)
    const r = await puctSearch(fourCore, s, uni, base)
    expect(r.best).toBe(-1)
    expect(r.visits.every((v) => v === 0)).toBe(true)
  })

  test('step API batches: pending is stable until provide', () => {
    const search = new PuctSearch(fourCore, four([]), { ...base, sims: 3 })
    const a = search.pending()
    expect(search.pending()).toBe(a)
    let evals = 0
    for (let s = search.pending(); s !== null; s = search.pending()) {
      search.provide({ priors: new Float32Array(7).fill(1), value: 0 })
      evals++
    }
    expect(evals).toBe(4) // root plus 3 simulations
    expect(search.done).toBe(true)
  })
})

describe('evaluator helpers and move selection', () => {
  test('maskedSoftmax puts mass on legal codes only', () => {
    const p = maskedSoftmax([1000, 0, 0, 1000, 0, 0, 0], [0, 3, 5], 7)
    expect(p[0]! + p[3]! + p[5]!).toBeCloseTo(1, 6)
    expect(p[1]).toBe(0)
    expect(p[0]).toBeCloseTo(0.5, 6)
  })

  test('batchEvaluator encodes the batch and masks illegal columns', async () => {
    const full = four([3, 3, 3, 3, 3, 3])
    const ev = batchEvaluator({
      core: fourCore,
      seat: (s) => fourCore.toAct(s)[0]!,
      encode: (s, out, off) => fourEncoder.encode(fourCore.observe(s, fourCore.toAct(s)[0]!), out, off),
      featureSize: 126,
      actionCount: 7,
      run: (batch, n) => {
        expect(batch.length).toBe(n * 126)
        return { logits: new Float32Array(n * 7), values: new Float32Array(n).fill(0.25) }
      },
    })
    const [e] = await ev.evaluate([full])
    expect(e!.priors[3]).toBe(0)
    expect(e!.priors[0]).toBeCloseTo(1 / 6, 6)
    expect(e!.value).toBe(0.25)
  })

  test('selectCode: greedy, sampled, and empty', () => {
    const rng = makeRng(1)
    expect(selectCode([0, 5, 9, 9, 0, 0, 0], 0, rng)).toBe(2)
    const counts = new Array(7).fill(0)
    for (let i = 0; i < 2000; i++) counts[selectCode([0, 1, 3, 0, 0, 0, 0], 1, rng)]++
    expect(counts[0] + counts[3]).toBe(0)
    expect(counts[2]).toBeGreaterThan(counts[1] * 2)
    expect(selectCode([0, 0, 0, 0, 0, 0, 0], 1, rng)).toBe(-1)
  })
})

describe('search wrapper with a time cap', () => {
  test('a 1 ms cap with a slow evaluator still returns a legal action', async () => {
    const slow = {
      evaluate: async (states: readonly ReturnType<typeof four>[]) => {
        await new Promise((r) => setTimeout(r, 20))
        return states.map(() => ({ priors: new Float32Array(7).fill(1), value: 0 }))
      },
    }
    const s = four([3, 3])
    const t0 = Date.now()
    const r = await search(fourCore, s, slow, { actionCount: 7, sims: 500, timeCapMs: 1, temperature: 0, rng: makeRng(1) })
    expect(Date.now() - t0).toBeLessThan(500)
    const legal = fourCore.legal(s, fourCore.toAct(s)[0]!).map((a) => fourCore.encodeAction(a))
    expect(legal).toContain(r.action)
  })

  test('without a cap it searches all sims and picks the most visited action', async () => {
    const r = await search(fourCore, four([0, 6, 1, 6, 2, 5]), uni, { actionCount: 7, sims: 200, temperature: 0, rng: makeRng(1) })
    expect(r.visits.reduce((a, b) => a + b, 0)).toBe(200)
    expect(r.visits[r.action]).toBe(Math.max(...r.visits))
  })
})
