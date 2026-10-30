import { expect, test } from 'bun:test'
import { trapTarget } from './focusTrap'

const items = ['resume', 'moves', 'controls', 'quit']
const inside = (el: string | null) => el !== null && items.includes(el)

test('Tab on the last control wraps to the first, Shift+Tab on the first wraps to the last', () => {
  expect(trapTarget(items, 'quit', false, inside)).toBe('resume')
  expect(trapTarget(items, 'resume', true, inside)).toBe('quit')
})

test('Tab in the middle is left to the browser', () => {
  expect(trapTarget(items, 'moves', false, inside)).toBeNull()
  expect(trapTarget(items, 'moves', true, inside)).toBeNull()
})

test('focus that has left the dialog is pulled back in', () => {
  expect(trapTarget(items, 'page-link', false, inside)).toBe('resume')
  expect(trapTarget(items, null, true, inside)).toBe('quit')
})

test('an empty dialog traps nothing', () => {
  expect(trapTarget([], null, false, () => false)).toBeNull()
})
