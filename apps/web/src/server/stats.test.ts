import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'
import { encodeRecord } from '@duelwise/core/src/match-record'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import type { Registry } from '@duelwise/agents/src/registry'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { getGameStats, learnsFromHumansFor, parseSupervisor, WEEK_COUNT, summariseRegistry, withRegistryRuns } from './stats'

let client: PGlite
let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())
beforeEach(async () => {
  await db.execute(sql`truncate table match, training_run`)
})

const NOW = new Date('2026-10-21T12:00:00.000Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000)
let n = 0

interface Fixture {
  game?: 'four' | 'fighter' | 'chess' | 'holdem'
  level?: Level
  status?: 'started' | 'finished' | 'abandoned'
  /** Who won: the human, the agent, or nobody. */
  outcome?: 'human' | 'agent' | 'draw'
  humanSeat?: 0 | 1
  valid?: boolean
  allowed?: boolean
  flags?: Record<string, unknown> | null
  ageDays?: number
}

async function put(f: Fixture = {}) {
  const id = `m-${++n}`
  const game = f.game ?? 'four'
  const level = f.level ?? 'hard'
  const status = f.status ?? 'finished'
  const humanSeat = f.humanSeat ?? 0
  const winner = f.outcome === 'draw' ? null : (f.outcome ?? 'human') === 'human' ? humanSeat : ((1 - humanSeat) as 0 | 1)
  const result = { winner, score: [1, 0] as [number, number], reason: 'fixture' }
  const at = daysAgo(f.ageDays ?? 1)
  const record =
    status === 'finished'
      ? encodeRecord({
          schema: 1, matchId: id, game, coreVersion: '1', agent: { version: 'v1', level }, seed: n, humanSeat, actions: [],
          result, finalHash: '0123456789abcdef', startedAt: at.toISOString(), endedAt: at.toISOString(), device: 'desktop', input: 'mouse', trainingAllowed: true,
        })
      : null
  await db.insert(schema.match).values({
    id, game, guestId: 'g', agentVersion: 'v1', level, seed: n, status,
    result: status === 'finished' ? result : null,
    record,
    recordValid: status === 'finished' ? (f.valid ?? true) : null,
    invalidReason: f.valid === false ? 'replay failed' : null,
    filterFlags: f.flags ?? null,
    trainingAllowed: f.allowed ?? true,
    startedAt: at,
    finishedAt: status === 'finished' ? at : null,
  })
}

describe('getGameStats', () => {
  test('aggregates valid finished matches and ignores invalid, abandoned and unfinished ones', async () => {
    await put({ outcome: 'human' })
    await put({ outcome: 'agent' })
    await put({ outcome: 'agent' })
    await put({ outcome: 'draw' })
    await put({ status: 'abandoned', outcome: 'human' })
    await put({ status: 'started' })
    await put({ valid: false, outcome: 'human' })
    await put({ game: 'fighter', outcome: 'human' })
    const s = await getGameStats(db, 'four', NOW)
    expect(s.counted).toBe(4)
    expect(s.vsHard.last7).toEqual({ games: 4, wins: 1 })
    expect(s.vsHard.previous7).toEqual({ games: 0, wins: 0 })
    expect(s.weekly).toHaveLength(WEEK_COUNT)
    const last = s.weekly[WEEK_COUNT - 1]!
    expect(last.levels.hard).toEqual({ games: 4, wins: 1 })
    expect(last.levels.easy).toBeUndefined()
  })

  test('the human seat comes from the record, so a human on seat 1 is credited', async () => {
    await put({ humanSeat: 1, outcome: 'human' })
    await put({ humanSeat: 1, outcome: 'agent' })
    const s = await getGameStats(db, 'four', NOW)
    expect(s.vsHard.last7).toEqual({ games: 2, wins: 1 })
  })

  test('weeks are 7-day buckets ending now; the previous week feeds the delta', async () => {
    await put({ ageDays: 2, outcome: 'human' })
    await put({ ageDays: 9, outcome: 'agent' })
    await put({ ageDays: 10, outcome: 'human', level: 'easy' })
    await put({ ageDays: 200, outcome: 'human' })
    const s = await getGameStats(db, 'four', NOW)
    expect(s.vsHard.last7).toEqual({ games: 1, wins: 1 })
    expect(s.vsHard.previous7).toEqual({ games: 1, wins: 0 })
    expect(s.weekly[WEEK_COUNT - 2]!.levels.hard).toEqual({ games: 1, wins: 0 })
    expect(s.weekly[WEEK_COUNT - 2]!.levels.easy).toEqual({ games: 1, wins: 1 })
    expect(s.counted).toBe(4)
  })

  test('the funnel counts played, finished, passed filters, allowed and the reasons matches drop out', async () => {
    await put() // clean
    await put() // clean
    await put({ allowed: false }) // opted out
    await put({ flags: { tooShort: true } })
    await put({ flags: { tooShort: true, duplicate: true } })
    await put({ flags: { inhumanTiming: false } }) // a false flag is not a rejection
    await put({ valid: false })
    await put({ status: 'abandoned' })
    await put({ status: 'started' })
    const f = (await getGameStats(db, 'four', NOW)).funnel
    expect(f.played).toBe(9)
    expect(f.finished).toBe(7)
    expect(f.passedFilters).toBe(4)
    expect(f.allowed).toBe(3)
    expect(f.optedOut).toBe(1)
    expect(f.used).toBe(0)
    expect(f.reasons).toEqual({ abandoned: 1, 'replay failed': 1, tooShort: 2, duplicate: 1 })
  })

  test('the deferred-check bookkeeping flag is never a public filter reason', async () => {
    await put({ allowed: false, flags: { deferredCheckAt: 1, deferredTrainingRevoked: true } })
    await put({ flags: { deferredCheckAt: 1, deferredTrainingRevoked: false } })
    const f = (await getGameStats(db, 'four', NOW)).funnel
    expect(f.reasons).toEqual({})
    expect(f.passedFilters).toBe(0)
    const stats = await getGameStats(db, 'four', NOW)
    expect(stats.counted).toBe(0)
    expect(stats.vsHard.last7.games).toBe(0)
  })

  test('a game whose agent does not learn from people counts its flag-off matches as not learning, not opted out', async () => {
    await put({ game: 'fighter', allowed: false })
    await put({ game: 'fighter', allowed: false })
    const f = (await getGameStats(db, 'fighter', NOW, undefined, false)).funnel
    expect(f.optedOut).toBe(0)
    expect(f.notLearning).toBe(2)
  })

  test('used for training is the largest human_matches_used of a promoted run; a rejected run does not count', async () => {
    await db.insert(schema.trainingRun).values([
      { id: 'r1', game: 'four', challenger: 'v2', champion: 'v1', promoted: true, humanMatchesUsed: 12, gate: { winRate: 0.61, games: 400 } },
      { id: 'r2', game: 'four', challenger: 'v3', champion: 'v2', promoted: false, humanMatchesUsed: 90, gate: { winRate: 0.51, games: 400 } },
      { id: 'r3', game: 'fighter', challenger: 'v9', champion: 'v8', promoted: true, humanMatchesUsed: 500 },
    ])
    const s = await getGameStats(db, 'four', NOW)
    expect(s.funnel.used).toBe(12)
    expect(s.runs.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
    expect(s.runs.find((r) => r.id === 'r2')!.promoted).toBe(false)
  })

  test('promoted retrain versions in the registry count as runs, so the page shows them without a database write', async () => {
    const reg = { versions: [
      { version: 'v1', parent: null, createdAt: '2026-10-20T10:00:00Z', promotedAt: '2026-10-20T10:00:00Z', humanMatchesUsed: 0 },
      { version: 'v2', parent: 'v1', createdAt: '2026-10-21T10:00:00Z', promotedAt: '2026-10-21T10:00:00Z', humanMatchesUsed: 120 },
    ] } as unknown as Registry
    const s = withRegistryRuns(await getGameStats(db, 'four', NOW), reg)
    expect(s.runs).toMatchObject([{ challenger: 'v2', champion: 'v1', promoted: true, humanMatchesUsed: 120 }])
    expect(s.funnel.used).toBe(120)
    // a database row for the same challenger is not doubled
    await db.insert(schema.trainingRun).values({ id: 'r1', game: 'four', challenger: 'v2', champion: 'v1', promoted: true, humanMatchesUsed: 12, gate: {} })
    const t = withRegistryRuns(await getGameStats(db, 'four', NOW), reg)
    expect(t.runs.map((r) => r.id)).toEqual(['r1'])
    expect(withRegistryRuns(await getGameStats(db, 'four', NOW), null).runs).toHaveLength(1)
  })

  test('a game with no matches is all zeros, never NaN', async () => {
    const s = await getGameStats(db, 'fighter', NOW)
    expect(s.counted).toBe(0)
    expect(s.vsHard.last7).toEqual({ games: 0, wins: 0 })
    expect(s.funnel).toMatchObject({ played: 0, finished: 0, passedFilters: 0, allowed: 0, used: 0 })
  })
})

function registry(over: Partial<Registry> = {}): Registry {
  const base: Registry = {
    game: 'fighter',
    champion: 'v2',
    versions: [
      { version: 'v1', parent: null, createdAt: '2026-10-20T10:00:00Z', promotedAt: '2026-10-20T10:00:00Z', status: 'measured', artifacts: {}, sha256: {}, trainedSteps: 1000, humanMatchesUsed: 0, gate: null },
      {
        version: 'v2', parent: 'v1', createdAt: '2026-10-21T10:00:00Z', promotedAt: '2026-10-21T10:00:00Z', status: 'measured', artifacts: {}, sha256: {}, trainedSteps: 3000, humanMatchesUsed: 120,
        gate: { rule: 'beat the parent', changes: [{ label: 'Punish rate', delta: 9.4, unit: 'pp', note: 'on whiffed heavies' }] },
      },
    ],
    levels: { easy: { version: 'v2', config: { reactionFrames: 18, apmCap: 100 } }, medium: { version: 'v2', config: { reactionFrames: 15, apmCap: 160 } } },
    measured: {
      easy: { metric: 'win rate vs rushdown bot', value: 0.5, ci95: [0.45, 0.55], n: 400, opponents: 'bots', siteElo: 900, measuredAt: '2026-10-21T10:00:00Z', harness: 'bun', commit: 'abc' },
      medium: { metric: 'win rate vs rushdown bot', value: 0.7, ci95: [0.65, 0.75], n: 400, opponents: 'bots', siteElo: 1100, measuredAt: '2026-10-21T10:00:00Z', harness: 'bun', commit: 'abc' },
    },
    unpublished: { hard: 'in training: hard does not beat medium: score 0.5500 over 200 games' },
    learnsFromHumans: false,
  }
  return { ...base, ...over }
}

describe('summariseRegistry', () => {
  test('measured levels carry their numbers, unpublished levels say in training with the reason, the rest are preview', () => {
    const s = summariseRegistry(registry())
    expect(s.version).toBe('v2')
    expect(s.levels.map((l) => [l.level, l.state])).toEqual([['easy', 'measured'], ['medium', 'measured'], ['hard', 'in-training'], ['champion', 'in-training']])
    expect(s.levels[0]).toMatchObject({ value: 0.5, ci95: [0.45, 0.55], n: 400, reactionFrames: 18, apmCap: 100 })
    // Realtime games publish the plain measured line, never a chained site Elo.
    expect(s.levels[0]!.siteElo).toBeUndefined()
    expect(s.levels[0]!.plain).toContain('Beats our test bots in at least 4 of 10 games')
    expect(summariseRegistry(registry({ game: 'four' })).levels[0]).toMatchObject({ siteElo: 900 })
    expect(s.levels[2]!.reason).toBe('Hard has not yet proven it beats Medium.')
    expect(s.levels[3]!.reason).toContain('Practice')
    expect(s.publishedCount).toBe(2)
  })

  test('realtime limits come from the product limiter when the level config has none: Champion shows its minimum delay and no action cap, in-training levels show theirs too', () => {
    const reg = registry()
    reg.levels = { hard: { version: 'v2', config: {} }, champion: { version: 'v2', config: {} } }
    reg.measured = { hard: reg.measured.easy!, champion: reg.measured.medium! }
    reg.unpublished = { easy: 'in training: no snapshot cleared the scripted-bot gate during training, so easy is not published.' }
    const s = summariseRegistry(reg)
    const by = Object.fromEntries(s.levels.map((l) => [l.level, l]))
    expect(by.champion).toMatchObject({ state: 'measured', reactionFrames: PRODUCT.championMinDelayFrames, apmCap: null })
    expect(by.hard).toMatchObject({ reactionFrames: LEVEL_LIMITS.fighter.hard.delayFrames, apmCap: LEVEL_LIMITS.fighter.hard.apmCap })
    expect(by.easy).toMatchObject({ state: 'in-training', reactionFrames: LEVEL_LIMITS.fighter.easy.delayFrames, apmCap: LEVEL_LIMITS.fighter.easy.apmCap })
    // A turn-based game has no limiter.
    const four = summariseRegistry(registry({ game: 'four' }))
    expect(four.levels.every((l) => l.reactionFrames === undefined && l.apmCap === undefined)).toBe(true)
  })

  test('the history rule drops the internal ruling tag, never showing "R15:"', () => {
    const reg = registry()
    reg.versions[1]!.gate = { rule: 'R15: 400 matches per bot, learner on both seats' }
    expect(summariseRegistry(reg).history[0]!.rule).toBe('400 matches per bot, learner on both seats')
  })

  test('head to head pairs, per-version changes and the history come only from the registry', () => {
    const s = summariseRegistry(registry())
    expect(s.pairs).toEqual([])
    expect(s.changes?.version).toBe('v2')
    expect(s.changes?.items).toEqual([{ label: 'Punish rate', delta: 9.4, unit: 'pp', note: 'on whiffed heavies' }])
    expect(s.history.map((h) => h.version)).toEqual(['v2', 'v1'])
    expect(s.history[0]).toMatchObject({ parent: 'v1', status: 'measured', trainedSteps: 3000, humanMatchesUsed: 120 })
    expect(s.history[1]!.humanMatchesUsed).toBe(0)
  })

  test('pairs from the real word.json gate.duels equal the file', () => {
    const word = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'agents', 'registry', 'word.json'), 'utf8'))
    const s = summariseRegistry(word as Registry)
    const duels = word.versions.find((v: any) => v.version === word.champion).gate.duels
    expect(s.pairs).toHaveLength(3)
    expect(s.pairs.map((p) => [p.lower, p.upper, p.score, p.n, p.ci95])).toEqual(duels.map((d: any) => [d.lower, d.upper, d.score, d.n, d.ci95]))
  })

  test('pairs fall back to ladder measured blocks scored against the adjacent lower level', () => {
    const reg = registry()
    reg.versions[1]!.gate = null
    reg.measured.medium = { ...reg.measured.medium!, metric: 'score vs easy', opponents: 'easy', value: 0.7, ci95: [0.65, 0.75], n: 400 }
    reg.measured.easy = { ...reg.measured.easy!, metric: 'score vs bot', opponents: 'bot' }
    expect(summariseRegistry(reg).pairs).toEqual([{ lower: 'easy', upper: 'medium', score: 0.7, n: 400, ci95: [0.65, 0.75] }])
    reg.measured.medium!.opponents = 'hard'
    expect(summariseRegistry(reg).pairs).toEqual([])
  })

  test('a missing or preview-only registry is all in training with no invented numbers', () => {
    const none = summariseRegistry(null)
    expect(none.version).toBeNull()
    expect(none.levels.every((l) => l.state === 'in-training' && l.siteElo === undefined)).toBe(true)
    expect(none.publishedCount).toBe(0)
    expect(none.pairs).toEqual([])
    expect(none.changes).toBeNull()
  })

  test('malformed gate data is ignored, not trusted', () => {
    const reg = registry()
    reg.versions[1]!.gate = { duels: [{ lower: 'easy' }, 'x', { lower: 'a', upper: 'b', score: 'many', n: 1, ci95: [0, 1] }, { lower: 'easy', upper: 'medium', score: 0.6, n: 10, ci95: [0.5] }], changes: [{ label: 1 }] }
    const s = summariseRegistry(reg)
    expect(s.pairs).toEqual([])
    expect(s.changes).toBeNull()
  })
})

