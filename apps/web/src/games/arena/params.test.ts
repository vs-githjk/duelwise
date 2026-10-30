import { describe, expect, test } from 'bun:test'
import { readParams } from './useArenaMatch'

describe('arena query switches', () => {
  test('an unrated match (fixed seed) honours speed and agentlag, clamped', () => {
    expect(readParams('?seed=1&speed=3&agentlag=250', true)).toMatchObject({ speed: 3, agentLagMs: 250 })
    expect(readParams('?seed=1&speed=999&agentlag=9999', true)).toMatchObject({ speed: 30, agentLagMs: 5000 })
  })

  test('a counted match ignores speed and agentlag with no seed in the URL', () => {
    expect(readParams('?speed=3&agentlag=5000', false)).toMatchObject({ speed: 1, agentLagMs: 0 })
  })

  test('an empty or invalid seed still means a counted match, so the switches are ignored', () => {
    expect(readParams('?seed=&agentlag=5000&speed=3', false)).toMatchObject({ speed: 1, agentLagMs: 0 })
    expect(readParams('?seed=abc&agentlag=5000', false)).toMatchObject({ speed: 1, agentLagMs: 0 })
  })

  test('a counted rematch ignores the switches even though the URL still carries a seed', () => {
    expect(readParams('?seed=1&agentlag=5000&speed=3', false)).toMatchObject({ speed: 1, agentLagMs: 0 })
  })

  test('the debug renderer switch is independent of rating', () => {
    expect(readParams('?renderer=debug', false).forceDebug).toBe(true)
  })
})
