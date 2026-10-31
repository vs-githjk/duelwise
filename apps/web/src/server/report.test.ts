import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { playRandom, playRealtime } from '../report/testing'
import { startMatchHandler } from './match-handlers'
import { finishUnchecked as finishMatchHandler } from './finish-unchecked'
import { resignMatchHandler } from './resign'
import { abandonStale } from './abandon'
import { getCardFacts, getReport, setReportSettings } from './report'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getCore } from '@duelwise/core/src/games/index'
import type { GameId } from '@duelwise/core/src/product'
import { recordsTrainable } from '../lib/honest-copy'
import { loadChessEvaluator, resetChessEvaluator } from './report-eval'
import type { ReportBody } from '../report/types'

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
  await db.execute(sql`truncate table match, guest, rating, profile, match_report, telemetry_event, "user" cascade`)
  await db.insert(schema.user).values({ id: 'u-1', name: 'Real Name', email: 'real.person@example.test' })
  await db.insert(schema.guest).values([{ id: 'g-1' }, { id: 'g-2' }])
})

const USER = { userId: 'u-1' }
const GUEST = { guestId: 'g-1' }
const STRANGER = { guestId: 'g-2' }

/** Starts a Four in a Row match for `who` and finishes it with a replayable random game; returns the match id. */
async function play(who: { userId?: string; guestId?: string }, game: 'four' | 'word' | 'chess' | 'holdem' | 'fighter' | 'arena' = 'four'): Promise<string> {
  const s = await startMatchHandler(db, { game, level: 'medium' }, who, { agentVersion: () => 'v1' })
  const { matchId, seed: issued, sealed } = s.body as { matchId: string; seed: number; sealed?: boolean }
  // A sealed match (Word Duel) withholds its seed from the browser; the test reads the server's row instead.
  const seed = sealed ? (await db.select().from(schema.match).where(eq(schema.match.id, matchId)))[0]!.seed : issued
  const rec: MatchRecordV1 = { ...(game === 'fighter' || game === 'arena' ? playRealtime(game, seed, 0) : playRandom(game, seed, 0)), matchId }
  if (sealed) {
    // The browser's marks calls store the rounds as they are played; stand in for them with the record's own guesses.
    const core = getCore('word')
    const wordGuesses: [string[], string[]] = [[], []]
    for (const [, seat, a] of rec.actions) wordGuesses[seat].push(core.decodeAction(a) as string)
    await db.update(schema.match).set({ filterFlags: { wordGuesses } }).where(eq(schema.match.id, matchId))
  }
  const f = await finishMatchHandler(db, encodeRecord(rec), who, { siteElo: () => 1000 })
  expect(f.status).toBe(200)
  return matchId
}

describe('report from a stored record', () => {
  test('builds from the record by replay and says who played', async () => {
    const id = await play(USER)
    const v = (await getReport(db, id, USER))!
    expect(v.status).toBe('ready')
    expect(v.mode).toBe('owner')
    expect(v.game).toBe('four')
    expect(v.level).toBe('medium')
    expect(v.body!.evaluator).toBe('solver')
    expect(v.body!.moments.at(-1)!.kind).toBe('end')
    expect(v.owner!.rating).not.toBeNull()
    expect(typeof v.owner!.rating!.before).toBe('number')
    expect(v.owner!.learning).toEqual({ state: 'stored' })
  })

  test('the built report is cached and served again unchanged', async () => {
    const id = await play(USER)
    const a = await getReport(db, id, USER)
    const row = (await db.select().from(schema.matchReport).where(eq(schema.matchReport.matchId, id)))[0]!
    expect(row.built).not.toBeNull()
    const b = await getReport(db, id, USER)
    expect(b!.body).toEqual(a!.body)
  })

  test('a word match is reported guess by guess', async () => {
    const id = await play(USER, 'word')
    const v = (await getReport(db, id, USER))!
    expect(v.body!.wordRows!.length).toBeGreaterThan(1)
  })

  test('an unknown id is null', async () => {
    expect(await getReport(db, 'nope', USER)).toBeNull()
    expect(await getReport(db, 'x'.repeat(200), USER)).toBeNull()
  })
})

