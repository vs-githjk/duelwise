import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ARENA_BARS, buildArenaRegistry, gateArenaLevel, relativeSource } from './arena'
import { BARS, buildFighterRegistry, gateLevel, GATE_MATCHES, readFailedLevels, type BotRow, type PublishInput } from './fighter'

const FIXTURE = join(import.meta.dir, '../../test-fixtures/arena-v2-hard-b2.onnx')
/** Rows that clear every bar of a level by a wide margin. */
const seatRow = (games: number, wins: number) => ({ games, wins, draws: 0, losses: games - wins, score: wins / games })
const strongRows = (level: keyof typeof ARENA_BARS): BotRow[] =>
  [...Object.keys(ARENA_BARS[level]), ...(level === 'easy' ? ['human-proxy'] : [])].map((bot) => ({
    bot, games: GATE_MATCHES * 2, wins: bot === 'human-proxy' ? 560 : GATE_MATCHES * 2, draws: 0, losses: bot === 'human-proxy' ? 240 : 0, score: bot === 'human-proxy' ? 0.7 : 1, ci95: [0.99, 1],
    bySeat: { '0': seatRow(GATE_MATCHES, GATE_MATCHES), '1': seatRow(GATE_MATCHES, GATE_MATCHES) },
  }))
const model = (source: string) => ({ artifact: 'apps/web/public/agents/arena/v1/champion.onnx', absolute: FIXTURE, source, step: 1, obsFeatures: 90 })
const base = (over: Partial<PublishInput>): PublishInput => ({
  rows: { champion: strongRows('champion') },
  models: { champion: model('runs/arena-league/stageA/snap.pt') },
  elo: {},
  gatedSnapshot: { champion: false },
  commit: 'abc1234',
  now: '2026-10-22T00:00:00.000Z',
  trainedSteps: 1,
  ...over,
})

describe('registry publish gate', () => {
  test('repeatable fighter --failed flags retain both failing levels', () => {
    const failedRows: BotRow[] = []
    const failed = readFailedLevels(['publish', '--failed', 'hard=hard.json', '--failed', 'champion=champion.json'], () => failedRows)
    expect(Object.keys(failed)).toEqual(['hard', 'champion'])
    const reg = buildFighterRegistry(base({ rows: failed, models: { hard: model('hard'), champion: model('champion') }, gatedSnapshot: { hard: true, champion: true }, servedPractice: { hard: true, champion: true } }))
    expect(reg.unpublished?.hard).toContain('Practice serves')
    expect(reg.unpublished?.champion).toContain('Practice serves')
    expect(() => readFailedLevels(['--failed', 'hard=hard.json', '--failed', 'hard=other.json'], () => failedRows)).toThrow('duplicate --failed hard')
    expect(() => readFailedLevels(['--failed'], () => failedRows)).toThrow('--failed must be level=rows-file')
    const passing = Object.keys(BARS.hard).map((bot) => ({ bot, games: 800, wins: 800, draws: 0, losses: 0, score: 1, ci95: [1, 1] as [number, number], bySeat: { '0': seatRow(400, 400), '1': seatRow(400, 400) } }))
    expect(() => readFailedLevels(['--failed', 'hard=hard.json'], () => passing)).toThrow('--failed hard passed the gate')
  })
  test('a passing level whose snapshot is not gated is not published', () => {
    const reg = buildArenaRegistry(base({}))
    expect(reg.levels.champion).toBeUndefined()
    expect(reg.measured.champion).toBeUndefined()
    expect(reg.unpublished?.champion).toContain('in training')
  })

  test('a published level without a site Elo throws instead of writing 0', () => {
    expect(() => buildArenaRegistry(base({ gatedSnapshot: { champion: true } }))).toThrow('no site Elo')
  })

  test('a gated passing level with an Elo is published', () => {
    const reg = buildArenaRegistry(base({ gatedSnapshot: { champion: true }, elo: { champion: 1200 } }))
    expect(reg.levels.champion).toBeDefined()
    expect(reg.measured.champion?.siteElo).toBe(1200)
  })

  test('a failing gated arena snapshot keeps its gate reason without claiming Practice serves it', () => {
    const rows = strongRows('champion').map((row) => ({ ...row, bySeat: { '0': seatRow(200, 0), '1': seatRow(200, 0) } }))
    const reg = buildArenaRegistry(base({ rows: { champion: rows }, gatedSnapshot: { champion: true } }))
    expect(reg.unpublished?.champion).toMatch(/^in training: .*on seat/)
    expect(reg.unpublished?.champion).not.toContain('Practice serves')
  })

  test('a failed served fighter model includes the additional level failure', () => {
    const rows: BotRow[] = [{ bot: 'fireball', games: 800, wins: 0, draws: 0, losses: 800, score: 0, ci95: [0, 1], bySeat: { '0': seatRow(400, 0), '1': seatRow(400, 0) } }]
    const reg = buildFighterRegistry(base({ rows: { champion: rows }, servedPractice: { champion: true }, levelFailures: { champion: 'champion trails hard' } }))
    expect(reg.unpublished?.champion).toContain('Practice serves')
    expect(reg.unpublished?.champion).toContain('champion trails hard')
  })

  test('a failed non-gated fighter checkpoint keeps its final checkpoint reason', () => {
    const rows: BotRow[] = [{ bot: 'fireball', games: 800, wins: 0, draws: 0, losses: 800, score: 0, ci95: [0, 1], bySeat: { '0': seatRow(400, 0), '1': seatRow(400, 0) } }]
    const reg = buildFighterRegistry(base({ rows: { champion: rows } }))
    expect(reg.unpublished?.champion).toContain('no snapshot cleared')
    expect(reg.unpublished?.champion).toContain('Final checkpoint measured')
    expect(reg.unpublished?.champion).not.toContain('Practice serves')
  })
})

