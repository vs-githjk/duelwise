import { describe, expect, test } from 'bun:test'
import { LANE_PORTS, portFor, resolvePort } from './port'

describe('portFor', () => {
  test('known worktree folders map to their lane ports', () => {
    expect(portFor('beatme')).toBe(3000)
    expect(portFor('beatme-lane-a')).toBe(3100)
    expect(portFor('beatme-lane-b')).toBe(3200)
    expect(portFor('beatme-lane-c')).toBe(3300)
  })

  test('unknown folders get a stable port outside the lane ports', () => {
    const taken = new Set(Object.values(LANE_PORTS))
    for (const name of ['other', 'beatme-lane-d', 'x', 'my-checkout', '']) {
      const p = portFor(name)
      expect(portFor(name)).toBe(p)
      expect(p).toBeGreaterThanOrEqual(3400)
      expect(p).toBeLessThan(4000)
      expect(taken.has(p)).toBe(false)
    }
    expect(portFor('other')).not.toBe(portFor('my-checkout'))
  })
})

describe('resolvePort', () => {
  test('PORT wins over the folder name', () => {
    expect(resolvePort({ PORT: '4567' }, '/work/beatme-lane-b')).toBe(4567)
  })

  test('the folder name decides when PORT is unset, empty or not a port', () => {
    expect(resolvePort({}, '/work/beatme-lane-b')).toBe(3200)
    expect(resolvePort({ PORT: '' }, '/work/beatme-lane-c/')).toBe(3300)
    expect(resolvePort({ PORT: 'abc' }, '/work/beatme')).toBe(3000)
    expect(resolvePort({ PORT: '70000' }, '/work/beatme-lane-a')).toBe(3100)
  })
})
