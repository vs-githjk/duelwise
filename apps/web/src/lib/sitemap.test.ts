import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT } from '@duelwise/core/src/product'

const PUBLIC = join(import.meta.dir, '../../public')
const sitemap = readFileSync(join(PUBLIC, 'sitemap.xml'), 'utf8')
const robots = readFileSync(join(PUBLIC, 'robots.txt'), 'utf8')

test('the sitemap lists the play, agent and leaderboard page of every game', () => {
  for (const { slug } of Object.values(PRODUCT.games)) {
    for (const section of ['play', 'agents', 'leaderboard']) {
      expect(sitemap).toContain(`<loc>https://duelwise.app/${section}/${slug}</loc>`)
    }
  }
})

test('robots.txt points at the sitemap and keeps private pages out', () => {
  expect(robots).toContain('Sitemap: https://duelwise.app/sitemap.xml')
  for (const path of ['/api/', '/dev/', '/owner']) expect(robots).toContain(`Disallow: ${path}`)
  expect(sitemap).not.toMatch(/\/(api|dev|owner|settings|report)/)
})