describe('the arena gate measures each seat (judge coldstore-r2 fix 1)', () => {
  test('Easy requires at least 30 percent actual losses to the average human proxy', () => {
    const rows = strongRows('easy')
    expect(gateArenaLevel('easy', rows).passed).toBe(true)
    expect(gateArenaLevel('easy', rows.filter((row) => row.bot !== 'human-proxy')).passed).toBe(false)
    const proxy = rows.find((row) => row.bot === 'human-proxy')!
    proxy.losses = 239
    proxy.draws = 1
    expect(gateArenaLevel('easy', rows).passed).toBe(false)
    expect(buildArenaRegistry(base({ rows: { easy: rows }, models: { easy: model('runs/x/gated/easy/s.pt') }, gatedSnapshot: { easy: true }, elo: { easy: 1000 } })).levels.easy).toBeUndefined()
  })
  /** Easy as it was measured: it averaged well over both seats and lost on the seat the page gives the AI. */
  const lopsided = (): BotRow[] =>
    strongRows('easy').map((r) => (r.bot === 'holdangle' ? { ...r, wins: 215, losses: 185, score: 215 / 400, bySeat: { '0': seatRow(400, 400), '1': seatRow(400, 15) } } : r))

  test('a level that clears every bar on average but fails on one seat does not pass, and says which seat', () => {
    const v = gateArenaLevel('easy', lopsided())
    expect(v.passed).toBe(false)
    expect(v.failures.join(' ')).toMatch(/holdangle on seat 1/)
    expect(v.failures.join(' ')).not.toMatch(/seat 0/)
  })

  test('200 games per seat cannot publish', () => {
    const rows = strongRows('champion').map((r) => ({ ...r, bySeat: { '0': seatRow(200, 200), '1': seatRow(200, 200) } }))
    expect(gateArenaLevel('champion', rows).passed).toBe(false)
    expect(buildArenaRegistry(base({ rows: { champion: rows }, gatedSnapshot: { champion: true }, elo: { champion: 1200 } })).levels.champion).toBeUndefined()
  })

  test('rows with no per-seat measurement cannot pass the arena gate', () => {
    const v = gateArenaLevel('easy', strongRows('easy').map(({ bySeat: _s, ...r }) => r))
    expect(v.passed).toBe(false)
    expect(v.failures.join(' ')).toMatch(/no per-seat measurement/)
  })

  test('strong on both seats passes, and the weakest row reported is the weakest seat of the weakest bot', () => {
    const rows = strongRows('easy').map((r) => (r.bot === 'rusher' ? { ...r, bySeat: { '0': seatRow(400, 400), '1': seatRow(400, 300) } } : r))
    const v = gateArenaLevel('easy', rows)
    expect(v.passed).toBe(true)
    expect(v.weakest.bot).toBe('rusher')
    expect(v.weakest.games).toBe(400)
    expect(v.weakest.wins).toBe(300)
  })

  test('the registry keeps an unpublished reason for a lopsided level, and records each seat', () => {
    const reg = buildArenaRegistry(base({ rows: { easy: lopsided() }, models: { easy: model('runs/x/gated/easy/s.pt') }, gatedSnapshot: { easy: true }, elo: { easy: 1000 } }))
    expect(reg.levels.easy).toBeUndefined()
    expect(reg.unpublished?.easy).toMatch(/seat 1/)
    const detail = (reg.versions[0]!.gate as { levels: { easy: { bots: Array<{ bot: string; bySeat?: unknown }> } } }).levels.easy.bots
    expect(detail.find((b) => b.bot === 'holdangle')?.bySeat).toBeDefined()
  })
})

