import { describe, expect, test } from 'bun:test'
import { devSide } from './dev-side'

describe('?side', () => {
  test('pins either seat in a dev build', () => {
    expect(devSide('?seed=4&side=1', true, null)).toBe(1)
    expect(devSide('?side=0', true, null)).toBe(0)
  })
  test('?side=seed takes the seed\'s side even when the dev server pins one', () => {
    expect(devSide('?seed=4&side=seed', true, '0')).toBeUndefined()
  })
  test('with no ?side the dev server default applies, and no default means the seed decides', () => {
    expect(devSide('?seed=4', true, '1')).toBe(1)
    expect(devSide('?seed=4', true, '0')).toBe(0)
    expect(devSide('?seed=4', true, null)).toBeUndefined()
    expect(devSide('?seed=4', true, 'random')).toBeUndefined()
  })
  test('does nothing in a production build, and ignores values other than 0, 1 and seed', () => {
    expect(devSide('?side=1', false, '1')).toBeUndefined()
    expect(devSide('?side=2', true, null)).toBeUndefined()
    expect(devSide(null, true, '1')).toBeUndefined()
  })
})
