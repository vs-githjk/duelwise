import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const play = readFileSync(new URL('./play.css', import.meta.url), 'utf8')

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
const hexOf = (css: string, name: string, nth = 0): string => [...css.matchAll(new RegExp(`--${name}: (#[0-9a-fA-F]{6});`, 'g'))][nth]![1]!

// Word Duel lane header dots sit on the lane paper: the first paper value is light, the later ones dark.
test('light: the You dot reaches 3:1 on the lane paper', () => {
  expect(ratio(hexOf(tokens, 'token-you', 0), hexOf(play, 'paper', 0))).toBeGreaterThanOrEqual(3)
})

test('the site has no dark theme: tokens and play surfaces carry no dark-mode block', () => {
  expect(tokens).not.toContain('prefers-color-scheme')
  expect(play).not.toContain('prefers-color-scheme')
  expect(tokens + play).not.toContain('data-theme')
})
