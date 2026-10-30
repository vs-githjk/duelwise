import { expect, test } from 'bun:test'
import { behavior } from './fighter-behavior'

// A 60-frame bound is one second at 60 Hz. The extra four frames on attack
// holds allow the Easy limiter's eight-frame minimum hold and input lag.
test('served policy does not idle at range or hold one attack indefinitely', async () => {
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
    for (const opponent of ['passive', 'hold-back'] as const) {
      for (let seed = 7000; seed < 7004; seed++) {
        const result = await behavior(level, opponent, seed, false, (seed % 2) as 0 | 1)
        expect(result.longFrames, `${level} ${opponent} ${seed} did not exercise range`).toBeGreaterThan(0)
        expect(result.longestIdle, `${level} ${opponent} ${seed} idle`).toBeLessThanOrEqual(60)
        expect(result.longestPressRun, `${level} ${opponent} ${seed} repeated presses`).toBeLessThanOrEqual(6)
        expect(result.longestHeldAttack, `${level} ${opponent} ${seed} attack`).toBeLessThanOrEqual(60)
      }
    }
  }
}, 120_000)
