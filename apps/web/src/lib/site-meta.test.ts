import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shareMeta } from './site-meta'

const web = join(import.meta.dir, '../..')
const og = readFileSync(join(web, 'scripts/generate-og.ts'), 'utf8')
const readme = readFileSync(join(web, '../../README.md'), 'utf8')

// The link-preview image is a picture, so a count baked into it goes stale with every new game (decisions.md, Nov 3: count-free by the tenth game).
test('the link-preview image and its alt text carry no game count', () => {
  expect(og).not.toMatch(/gameCountWord/)
  expect(og).not.toMatch(/\b(Six|Seven|Eight|Nine|Ten|Eleven|Twelve) games/)
  expect(readme.split('\n')[2]).not.toMatch(/\b(Six|Seven|Eight|Nine|Ten) games/)
  const alt = shareMeta().find((m) => m.property === 'og:image:alt')!.content!
  expect(alt).not.toMatch(/\b(\d+|Six|Seven|Eight|Nine|Ten) games/)
})

test('a changed image gets a new address so chat apps drop their cached preview', () => {
  expect(shareMeta().find((m) => m.property === 'og:image')!.content).toBe('https://duelwise.app/og/duelwise-og.png?v=5')
})