describe('learnsFromHumansFor', () => {
  test('not yet for every game when adapters.json does not exist', () => {
    expect(learnsFromHumansFor(null, 'four')).toBe(false)
  })
  test('true only for a game the file marks live', () => {
    const adapters = { four: { learns: true }, chess: true, fighter: { learns: false }, word: 'yes' }
    expect(learnsFromHumansFor(adapters, 'four')).toBe(true)
    expect(learnsFromHumansFor(adapters, 'chess')).toBe(true)
    expect(learnsFromHumansFor(adapters, 'fighter')).toBe(false)
    expect(learnsFromHumansFor(adapters, 'word')).toBe(false)
    expect(learnsFromHumansFor(adapters, 'holdem')).toBe(false)
    expect(learnsFromHumansFor({ games: { four: { learns: true } } }, 'four')).toBe(true)
  })
})

describe('parseSupervisor', () => {
  test('maps jobs to games and keeps only fields that exist', () => {
    const jobs = parseSupervisor({
      budget: { cpuSlots: 5 },
      jobs: {
        'four-az': { state: 'DONE', cpuSlots: 2, startedAt: 1792574929.9, finishedAt: 1792620791.1, steps: 900, heartbeatAgeS: null, reason: null },
        'chess-value': { state: 'RUNNING', cpuSlots: 1, startedAt: 1792615930.3, heartbeatAgeS: 12, reason: 'maxHours exceeded' },
        'arena-league': { state: 'QUEUED', cpuSlots: 2 },
        mystery: { state: 5 },
      },
    })
    expect(jobs.map((j) => j.name)).toEqual(['arena-league', 'chess-value', 'four-az', 'mystery'])
    expect(jobs[1]).toEqual({ name: 'chess-value', game: 'chess', state: 'RUNNING' })
    expect(jobs[2]).toEqual({ name: 'four-az', game: 'four', state: 'DONE', finishedAt: 1792620791.1, steps: 900 })
    expect(JSON.stringify(jobs)).not.toMatch(/maxHours|heartbeat|cpuSlots|restarts/i)
    expect(jobs[0]).toMatchObject({ game: 'arena', state: 'QUEUED' })
    expect(jobs[3]).toMatchObject({ game: null, state: 'UNKNOWN' })
  })
  test('garbage gives an empty list', () => {
    expect(parseSupervisor(null)).toEqual([])
    expect(parseSupervisor({ jobs: 'x' })).toEqual([])
  })
})

describe('funnel with the production rule', () => {
  test('a Four opt-out counts as opted out and a Hold\'em flag-off row as not learning', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { recordsTrainable } = await import('../lib/honest-copy')
    const reg = (g: string) => JSON.parse(readFileSync(join(import.meta.dir, `../../../../packages/agents/registry/${g}.json`), 'utf8'))
    await put({ game: 'four', allowed: false })
    await put({ game: 'holdem', allowed: false })
    const c = (await getGameStats(db, 'four', NOW, undefined, recordsTrainable('four', reg('four')))).funnel
    expect([c.optedOut, c.notLearning]).toEqual([1, 0])
    const h = (await getGameStats(db, 'holdem', NOW, undefined, recordsTrainable('holdem', reg('holdem')))).funnel
    expect([h.optedOut, h.notLearning]).toEqual([0, 1])
  })
})
