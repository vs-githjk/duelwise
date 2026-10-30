import { expect, test } from 'bun:test'
import { makeRng } from '../../rng'
import { copyState, createState, stepPacked } from './index'

// The floor is set by what training needs (plan: fighter 50,000 frames per second on one core
// while other jobs run). Run explicitly: bun test packages/core/src/games/fighter/fighter-perf.slow.test.ts

test('the allocation-free step runs at least 50,000 frames per second on one core', () => {
  const rng = makeRng(123)
  const n = 4096
  const inputs = new Int32Array(n * 2)
  let p = [0, 0]
  for (let i = 0; i < n; i++) {
    for (const k of [0, 1]) if (rng.int(5) === 0) p[k] = rng.int(63)
    inputs[i * 2] = p[0]!
    inputs[i * 2 + 1] = p[1]!
  }
  const start = createState(1, { introFrames: 0 })
  const s = createState(1, { introFrames: 0 })
  const run = (frames: number): void => {
    for (let t = 0; t < frames; t++) {
      if (s.matchOver === 1) copyState(s, start)
      const i = t % n
      stepPacked(s, inputs[i * 2]!, inputs[i * 2 + 1]!)
    }
  }
  run(50_000) // warm up
  const frames = 600_000
  const t0 = performance.now()
  run(frames)
  const fps = frames / ((performance.now() - t0) / 1000)
  console.log(`fighter sim: ${Math.round(fps)} frames per second`)
  expect(fps).toBeGreaterThanOrEqual(50_000)
})