describe('relativeSource', () => {
  test('makes a snapshot path under the common root repo-relative, and keeps a relative path as is', () => {
    expect(relativeSource('/home/a/proj/runs/x/gated/easy/s.pt', '/home/a/proj')).toBe('runs/x/gated/easy/s.pt')
    expect(relativeSource('runs/x/s.pt', '/home/a/proj')).toBe('runs/x/s.pt')
  })
  test('throws on an absolute path outside the common root rather than publishing a machine path', () => {
    expect(() => relativeSource('/elsewhere/s.pt', '/home/a/proj')).toThrow(/outside/)
  })
})

// A9, ruling Nov 10 18:52: Easy and Medium are decided by their people test and the ladder; the scripted-bot bars still bind Hard and Champion.
describe('people-gated Easy and Medium (the bars do not hold them back, nothing else loosens)', () => {
  /** Rows that lose to the turtle bot on both seats: below Easy's and Medium's old bar. */
  const weakRows = (level: 'easy' | 'medium' | 'hard'): BotRow[] =>
    Object.keys(BARS[level]).map((bot) => {
      const turtle = bot === 'turtle'
      const wins = turtle ? 90 : GATE_MATCHES * 2
      return { bot, games: GATE_MATCHES * 2, wins, draws: 0, losses: GATE_MATCHES * 2 - wins, score: wins / (GATE_MATCHES * 2), ci95: [0.99, 1] as [number, number], bySeat: { '0': seatRow(GATE_MATCHES, turtle ? 45 : GATE_MATCHES), '1': seatRow(GATE_MATCHES, turtle ? 45 : GATE_MATCHES) } }
    })
  const publish = (level: 'easy' | 'medium' | 'hard', peopleGated: boolean) =>
    buildFighterRegistry(base({ rows: { [level]: weakRows(level) }, models: { [level]: model(`runs/x/gated/${level}/s.pt`) }, gatedSnapshot: { [level]: true }, elo: { [level]: 1000 }, ...(peopleGated ? { peopleGated: { [level]: true as const } } : {}) }))

  test('without the people gate a level that loses to the turtle bot is not published (the old rule, unchanged)', () => {
    expect(gateLevel('easy', weakRows('easy'), BARS, true, GATE_MATCHES).passed).toBe(false)
    expect(publish('easy', false).levels.easy).toBeUndefined()
    expect(publish('medium', false).levels.medium).toBeUndefined()
  })
  test('with it, Easy and Medium publish, and the registry says the bars were recorded and not applied', () => {
    for (const level of ['easy', 'medium'] as const) {
      const reg = publish(level, true)
      expect(reg.levels[level]).toBeDefined()
      expect(reg.unpublished?.[level]).toBeUndefined()
      expect(reg.measured[level]?.opponents).toContain('not a publish bar')
      const detail = (reg.versions[0]!.gate as { levels: Record<string, { peopleGated?: boolean; bots: Array<{ bot: string; bar: number | null; lower: number }> }> }).levels[level]!
      expect(detail.peopleGated).toBe(true)
      const turtle = detail.bots.find((b) => b.bot === 'turtle')!
      expect(turtle.lower).toBeLessThan(turtle.bar!)
    }
  })
  test('a level that clears its bars carries no people-gate flag even when the exemption was available', () => {
    const rows = Object.keys(BARS.easy).map((bot) => ({ bot, games: GATE_MATCHES * 2, wins: GATE_MATCHES * 2, draws: 0, losses: 0, score: 1, ci95: [0.99, 1] as [number, number], bySeat: { '0': seatRow(GATE_MATCHES, GATE_MATCHES), '1': seatRow(GATE_MATCHES, GATE_MATCHES) } }))
    const reg = buildFighterRegistry(base({ rows: { easy: rows }, models: { easy: model('runs/x/gated/easy/s.pt') }, gatedSnapshot: { easy: true }, elo: { easy: 1000 }, peopleGated: { easy: true } }))
    expect(reg.levels.easy).toBeDefined()
    expect((reg.versions[0]!.gate as { levels: Record<string, { peopleGated?: boolean }> }).levels.easy!.peopleGated).toBeUndefined()
    expect(reg.measured.easy?.opponents).not.toContain('not a publish bar')
  })
  test('Hard never gets the exemption, even when asked for', () => {
    const reg = publish('hard', true)
    expect(reg.levels.hard).toBeUndefined()
    expect(reg.unpublished?.hard).toContain('turtle')
  })
  test('the Levels rule still holds an exempt level: a level that fails its ladder pair stays in training', () => {
    const reg = buildFighterRegistry(base({ rows: { easy: weakRows('easy') }, models: { easy: model('runs/x/gated/easy/s.pt') }, gatedSnapshot: { easy: true }, elo: { easy: 1000 }, peopleGated: { easy: true }, levelFailures: { easy: 'easy does not beat random' } }))
    expect(reg.levels.easy).toBeUndefined()
    expect(reg.unpublished?.easy).toBe('easy does not beat random')
  })
})
