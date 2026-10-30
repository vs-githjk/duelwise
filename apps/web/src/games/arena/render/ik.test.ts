import { describe, expect, test } from 'bun:test'
import { Object3D, Vector3 } from 'three'
import { twoBoneIK } from './ik'

function arm(): { upper: Object3D; lower: Object3D; hand: Object3D; root: Object3D } {
  const root = new Object3D()
  const upper = new Object3D()
  const lower = new Object3D()
  const hand = new Object3D()
  upper.position.set(0, 1.4, 0)
  lower.position.set(0, -0.3, 0) // hanging down: upper arm 0.3 long
  hand.position.set(0, -0.25, 0) // forearm 0.25 long
  root.add(upper)
  upper.add(lower)
  lower.add(hand)
  root.updateMatrixWorld(true)
  return { upper, lower, hand, root }
}

describe('two bone IK', () => {
  test('the hand reaches a target inside the arm length', () => {
    const { upper, lower, hand, root } = arm()
    const t = new Vector3(0.3, 1.45, 0.25)
    const r = twoBoneIK(upper, lower, hand, t, new Vector3(0, 0, 0))
    root.updateMatrixWorld(true)
    expect(r.reached).toBe(true)
    expect(hand.getWorldPosition(new Vector3()).distanceTo(t)).toBeLessThan(1e-4)
  })

  test('bone lengths are preserved', () => {
    const { upper, lower, hand, root } = arm()
    twoBoneIK(upper, lower, hand, new Vector3(-0.2, 1.6, 0.3), new Vector3(0, 1, 0))
    root.updateMatrixWorld(true)
    const a = upper.getWorldPosition(new Vector3())
    const b = lower.getWorldPosition(new Vector3())
    const c = hand.getWorldPosition(new Vector3())
    expect(a.distanceTo(b)).toBeCloseTo(0.3, 6)
    expect(b.distanceTo(c)).toBeCloseTo(0.25, 6)
  })

  test('an unreachable target stretches the arm straight toward it', () => {
    const { upper, lower, hand, root } = arm()
    const t = new Vector3(2, 1.4, 0)
    const r = twoBoneIK(upper, lower, hand, t, new Vector3(0, 0, 0))
    root.updateMatrixWorld(true)
    expect(r.reached).toBe(false)
    const c = hand.getWorldPosition(new Vector3())
    expect(c.x).toBeCloseTo(0.55, 2)
    expect(c.y).toBeCloseTo(1.4, 2)
  })

  test('the elbow bends toward the pole', () => {
    const { upper, lower, hand, root } = arm()
    twoBoneIK(upper, lower, hand, new Vector3(0, 1.4, 0.4), new Vector3(0, -5, 0))
    root.updateMatrixWorld(true)
    expect(lower.getWorldPosition(new Vector3()).y).toBeLessThan(1.4)
    const { upper: u2, lower: l2, hand: h2, root: r2 } = arm()
    twoBoneIK(u2, l2, h2, new Vector3(0, 1.4, 0.4), new Vector3(0, 5, 0))
    r2.updateMatrixWorld(true)
    expect(l2.getWorldPosition(new Vector3()).y).toBeGreaterThan(1.4)
  })
})
