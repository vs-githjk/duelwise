import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const tokens = JSON.parse(readFileSync(new URL('./tokens.default.json', import.meta.url), 'utf8'))

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)

function flat(side: 'light' | 'dark'): Record<string, string> {
  const v = tokens[side]
  return side === 'light' ? Object.assign({}, ...Object.values(v)) : v
}

for (const side of ['light'] as const) {
  test(`${side}: chess coordinates meet text contrast on both square colours`, () => {
    const t = flat(side)
    expect(ratio(t['coord-on-light']!, t['board-light']!)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(t['coord-on-dark']!, t['board-dark']!)).toBeGreaterThanOrEqual(4.5)
  })
  test(`${side}: both Four in a Row stones stand out from the empty holes, in amber and ink like the card art`, () => {
    const t = flat(side)
    expect(t['four-hole']).toBeDefined()
    expect(t['four-you']!.toLowerCase()).toBe('#f3b81c')
    expect(t['four-ai']!.toLowerCase()).toBe('#1a1814')
    expect(ratio(t['four-you']!, t['four-hole']!)).toBeGreaterThanOrEqual(3)
    expect(ratio(t['four-ai']!, t['four-hole']!)).toBeGreaterThanOrEqual(3)
  })
}
