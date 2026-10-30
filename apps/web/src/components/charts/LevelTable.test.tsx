import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LevelTable } from './LevelTable'
import { summariseRegistry } from '../../server/stats'
import type { Registry } from '@duelwise/agents/src/registry'

test('no Coldstore Practice level displays an In training label', () => {
  const registry = { game: 'arena', levels: {}, measured: {}, unpublished: {}, versions: [] } as unknown as Registry
  const levels = summariseRegistry(registry).levels
  const html = renderToStaticMarkup(<LevelTable levels={levels} realtime />)
  expect(levels.every((level) => level.practice)).toBe(true)
  expect(html).not.toContain('In training')
  expect(html).toContain('Easy reacts slower')
  expect(html).toContain('Plays stronger than Easy')
})

test('level rows stack on narrow screens and show reactions in milliseconds', () => {
  const registry = { game: 'arena', levels: {}, measured: {}, unpublished: {}, versions: [] } as unknown as Registry
  const html = renderToStaticMarkup(<LevelTable levels={summariseRegistry(registry).levels} realtime />)
  expect(html).toContain('sm:table-row')
  expect(html).toContain('350 ms (21 frames)')
  expect(html).not.toContain('min-w-[22rem]')
})
