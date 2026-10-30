import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const hex = (name: string): string => css.match(new RegExp(`--${name}: (#[0-9a-fA-F]{6});`))![1]!
function lum(h: string): number {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)

test('card, tile, input and divider lines are clearly visible (3:1) on the cream canvas and white cards', () => {
  expect(ratio(hex('line'), hex('canvas'))).toBeGreaterThanOrEqual(3)
  expect(ratio(hex('line'), hex('surface'))).toBeGreaterThanOrEqual(3)
})

test('body text, muted text and the action colour keep WCAG AA on the Sunroom surfaces', () => {
  for (const bg of ['canvas', 'surface', 'surface-2']) {
    expect(ratio(hex('ink'), hex(bg))).toBeGreaterThanOrEqual(4.5)
    expect(ratio(hex('muted'), hex(bg))).toBeGreaterThanOrEqual(4.5)
  }
  expect(ratio(hex('action-ink'), hex('action'))).toBeGreaterThanOrEqual(4.5)
  expect(ratio(hex('peach-deep'), hex('canvas'))).toBeGreaterThanOrEqual(4.5)
  expect(ratio(hex('peach-deep'), hex('peach-soft'))).toBeGreaterThanOrEqual(4.5)
})
