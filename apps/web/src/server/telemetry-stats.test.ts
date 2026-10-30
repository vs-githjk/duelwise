import { describe, expect, test } from 'bun:test'
import { buildOwnerView, humanTargetFromSiteElo, MIN_DRIFT_N, wilsonInterval, type EventRow, type OwnerViewInput } from './telemetry-stats'

const NOW = new Date('2026-10-22T12:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)
let n = 0

function ev(o: Partial<EventRow> & Pick<EventRow, 'kind'>): EventRow {
  return {
    at: hoursAgo(5), matchId: `m-${++n}`, game: 'chess', level: 'easy', persona: 'Pip', device: 'desktop', durationMs: 60_000,
    outcome: null, reason: null, optedOut: false, playerRef: 'pl_aaaaaa', playerKind: 'user', ...o,
  }
}
/** A finished match: its start event and its finish. */
function played(outcome: 'human' | 'ai' | 'draw', o: Partial<EventRow> = {}): EventRow[] {
  const id = `m-${++n}`
  return [ev({ kind: 'match_started', matchId: id, durationMs: null, ...o }), ev({ kind: 'match_finished', matchId: id, outcome, ...o })]
}
function ended(kind: 'match_abandoned' | 'match_resigned', o: Partial<EventRow> = {}): EventRow[] {
  const id = `m-${++n}`
  return [ev({ kind: 'match_started', matchId: id, durationMs: null, ...o }), ev({ kind, matchId: id, ...o })]
}
const many = (k: number, outcome: 'human' | 'ai' | 'draw', o: Partial<EventRow> = {}) => Array.from({ length: k }, () => played(outcome, o)).flat()

function view(events: EventRow[], over: Partial<OwnerViewInput> = {}) {
  return buildOwnerView({
    events, firstSeen: new Map(), providers: new Map(), now: NOW, range: '7d', page: 0, targetFor: () => null, ...over,
  })
}

describe('wilson and targets', () => {
  test('the interval brackets the rate and narrows with more games', () => {
    const [a, b] = wilsonInterval(20, 50)
    expect(a).toBeLessThan(0.4)
    expect(b).toBeGreaterThan(0.4)
    const [c, d] = wilsonInterval(200, 500)
    expect(d - c).toBeLessThan(b - a)
    expect(wilsonInterval(0, 0)).toEqual([0, 1])
  })
  test('the target is the Elo expected score of the level against a new player, null while unmeasured', () => {
    expect(humanTargetFromSiteElo(1000)).toBeCloseTo(0.5, 5)
    expect(humanTargetFromSiteElo(1400)).toBeCloseTo(0.9091, 3)
    expect(humanTargetFromSiteElo(null)).toBeNull()
  })
})

describe('drift alert', () => {
  const target = () => 0.5
  test('fires when the measured AI score leaves the interval around the target', () => {
    // 40 of 40 decisive AI wins against a 0.5 target: interval excludes it.
    const v = view(many(40, 'ai'), { targetFor: target })
    const row = v.drift.find((d) => d.level === 'easy')!
    expect(row.state).toBe('ai-above')
    expect(v.alerts).toHaveLength(1)
    expect(v.alerts[0]).toMatchObject({ level: 'easy', persona: 'Pip', direction: 'above', target: 0.5, n: 40 })
    const low = view(many(40, 'human'), { targetFor: target })
    expect(low.drift.find((d) => d.level === 'easy')!.state).toBe('ai-below')
    expect(low.alerts[0]!.direction).toBe('below')
  })
  test('stays quiet while the interval still contains the target', () => {
    const v = view([...many(21, 'ai'), ...many(19, 'human')], { targetFor: target })
    expect(v.drift.find((d) => d.level === 'easy')!.state).toBe('ok')
    expect(v.alerts).toEqual([])
  })
  test('waits for enough games and for a measured target', () => {
    const few = view(many(MIN_DRIFT_N - 1, 'ai'), { targetFor: target })
    expect(few.drift.find((d) => d.level === 'easy')!.state).toBe('few')
    expect(few.alerts).toEqual([])
    const none = view(many(40, 'ai'))
    expect(none.drift.find((d) => d.level === 'easy')!.state).toBe('no-target')
    expect(none.alerts).toEqual([])
  })
  test('invalid finishes are not scored', () => {
    const extra = [ev({ kind: 'match_finished', outcome: null, reason: 'bad' })]
    const v = view([...many(20, 'draw'), ...extra], { targetFor: target })
    const row = v.drift.find((d) => d.level === 'easy')!
    expect(row.n).toBe(20)
    expect(row.rate).toBeCloseTo(0.5, 5)
    expect(row.state).toBe('ok')
  })
  test('draws count half', () => {
    const row = view(many(20, 'draw'), { targetFor: target }).drift.find((d) => d.level === 'easy')!
    expect(row.rate).toBeCloseTo(0.5, 5)
  })
  test('resignations are rated AI wins in the drift and the AI win KPI', () => {
    const events = [...Array.from({ length: 20 }, () => ended('match_resigned')).flat(), ...many(10, 'ai'), ...many(10, 'human')]
    const v = view(events, { targetFor: () => 0.76 })
    const row = v.drift.find((d) => d.level === 'easy')!
    expect(row.n).toBe(40)
    expect(row.rate).toBeCloseTo(0.75, 5)
    expect(row.state).toBe('ok')
    expect(v.alerts).toEqual([])
    expect(v.kpis.aiWin.rate).toBeCloseTo(0.75, 5)
  })
  test('abandons are rated AI wins too (R14)', () => {
    const events = [...Array.from({ length: 20 }, () => ended('match_abandoned')).flat(), ...many(10, 'ai'), ...many(10, 'human')]
    const v = view(events, { targetFor: () => 0.76 })
    const row = v.drift.find((d) => d.level === 'easy')!
    expect(row.n).toBe(40)
    expect(row.rate).toBeCloseTo(0.75, 5)
    expect(row.state).toBe('ok')
    expect(v.alerts).toEqual([])
    expect(v.kpis.aiWin.rate).toBeCloseTo(0.75, 5)
  })
})

describe('owner view panels', () => {
  const events = [
    ...played('human', { playerRef: 'pl_aaaaaa', game: 'chess', level: 'easy', device: 'phone', durationMs: 9 * 60_000 }),
    ...played('ai', { playerRef: 'pl_bbbbbb', game: 'word', level: 'medium', persona: 'Marlow', device: 'desktop', durationMs: 60_000, optedOut: true }),
    ...played('draw', { playerRef: 'pl_bbbbbb', game: 'chess', level: 'hard', persona: 'Vesper', device: 'tablet', durationMs: 3 * 60_000 }),
    ...ended('match_abandoned', { playerRef: 'pl_cccccc', playerKind: 'guest', game: 'four' }),
    ...ended('match_resigned', { playerRef: 'pl_cccccc', playerKind: 'guest', game: 'four' }),
    // outside the 7 day window: counts only for the previous period and the first-seen lookup
    ...played('ai', { at: hoursAgo(24 * 9), playerRef: 'pl_aaaaaa' }),
  ]
  const first = new Map([['pl_aaaaaa', hoursAgo(24 * 9)], ['pl_bbbbbb', hoursAgo(3)], ['pl_cccccc', hoursAgo(2)]])
  const v = view(events, { firstSeen: first, providers: new Map([['pl_aaaaaa', 'google']]) })

  test('kpis', () => {
    expect(v.kpis.players).toMatchObject({ value: 3, newCount: 2, returning: 1 })
    expect(v.kpis.matches.value).toBe(5)
    expect(v.kpis.matches.previous).toBe(1)
    expect(v.kpis.aiWin).toMatchObject({ rate: 3 / 5, humans: 1 / 5, draws: 1 / 5 })
    expect(v.kpis.medianMs.value).toBe(3 * 60_000)
    expect(v.kpis.ending).toMatchObject({ abandon: 1 / 5, resign: 1 / 5 })
    expect(v.kpis.optOut).toMatchObject({ optedOut: 1, players: 3 })
    expect(v.kpis.matches.series).toHaveLength(7)
  })
  test('matches per game and level, devices and why matches end', () => {
    expect(v.perGameLevel.find((g) => g.game === 'chess')).toMatchObject({ total: 2, levels: { easy: 1, hard: 1, medium: 0, champion: 0 } })
    expect(v.perGameLevel.find((g) => g.game === 'fighter')!.total).toBe(0)
    expect(v.devices.find((d) => d.device === 'phone')!.count).toBe(1)
    expect(v.devices.reduce((a, d) => a + d.share, 0)).toBeCloseTo(1, 5)
    expect(v.ending.finished).toBe(3)
    expect(v.ending.abandoned).toBe(1)
    expect(v.ending.resigned).toBe(1)
  })
  test('match length median and histogram per game', () => {
    const chess = v.length.find((l) => l.game === 'chess')!
    expect(chess.medianMs).toBe(6 * 60_000)
    expect(chess.bins).toHaveLength(8)
    expect(chess.bins[1]).toBe(1)
    expect(chess.bins[4]).toBe(1)
    expect(v.length.find((l) => l.game === 'arena')!.medianMs).toBeNull()
  })
  test('recent matches are newest first with a training label and a page window', () => {
    expect(v.recent.total).toBe(5)
    const labels = v.recent.rows.map((r) => r.result)
    expect(labels).toContain('Human')
    expect(labels).toContain('Draw')
    expect(labels).toContain('Resigned')
    expect(v.recent.rows.find((r) => r.player === 'pl_bbbbbb' && r.game === 'word')!.training).toBe('Stats only')
    expect(v.recent.rows.find((r) => r.result === 'Human')!.training).toBe('Stored')
    expect(v.recent.rows.find((r) => r.result === 'Human')!.report).toBe(`/report/${v.recent.rows.find((r) => r.result === 'Human')!.matchId}`)
    const p2 = view(events, { page: 1 })
    expect(p2.recent.rows).toHaveLength(0)
  })
  test('who played shows ids only, provider, record and best beaten', () => {
    const a = v.whoPlayed.find((p) => p.player === 'pl_aaaaaa')!
    expect(a).toMatchObject({ provider: 'google', isNew: false, matches: 1, wins: 1, losses: 0, bestBeaten: 'Pip', training: 'on' })
    expect(v.whoPlayed.find((p) => p.player === 'pl_bbbbbb')!.training).toBe('opted out')
    expect(v.whoPlayed.find((p) => p.player === 'pl_cccccc')!.provider).toBeNull()
    expect(v.whoPlayed.find((p) => p.player === 'pl_cccccc')).toMatchObject({ wins: 0, losses: 2 })
    const r = view([...ended('match_resigned', { playerRef: 'pl_dddddd' }), ...played('human', { playerRef: 'pl_dddddd' })])
    expect(r.whoPlayed.find((p) => p.player === 'pl_dddddd')).toMatchObject({ wins: 1, losses: 1 })
    expect(JSON.stringify(v)).not.toContain('@')
  })
  test('game and level filters narrow every panel', () => {
    const f = view(events, { game: 'chess', level: 'easy' })
    expect(f.kpis.matches.value).toBe(1)
    expect(f.recent.total).toBe(1)
  })
  test('an empty database gives zeros and no alerts, not NaN', () => {
    const e = view([])
    expect(e.kpis.matches.value).toBe(0)
    expect(e.kpis.aiWin.rate).toBeNull()
    expect(e.kpis.medianMs.value).toBeNull()
    expect(e.alerts).toEqual([])
    expect(e.empty).toBe(true)
    expect(JSON.stringify(e)).not.toContain('null,null,NaN')
  })
})