describe('a public report never exposes who played', () => {
  test('no email, name, user or guest id, rating or training status in the public view', async () => {
    const id = await play(USER)
    await setReportSettings(db, id, USER, { showName: false })
    const v = (await getReport(db, id, STRANGER))!
    expect(v.mode).toBe('public')
    expect(v.owner).toBeNull()
    const json = JSON.stringify(v)
    for (const secret of ['real.person@example.test', 'Real Name', 'u-1', 'g-1', 'g-2', 'eloBefore', 'rating', 'trainingAllowed', 'guestId', 'userId']) {
      expect(json).not.toContain(secret)
    }
    // The only identifier is the report's own id.
    expect(v.id).toBe(id)
    // Not signed in at all is the same view.
    expect(await getReport(db, id, {})).toEqual(v)
  })

  test('the name appears only when the player turned it on', async () => {
    const id = await play(USER)
    expect((await getReport(db, id, STRANGER))!.playerName).toBeNull()
    expect(await setReportSettings(db, id, USER, { showName: true })).toBe(true)
    expect((await getReport(db, id, STRANGER))!.playerName).toBe('Real Name')
    expect((await getReport(db, id, STRANGER))!.owner).toBeNull()
  })

  test('only the player can change settings', async () => {
    const id = await play(USER)
    expect(await setReportSettings(db, id, STRANGER, { linkPublic: false })).toBe(false)
    expect(await setReportSettings(db, id, {}, { linkPublic: false })).toBe(false)
    expect((await getReport(db, id, STRANGER))!.status).toBe('ready')
  })

  test('a guest has no name to show', async () => {
    const id = await play(GUEST)
    await setReportSettings(db, id, GUEST, { showName: true })
    expect((await getReport(db, id, STRANGER))!.playerName).toBeNull()
    const own = (await getReport(db, id, GUEST))!
    expect(own.owner!.signedIn).toBe(false)
    expect(own.owner!.rating).toBeNull()
  })
})

