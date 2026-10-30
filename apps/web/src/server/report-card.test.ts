import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { playRandom } from '../report/testing'
import { cardImageUrl, shareCardSvg } from '../report/share-card'
import { startMatchHandler } from './match-handlers'
import { finishUnchecked as finishMatchHandler } from './finish-unchecked'
import { setReportSettings } from './report'
import { cardPngFor, renderCardPng, resetCardPngCache } from './report-card'

type Db = PgliteDatabase<typeof schema>
let client: PGlite
let db: Db

beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())
beforeEach(async () => {
  resetCardPngCache()
  await db.execute(sql`truncate table match, guest, rating, profile, match_report, telemetry_event, "user" cascade`)
  await db.insert(schema.user).values({ id: 'u-1', name: 'Real Name', email: 'real.person@example.test' })
})

const USER = { userId: 'u-1' }

async function play(): Promise<string> {
  const s = await startMatchHandler(db, { game: 'four', level: 'medium' }, USER, { agentVersion: () => 'v1' })
  const { matchId, seed } = s.body as { matchId: string; seed: number }
  const rec: MatchRecordV1 = { ...playRandom('four', seed, 0), matchId }
  expect((await finishMatchHandler(db, encodeRecord(rec), USER, { siteElo: () => 1000 })).status).toBe(200)
  return matchId
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Uint8Array): { w: number; h: number } {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength)
  expect(Array.from(png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return { w: v.getUint32(16), h: v.getUint32(20) }
}

describe('share card PNG', () => {
  test('a public report renders as a 1200 by 630 PNG, and the same bytes come back from the cache', async () => {
    const id = await play()
    const png = (await cardPngFor(db, id, 'example.test/report/x'))!
    expect(pngSize(png)).toEqual({ w: 1200, h: 630 })
    expect(await cardPngFor(db, id, 'example.test/report/x')).toBe(png)
  })

  test('the text is drawn: the PNG is not the bare background', async () => {
    const id = await play()
    const withText = (await cardPngFor(db, id, 'example.test/report/x'))!
    const bare = await renderCardPng(shareCardSvg({ game: 'four', level: 'medium', outcome: 'win', moves: 0, link: 'x' }).replace(/<text[\s\S]*?<\/text>/g, ''))
    expect(withText.length).toBeGreaterThan(bare.length + 2000)
  })

  test('a private, unfinished or unknown report gets nothing', async () => {
    const id = await play()
    await setReportSettings(db, id, USER, { linkPublic: false })
    expect(await cardPngFor(db, id, 'x')).toBeNull()
    expect(await cardPngFor(db, 'nope', 'x')).toBeNull()
    const s = await startMatchHandler(db, { game: 'four', level: 'easy' }, USER, { agentVersion: () => 'v1' })
    expect(await cardPngFor(db, (s.body as { matchId: string }).matchId, 'x')).toBeNull()
  })

  test('turning the link off drops a cached card', async () => {
    const id = await play()
    expect(await cardPngFor(db, id, 'x')).not.toBeNull()
    await setReportSettings(db, id, USER, { linkPublic: false })
    expect(await cardPngFor(db, id, 'x')).toBeNull()
  })

  test('a card renders in under 500 ms once warm', async () => {
    await renderCardPng(shareCardSvg({ game: 'chess', level: 'easy', outcome: 'win', moves: 3, link: 'warm' }))
    const t = performance.now()
    await renderCardPng(shareCardSvg({ game: 'chess', level: 'hard', outcome: 'loss', moves: 41, link: 'duelwise-preview-deployment.vercel.app/report/0f8fad5b-d9cb-469f-a165-70867728950e' }))
    expect(performance.now() - t).toBeLessThan(500)
  })

  test('og:image and twitter:image point at the PNG address', () => {
    expect(cardImageUrl('https://example.test', 'abc')).toBe('https://example.test/report-card/abc.png')
  })
})
