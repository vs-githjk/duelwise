import { describe, expect, test } from 'bun:test'
import { detExp } from './exp'

describe('detExp', () => {
  test('matches Math.exp within 1e-13 relative over the logit range the net produces', () => {
    for (let x = -60; x <= 0; x += 0.0137) {
      const want = Math.exp(x)
      expect(Math.abs(detExp(x) - want) / want).toBeLessThan(1e-13)
    }
  })
  test('edges: exp(0) is 1, huge negative is 0, positive values still work', () => {
    expect(detExp(0)).toBe(1)
    expect(detExp(-5000)).toBe(0)
    expect(Math.abs(detExp(3.3) - Math.exp(3.3)) / Math.exp(3.3)).toBeLessThan(1e-13)
  })
})