describe('states', () => {
  test('private: a turned-off link shows nothing to others and everything to the player', async () => {
    const id = await play(USER)
    await setReportSettings(db, id, USER, { linkPublic: false })
    const other = (await getReport(db, id, STRANGER))!
    expect(other.status).toBe('private')
    expect(other.body).toBeNull()
    expect(other.day).toBeNull()
    expect((await getReport(db, id, USER))!.status).toBe('ready')
  })

  test('opted out: stats only, and the report still builds', async () => {
    await db.insert(schema.profile).values({ userId: 'u-1', trainingAllowed: false })
    const id = await play(USER)
    const v = (await getReport(db, id, USER))!
    expect(v.status).toBe('ready')
    expect(v.owner!.learning).toEqual({ state: 'stats_only', reason: 'opt_out' })
  })

  test('a flag-off record in a game that stores records untrainable by design is not_learning, whatever the switch says', async () => {
    const s = await startMatchHandler(db, { game: 'four', level: 'medium' }, GUEST, { agentVersion: () => 'v1' })
    const { matchId, seed } = s.body as { matchId: string; seed: number }
    const rec: MatchRecordV1 = { ...playRandom('four', seed, 0), matchId, trainingAllowed: false }
    expect((await finishMatchHandler(db, encodeRecord(rec), GUEST, { siteElo: () => 1000 })).status).toBe(200)
    const g = (await getReport(db, matchId, GUEST, { recordsTrainable: () => false }))!
    expect(g.owner!.learning).toEqual({ state: 'not_used', reason: 'not_learning' })
  })

  test('with the production rule, a Four opt-out is stats_only and a flag-off row in a game that does not learn (chess, Hold\'em) is not_learning', async () => {
    const reg = (g: string) => JSON.parse(readFileSync(join(import.meta.dir, `../../../../packages/agents/registry/${g}.json`), 'utf8'))
    const prod = (g: GameId) => recordsTrainable(g, reg(g))
    expect(prod('holdem')).toBe(false)
    await db.insert(schema.profile).values({ userId: 'u-1', trainingAllowed: false })
    const fourId = await play(USER, 'four')
    expect((await getReport(db, fourId, USER, { recordsTrainable: prod }))!.owner!.learning).toEqual({ state: 'stats_only', reason: 'opt_out' })
    expect(prod('chess')).toBe(false)
    await db.update(schema.match).set({ game: 'holdem' }).where(eq(schema.match.userId, 'u-1'))
    const [row] = await db.select({ id: schema.match.id }).from(schema.match).where(eq(schema.match.userId, 'u-1')).limit(1)
    const h = (await getReport(db, row!.id, USER, { recordsTrainable: prod }))!
    expect(h.owner!.learning).toEqual({ state: 'not_used', reason: 'not_learning' })
  })

  test('a chess row stored with trainingAllowed=true before the rule is not_learning under the production rule', async () => {
    const reg = JSON.parse(readFileSync(join(import.meta.dir, '../../../../packages/agents/registry/chess.json'), 'utf8'))
    const prod = (g: GameId) => recordsTrainable(g, reg)
    expect(prod('chess')).toBe(false)
    const id = await play(USER, 'four')
    await db.update(schema.match).set({ game: 'chess', trainingAllowed: true }).where(eq(schema.match.id, id))
    const v = (await getReport(db, id, USER, { recordsTrainable: prod }))!
    expect(v.owner!.learning).toEqual({ state: 'not_used', reason: 'not_learning' })
  })

  test('writing: a match that has not finished has no report yet', async () => {
    const s = await startMatchHandler(db, { game: 'four', level: 'easy' }, USER, { agentVersion: () => 'v1' })
    const v = (await getReport(db, (s.body as { matchId: string }).matchId, USER))!
    expect(v.status).toBe('writing')
    expect(v.body).toBeNull()
  })

  test('resigned: the result and rating change, never used for training', async () => {
    const s = await startMatchHandler(db, { game: 'four', level: 'easy' }, USER, { agentVersion: () => 'v1' })
    const id = (s.body as { matchId: string }).matchId
    await resignMatchHandler(db, { matchId: id, tick: 3 }, USER, { siteElo: () => 1000 })
    const v = (await getReport(db, id, USER))!
    expect(v.status).toBe('resigned')
    expect(v.body!.outcome).toBe('loss')
    expect(v.body!.moments).toEqual([])
    expect(v.owner!.rating!.after).toBeLessThan(v.owner!.rating!.before)
    expect(v.owner!.learning).toEqual({ state: 'not_used', reason: 'resigned' })
  })

  test('abandoned: marked abandoned with the loss it cost', async () => {
    const s = await startMatchHandler(db, { game: 'four', level: 'easy' }, USER, { agentVersion: () => 'v1' })
    const id = (s.body as { matchId: string }).matchId
    await abandonStale(db, new Date(Date.now() + 3 * 3600 * 1000), { siteElo: () => 1000 })
    const v = (await getReport(db, id, USER))!
    expect(v.status).toBe('abandoned')
    expect(v.body!.durationMs).toBe(0)
    expect(v.owner!.rating).not.toBeNull()
    expect(v.owner!.learning).toEqual({ state: 'not_used', reason: 'abandoned' })
  })

  test('resigned: keeps the measured duration', async () => {
    const s = await startMatchHandler(db, { game: 'four', level: 'easy' }, USER, { agentVersion: () => 'v1' })
    const id = (s.body as { matchId: string }).matchId
    await resignMatchHandler(db, { matchId: id, tick: 3 }, USER, { siteElo: () => 1000 })
    await db.update(schema.match).set({ finishedAt: new Date(Date.now() + 90_000) }).where(eq(schema.match.id, id))
    const v = (await getReport(db, id, USER))!
    expect(v.body!.durationMs).toBeGreaterThan(60_000)
  })

  test('rejected: a record that did not replay has no report', async () => {
    const id = await play(USER)
    await db.update(schema.match).set({ recordValid: false, invalidReason: 'x' }).where(eq(schema.match.id, id))
    await db.delete(schema.matchReport).where(eq(schema.matchReport.matchId, id))
    const v = (await getReport(db, id, USER))!
    expect(v.status).toBe('rejected')
    expect(v.owner!.learning).toEqual({ state: 'not_used', reason: 'rejected' })
  })
})

