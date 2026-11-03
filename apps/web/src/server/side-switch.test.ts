import { describe, expect, test } from 'bun:test'
import { testSide } from './side-switch'

describe('the DUELWISE_SIDE test switch', () => {
  test('pins the side outside production', () => {
    expect(testSide({ DUELWISE_SIDE: '0', NODE_ENV: 'development' })!('chess', 5)).toBe(0)
    expect(testSide({ DUELWISE_SIDE: '1' })!('four', 6)).toBe(1)
  })

  test('does nothing in a production build, and does nothing unset or with another value', () => {
    expect(testSide({ DUELWISE_SIDE: '1', NODE_ENV: 'production' })).toBeUndefined()
    expect(testSide({})).toBeUndefined()
    expect(testSide({ DUELWISE_SIDE: 'random' })).toBeUndefined()
  })
})
