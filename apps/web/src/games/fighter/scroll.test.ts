import { expect, test } from 'bun:test'
import { matchScrollTarget } from './scroll'

test('a 1440x900 window shows the title again: the stage ends at 827, so the page goes to the top', () => {
  expect(matchScrollTarget(207, 827, 900)).toBe(0)
})

test('a 1280x720 window cannot show the title and the stage, so it shows the whole stage (its buttons sit at the bottom edge)', () => {
  const y = matchScrollTarget(207, 827, 720)
  expect(y).toBe(119)
  expect(827 - y).toBeLessThanOrEqual(720 - 12)
  expect(207 - y).toBeGreaterThan(0)
})

test('a stage taller than the window lines its top up under the header', () => {
  expect(matchScrollTarget(207, 827, 560)).toBe(135)
  expect(matchScrollTarget(40, 827, 500)).toBe(0)
})