const VALUE_BIN = `${import.meta.dir}/../../public/agents/chess/v1/value.bin`

describe('chess evaluator', () => {
  test('uses the value net when its file is in public/, and a net report is cached', async () => {
    resetChessEvaluator()
    const ev = await loadChessEvaluator()
    // The file is checked in: a silent fall back to the material count must fail here.
    expect(existsSync(VALUE_BIN)).toBe(true)
    expect(ev.kind).toBe('value-net')
    const id = await play(USER, 'chess')
    const v = (await getReport(db, id, USER, { chessEvaluator: loadChessEvaluator }))!
    expect(v.body!.evaluator).toBe('value-net')
    const row = (await db.select().from(schema.matchReport).where(eq(schema.matchReport.matchId, id)))[0]!
    expect(row.built).not.toBeNull()
  }, 60_000)

  test('in production the net is fetched from the site own static asset, not read from disk', async () => {
    resetChessEvaluator()
    const urls: string[] = []
    const bytes = readFileSync(VALUE_BIN)
    const fake = (async (url: string) => {
      urls.push(url)
      return new Response(bytes)
    }) as unknown as typeof fetch
    const ev = await loadChessEvaluator({ origin: 'https://site.test/', fetch: fake, fsFallback: false })
    expect(ev.kind).toBe('value-net')
    expect(urls).toEqual(['https://site.test/agents/chess/v1/value.bin'])
    resetChessEvaluator()
  })

  test('when the asset cannot be fetched and no file read is allowed, it says material and tries again next time', async () => {
    resetChessEvaluator()
    const down = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    expect((await loadChessEvaluator({ origin: 'https://site.test', fetch: down, fsFallback: false })).kind).toBe('material')
    expect((await loadChessEvaluator()).kind).toBe('value-net')
    resetChessEvaluator()
  }, 60_000)
})

describe('a guest who signs in', () => {
  test('keeps the owner view and can still turn the link off', async () => {
    const id = await play(GUEST, 'four')
    const both = { userId: 'u-1', guestId: 'g-1' }
    const v = (await getReport(db, id, both))!
    expect(v.mode).toBe('owner')
    expect(await setReportSettings(db, id, both, { linkPublic: false })).toBe(true)
    expect((await getReport(db, id, STRANGER))!.status).toBe('private')
    expect((await getReport(db, id, both))!.status).toBe('ready')
    // A different signed-in user without that guest cookie is a stranger.
    await db.insert(schema.user).values({ id: 'u-2', name: 'Other', email: 'other@example.test' })
    expect((await getReport(db, id, { userId: 'u-2' }))!.mode).toBe('public')
  })
})

const bodyText = (b: ReportBody): string => [b.reason, b.note ?? '', b.reaction ?? '', b.series?.label ?? '', ...b.moments.map((m) => `${m.label} ${m.tag} ${m.text}`)].join('\n')
const SECOND_PERSON = /\b(you|your|yours|yourself)\b/i

