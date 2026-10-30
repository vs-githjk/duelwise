import { describe, expect, test } from 'bun:test'
import { makePlayer } from '@duelwise/core/src/games/arena/state.ts'
import { WEAPONS } from '@duelwise/core/src/games/arena/weapons.ts'
import { FootstepClock, QUIET_FRACTION, STRIDE, stepsAudible } from './audio3d'

describe('footsteps', () => {
  test('one step per stride of distance, remainder carried over', () => {
    const c = new FootstepClock(60)
    expect(c.advance(50, true)).toBe(0)
    expect(c.advance(50, true)).toBe(1)
    expect(c.advance(130, true)).toBe(2)
  })

  test('silent movement resets the cadence', () => {
    const c = new FootstepClock(60)
    c.advance(50, true)
    expect(c.advance(500, false)).toBe(0)
    expect(c.advance(50, true)).toBe(0)
    expect(STRIDE).toBeGreaterThan(0)
  })

  test('running is audible; shift walking, crouching, jumping and the dead are not', () => {
    const p = makePlayer()
    p.weapon = 1
    const top = WEAPONS[1]!.maxSpeed
    p.vx = top
    expect(stepsAudible(p)).toBe(true)
    p.vx = top * (QUIET_FRACTION - 0.05)
    expect(stepsAudible(p)).toBe(false)
    p.vx = top
    p.crouch = 1
    expect(stepsAudible(p)).toBe(false)
    p.crouch = 0
    p.onGround = 0
    expect(stepsAudible(p)).toBe(false)
    p.onGround = 1
    p.alive = 0
    expect(stepsAudible(p)).toBe(false)
  })
})
