import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Result } from '@duelwise/core/src/types'
import { ResultPanel } from './ResultPanel'

test('global reduced motion rule disables animations and transitions', () => {
  const css = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8')
  expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
  expect(css).toContain('animation-duration: 0.01ms !important')
  expect(css).toContain('transition-duration: 0.01ms !important')
})

test('result renders its final rating change immediately with reduced motion', () => {
  const previous = globalThis.window
  globalThis.window = { matchMedia: () => ({ matches: true }) } as unknown as Window & typeof globalThis
  try {
    const html = renderToStaticMarkup(<ResultPanel result={{ winner: 0, reason: 'resigned' } as unknown as Result} humanSeat={0} onRematch={() => {}} elo={{ before: 1000, after: 1012 }} />)
    expect(html).toContain('>12</span>')
    expect(html).toContain('1000 to 1012')
  } finally { globalThis.window = previous }
})