describe('the public view speaks about the player, never to them', () => {
  test.each(['four', 'word', 'chess'] as const)('%s: the owner is addressed as you, a stranger is not', async (game) => {
    const id = await play(USER, game)
    const owner = (await getReport(db, id, USER, { chessEvaluator: loadChessEvaluator }))!
    const pub = (await getReport(db, id, STRANGER, { chessEvaluator: loadChessEvaluator }))!
    expect(pub.mode).toBe('public')
    expect(bodyText(owner.body!)).toMatch(SECOND_PERSON)
    expect(bodyText(pub.body!)).not.toMatch(SECOND_PERSON)
    expect(pub.body!.moments.length).toBe(owner.body!.moments.length)
    // Same facts, same cached build: only the wording differs.
    expect(pub.body!.outcome).toBe(owner.body!.outcome)
    expect(pub.body!.moves).toBe(owner.body!.moves)
  }, 60_000)

  test('a resigned match says the player resigned', async () => {
    const s = await startMatchHandler(db, { game: 'four', level: 'easy' }, USER, { agentVersion: () => 'v1' })
    const id = (s.body as { matchId: string }).matchId
    await resignMatchHandler(db, { matchId: id, tick: 3 }, USER, { siteElo: () => 1000 })
    expect((await getReport(db, id, USER))!.body!.reason).toBe('You resigned.')
    const pub = (await getReport(db, id, STRANGER))!
    expect(pub.body!.reason).toBe('The player resigned.')
    expect(bodyText(pub.body!)).not.toMatch(SECOND_PERSON)
  })
})

describe('record against this persona', () => {
  test('the owner sees wins, losses and draws at this game and level; the public sees none of it', async () => {
    const a = await play(USER)
    await play(USER)
    // A different level and a different game are not counted.
    const other = await startMatchHandler(db, { game: 'four', level: 'easy' }, USER, { agentVersion: () => 'v1' })
    await resignMatchHandler(db, { matchId: (other.body as { matchId: string }).matchId, tick: 3 }, USER, { siteElo: () => 1000 })
    await play(USER, 'word')
    // A resignation at this level counts as a loss.
    const res = await startMatchHandler(db, { game: 'four', level: 'medium' }, USER, { agentVersion: () => 'v1' })
    await resignMatchHandler(db, { matchId: (res.body as { matchId: string }).matchId, tick: 3 }, USER, { siteElo: () => 1000 })
    const v = (await getReport(db, a, USER))!
    const r = v.owner!.record
    expect(r.wins + r.losses + r.draws).toBe(3)
    expect(r.losses).toBeGreaterThanOrEqual(1)
    expect(r.recent.length).toBe(3)
    expect(r.recent[0]).toBe('loss')
    const pub = (await getReport(db, a, STRANGER))!
    expect(pub.owner).toBeNull()
    expect(JSON.stringify(pub)).not.toContain('"record"')
  })

  test('a guest has a record too, and a brand new player has one match', async () => {
    const id = await play(GUEST)
    const r = (await getReport(db, id, GUEST))!.owner!.record
    expect(r.wins + r.losses + r.draws).toBe(1)
    expect(r.recent.length).toBe(1)
  })
})

describe('the share card and the report page print the same counts, in every game', () => {
  for (const game of ['four', 'chess', 'word', 'holdem', 'fighter', 'arena'] as const) {
    test(game, async () => {
      const id = await play(USER, game)
      const v = (await getReport(db, id, USER))!
      const facts = (await getCardFacts(db, id))!
      expect(v.status).toBe('ready')
      expect(facts.moves).toBe(v.body!.moves)
      expect(facts.rounds ?? null).toEqual(v.body!.rounds ?? null)
      if (game === 'fighter' || game === 'arena') expect(v.body!.rounds).not.toBeNull()
      else expect(v.body!.moves).toBeGreaterThan(0)
    })
  }
})

describe('share card facts', () => {
  test('come from the record and stay empty for anything private or unfinished', async () => {
    const id = await play(USER)
    const full = (await getReport(db, id, USER))!
    const facts = (await getCardFacts(db, id))!
    expect(facts).toEqual({ game: 'four', level: 'medium', outcome: full.body!.outcome, moves: full.body!.moves })
    await setReportSettings(db, id, USER, { linkPublic: false })
    expect(await getCardFacts(db, id)).toBeNull()
    expect(await getCardFacts(db, 'nope')).toBeNull()
    const s = await startMatchHandler(db, { game: 'four', level: 'easy' }, USER, { agentVersion: () => 'v1' })
    expect(await getCardFacts(db, (s.body as { matchId: string }).matchId)).toBeNull()
  })
})
