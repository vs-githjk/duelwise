import { expect, test } from 'bun:test'
import { Mccfr, restoreSolver, serializeSolver, normalised, type CfrGame } from './mccfr'
import { kuhn, KUHN_VALUE } from './kuhn'
import { leduc } from './leduc'
import { bestResponseValue, exploitability, gameValue, type EnumGame } from './best-response'

function avgFn<S>(m: Mccfr<S>) {
  return (key: string, mask: number): Float64Array => {
    const n = m.nodes.get(key)
    return normalised(n ? n.sum : new Float64Array(m.game.width), mask, m.game.width)
  }
}

test('Kuhn: average strategy value is within 0.005 of -1/18', () => {
  const m = new Mccfr(kuhn, { plus: true, linear: true })
  m.run(200_000, 7)
  const v = gameValue(kuhn, avgFn(m))
  expect(Math.abs(v - KUHN_VALUE)).toBeLessThan(0.005)
  expect(exploitability(kuhn, avgFn(m))).toBeLessThan(0.01)
}, 60_000)

test('Kuhn: exact best response against a uniform strategy beats the game value', () => {
  const uniform = (_k: string, mask: number) => normalised(new Float64Array(2), mask, 2)
  expect(bestResponseValue(kuhn, uniform, 0)).toBeGreaterThan(0.2)
  expect(exploitability(kuhn, uniform)).toBeGreaterThan(0.1)
})

test('Leduc: the root enumeration covers 120 deals that sum to probability one', () => {
  const roots = leduc.roots()
  expect(roots.length).toBe(120)
  expect(roots.reduce((s, r) => s + r.p, 0)).toBeCloseTo(1, 12)
})

// Leduc exploitability (chips per game) at fixed iteration counts, seed 11, RM+ with linear averaging.
// Pinned from the first run: 20k 0.1428, 100k 0.0594, 400k 0.0302; the final threshold keeps 65% headroom.
test('Leduc: exploitability falls across snapshots and ends below the pinned threshold', () => {
  const m = new Mccfr(leduc, { plus: true, linear: true })
  const seen: number[] = []
  for (const target of [20_000, 100_000, 400_000]) {
    m.run(target - m.iteration, 11)
    seen.push(exploitability(leduc, avgFn(m)))
  }
  expect(seen[1]!).toBeLessThan(seen[0]!)
  expect(seen[2]!).toBeLessThan(seen[1]!)
  expect(seen[2]!).toBeLessThan(0.05)
}, 120_000)

test('a run is reproducible and a checkpoint resumes it exactly', () => {
  const a = new Mccfr(kuhn, { plus: true, linear: true })
  a.run(3000, 5)
  const b = new Mccfr(kuhn, { plus: true, linear: true })
  b.run(1000, 5)
  const bytes = serializeSolver(b)
  const c = new Mccfr(kuhn, { plus: true, linear: true })
  restoreSolver(c, bytes)
  expect(c.iteration).toBe(1000)
  c.run(2000, 5)
  expect(c.iteration).toBe(3000)
  expect(c.nodes.size).toBe(a.nodes.size)
  for (const [k, n] of a.nodes) {
    const o = c.nodes.get(k)!
    expect(Array.from(o.regret)).toEqual(Array.from(n.regret))
    expect(Array.from(o.sum)).toEqual(Array.from(n.sum))
  }
})

test('a corrupt checkpoint is rejected', () => {
  const m = new Mccfr(kuhn)
  expect(() => restoreSolver(m, new Uint8Array(20))).toThrow()
})

// Type-level check that both games satisfy the shared interfaces.
const _games: Array<CfrGame<any> & EnumGame<any>> = [kuhn, leduc]
void _games
