import { expect, test } from 'bun:test'
import { makeRng } from '../../rng'
import { copyState, createState, packInput, stepPacked } from './index'

// The floor is set by what training needs (plan: arena 25,000 frames per second on one core
// while other jobs run). Run explicitly: bun test packages/core/src/games/arena/arena-perf.slow.test.ts

test('the allocation-free step runs at least 25,000 frames per second on one core', () => {
  const rng = makeRng(123)
  const n = 4096
  const inputs = new Int32Array(n * 2)
  const cur = [0, 0]
  for (let i = 0; i < n; i++) {
    for (const k of [0, 1]) {
      if (rng.int(6) === 0) {
        cur[k] = packInput({
          move: rng.int(9), walk: rng.int(4) === 0 ? 1 : 0, crouch: rng.int(6) === 0 ? 1 : 0,
          jump: rng.int(14) === 0 ? 1 : 0, fire: rng.int(2), reload: rng.int(40) === 0 ? 1 : 0,
          yaw: rng.int(41) - 20, pitch: rng.int(11) - 5, buy: rng.int(4),
        })
      }
      inputs[i * 2 + k] = cur[k]!
    }
  }
  const start = createState(1, { buyFrames: 60, roundFrames: 1200 })
  const s = createState(1, { buyFrames: 60, roundFrames: 1200 })
  const run = (frames: number): void => {
    for (let t = 0; t < frames; t++) {
      if (s.matchOver === 1) copyState(s, start)
      const i = t % n
      stepPacked(s, inputs[i * 2]!, inputs[i * 2 + 1]!)
    }
  }
  run(50_000) // warm up
  const frames = 400_000
  const t0 = performance.now()
  run(frames)
  const fps = frames / ((performance.now() - t0) / 1000)
  console.log(`arena sim: ${Math.round(fps)} frames per second`)
  expect(fps).toBeGreaterThanOrEqual(25_000)
})
