import { describe, expect, test } from 'bun:test'
import { NET_VECTORS, NET_VECTOR_HASHES, runNetVector } from './vectors'

// S4, the determinism gate: nine fixed input logs (three per game) whose final state hash is pinned here in Bun and must be reproduced in
// Chromium and WebKit (apps/web/e2e/determinism.spec.ts, page /dev/determinism). Rollback netcode replays frames after a late input, so a
// sim that gives a different state on another engine cannot be trusted with it.

describe('netplay determinism vectors', () => {
  test('there are three logs for each of the three realtime games, 3,000 to 20,000 frames', () => {
    expect(NET_VECTORS.length).toBe(9)
    for (const g of ['fighter', 'arena', 'puck'] as const) {
      const mine = NET_VECTORS.filter((v) => v.game === g)
      expect(mine.length).toBe(3)
      for (const v of mine) {
        expect(v.frames).toBeGreaterThanOrEqual(3000)
        expect(v.frames).toBeLessThanOrEqual(20000)
      }
    }
    expect(new Set(NET_VECTORS.map((v) => v.id)).size).toBe(9)
  })

  for (const v of NET_VECTORS) {
    test(`${v.id}: replays to the pinned hash and exercises the sim`, () => {
      const r = runNetVector(v)
      expect(r.hash).toBe(NET_VECTOR_HASHES[v.id]!.hash)
      expect(r.trace).toBe(NET_VECTOR_HASHES[v.id]!.trace)
      expect(r.frames).toBe(NET_VECTOR_HASHES[v.id]!.frames)
      // Replaying twice gives the same thing (no hidden state between runs).
      expect(runNetVector(v).hash).toBe(r.hash)
      // The log does real work: something happened that a still sim would not show.
      expect(r.activity).toBeGreaterThan(NET_VECTOR_HASHES[v.id]!.minActivity)
    })
  }

  test('a one-bit change in a log changes the hash (the gate can fail)', () => {
    const v = NET_VECTORS.find((x) => x.game === 'puck')!
    const a = runNetVector(v)
    const b = runNetVector({ ...v, seed: v.seed + 1 })
    expect(b.hash).not.toBe(a.hash)
  })

  test('the logs reach the extremes: Coldstore aim at 1024, Glasscut mallet at the far corners', () => {
    const arena = NET_VECTORS.filter((v) => v.game === 'arena').map((v) => runNetVector(v))
    expect(arena.some((r) => r.extremes > 0)).toBe(true)
    const puck = NET_VECTORS.filter((v) => v.game === 'puck').map((v) => runNetVector(v))
    expect(puck.some((r) => r.extremes > 0)).toBe(true)
  })
})
