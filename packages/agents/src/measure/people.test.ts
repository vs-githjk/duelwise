import { describe, expect, test } from 'bun:test'
import { MeasuredSchema, PeopleSchema } from '../registry'
import {
  PANEL_WEIGHTS,
  PEOPLE_BANDS,
  REAL_MIN_MATCHES,
  REAL_MIN_PLAYERS,
  calibrationFromPairs,
  checkPeopleBlock,
  estimatePeople,
  withGameCeiling,
  parseBaselineCsv,
  realScore,
  shrinkGap,
  type ProxyScore,
} from './people'

const ps = (value: number, half = 0.03, n = 400): ProxyScore => ({ value, ci95: [Math.max(0, value - half), Math.min(1, value + half)], n })
const panel = (b: number, a: number, s: number) => ({ beginner: ps(b), average: ps(a), strong: ps(s) })
const PROXIES = { beginner: 'b', average: 'a', strong: 's' }

describe('constants', () => {
  test('weights sum to 1 and follow D2 (30 / 50 / 20)', () => {
    expect(PANEL_WEIGHTS.beginner + PANEL_WEIGHTS.average + PANEL_WEIGHTS.strong).toBeCloseTo(1, 12)
    expect(PANEL_WEIGHTS).toEqual({ beginner: 0.3, average: 0.5, strong: 0.2 })
  })
  test('bands follow D1 and do not overlap', () => {
    expect(PEOPLE_BANDS.easy).toEqual({ low: 0.42, high: 0.58 })
    expect(PEOPLE_BANDS.medium).toEqual({ low: 0.65, high: 0.75 })
    expect(PEOPLE_BANDS.hard).toEqual({ low: 0.8, high: 0.9 })
    expect(PEOPLE_BANDS.champion).toEqual({ low: 0.93, high: 1 })
  })
})

describe('estimatePeople', () => {
  test('a 0.6 / 0.75 / 0.9 panel weights to 0.735: in band for medium, below for hard', () => {
    const med = estimatePeople(panel(0.6, 0.75, 0.9), null, 0, 'medium', { proxies: PROXIES })
    expect(med.estimate).toBeCloseTo(0.735, 10)
    expect(med.verdict).toBe('in-band')
    expect(med.calibrated).toBeCloseTo(0.735, 10)
    expect(med.band).toEqual(PEOPLE_BANDS.medium)
    const hard = estimatePeople(panel(0.6, 0.75, 0.9), null, 0, 'hard', { proxies: PROXIES })
    expect(hard.verdict).toBe('below')
  })
  test('above the band is reported as above', () => {
    expect(estimatePeople(panel(0.9, 0.95, 0.99), null, 0, 'medium', { proxies: PROXIES }).verdict).toBe('above')
  })
  test('the interval is the weighted combination of the panel intervals and contains the estimate', () => {
    const e = estimatePeople(panel(0.6, 0.75, 0.9), null, 0, 'medium', { proxies: PROXIES })
    const se = (h: number) => h / 1.96
    const expected = 1.96 * Math.sqrt((0.3 * se(0.03)) ** 2 + (0.5 * se(0.03)) ** 2 + (0.2 * se(0.03)) ** 2)
    expect(e.ci95[0]).toBeCloseTo(0.735 - expected, 6)
    expect(e.ci95[1]).toBeCloseTo(0.735 + expected, 6)
  })
  test('real data (n 40, 10 players) whose interval sits outside the band overrides the estimate', () => {
    const real = realScore(10, 40, 10, '2026-11-10') // 25% against a Marlow band of 65 to 75
    expect(real.ci95[1]).toBeLessThan(0.65)
    const e = estimatePeople(panel(0.6, 0.75, 0.9), real, 0, 'medium', { proxies: PROXIES })
    expect(e.verdict).toBe('below')
    expect(e.calibrated).toBeCloseTo(0.25, 10)
    expect(e.real?.n).toBe(40)
    expect(e.estimate).toBeCloseTo(0.735, 10) // the panel number is kept, never rewritten
  })
  test('real data whose interval still overlaps the band does not override', () => {
    const real = realScore(28, 40, 10, '2026-11-10') // 70%, interval wide around the band
    const e = estimatePeople(panel(0.6, 0.75, 0.9), real, 0, 'medium', { proxies: PROXIES })
    expect(e.verdict).toBe('in-band')
    expect(e.calibrated).toBeCloseTo(0.735, 10)
  })
  test('real data under the minimum is ignored (too few matches, or too few players)', () => {
    for (const real of [realScore(5, 39, 10, '2026-11-10'), realScore(5, 40, 9, '2026-11-10')]) {
      expect(REAL_MIN_MATCHES).toBe(40)
      expect(REAL_MIN_PLAYERS).toBe(10)
      const e = estimatePeople(panel(0.6, 0.75, 0.9), real, 0, 'medium', { proxies: PROXIES })
      expect(e.verdict).toBe('in-band')
      expect(e.calibrated).toBeCloseTo(0.735, 10)
    }
  })
  test('a calibration gap moves the calibrated number, clamped to 0 and 1, and can change the verdict', () => {
    expect(estimatePeople(panel(0.6, 0.75, 0.9), null, -0.1, 'medium', { proxies: PROXIES }).verdict).toBe('below')
    expect(estimatePeople(panel(0.9, 0.95, 0.99), null, 0.2, 'champion', { proxies: PROXIES }).calibrated).toBe(1)
  })
  test('a ceiling verdict requires a ceiling block that actually fell short of the band', () => {
    const below = panel(0.5, 0.55, 0.6)
    expect(estimatePeople(below, null, 0, 'champion', { proxies: PROXIES }).verdict).toBe('below')
    const ceiling = { value: 0.6, ci95: [0.55, 0.65] as [number, number], by: 'sims 1600, temperature 0, vs the average proxy' }
    const e = estimatePeople(below, null, 0, 'champion', { proxies: PROXIES, ceiling })
    expect(e.verdict).toBe('ceiling')
    expect(e.ceiling).toEqual(ceiling)
    // a "ceiling" that actually reaches the band is not a ceiling
    expect(() => estimatePeople(below, null, 0, 'champion', { proxies: PROXIES, ceiling: { ...ceiling, value: 0.95, ci95: [0.9, 0.99] } })).toThrow()
    // ceiling on a level that is not below its band is ignored: the verdict stays honest
    const ok = estimatePeople(panel(0.95, 0.96, 0.97), null, 0, 'champion', { proxies: PROXIES, ceiling })
    expect(ok.verdict).toBe('in-band')
    expect(ok.ceiling).toBeUndefined()
  })
  test('a ceiling verdict needs the level to reach the ceiling interval; a level clearly under it is just below its band', () => {
    const far = panel(0.2, 0.3, 0.3)
    const ceiling = { value: 0.6, ci95: [0.57, 0.63] as [number, number], by: 'best settings' }
    const e = estimatePeople(far, null, 0, 'champion', { proxies: PROXIES, ceiling })
    expect(far.average.ci95[1]).toBeLessThan(ceiling.ci95[0])
    expect(e.verdict).toBe('below')
    expect(e.ceiling).toBeUndefined()
    expect(checkPeopleBlock({ ...e, verdict: 'ceiling', ceiling }, 'champion').join(' ')).toContain('does not reach its ceiling')
  })
  test('withGameCeiling swaps in the game best, or drops the ceiling when the level cannot reach it', () => {
    const near = estimatePeople(panel(0.5, 0.55, 0.6), null, 0, 'champion', { proxies: PROXIES, ceiling: { value: 0.58, ci95: [0.5, 0.65], by: 'old' } })
    expect(near.verdict).toBe('ceiling')
    const best = { value: 0.8, ci95: [0.75, 0.85] as [number, number], by: 'best' }
    const lost = withGameCeiling(near, 'champion', best)
    expect(lost.verdict).toBe('below')
    expect(lost.ceiling).toBeUndefined()
    const kept = withGameCeiling(near, 'champion', { value: 0.58, ci95: [0.5, 0.65], by: 'best' })
    expect(kept.verdict).toBe('ceiling')
    expect(kept.ceiling?.by).toBe('old') // the same measurement keeps its own description
    const swapped = withGameCeiling(near, 'champion', { value: 0.62, ci95: [0.55, 0.69], by: 'best' })
    expect(swapped.ceiling?.by).toBe('best')
    // a best that reaches the band is no ceiling; a level in band is untouched
    expect(withGameCeiling(near, 'champion', { value: 0.95, ci95: [0.5, 0.99], by: 'x' }).verdict).toBe('below')
    const ok = estimatePeople(panel(0.95, 0.96, 0.97), null, 0, 'champion', { proxies: PROXIES })
    expect(withGameCeiling(ok, 'champion', best)).toBe(ok)
  })
  test('refuses nonsense: a score outside 0..1', () => {
    expect(() => estimatePeople(panel(1.2, 0.5, 0.5), null, 0, 'easy', { proxies: PROXIES })).toThrow()
  })
})

describe('calibration', () => {
  test('shrinks with small n: zero matches gives zero, more matches approach the full gap, never beyond it', () => {
    expect(shrinkGap(0.2, 0)).toBe(0)
    const small = shrinkGap(0.2, 40)
    const big = shrinkGap(0.2, 4000)
    expect(small).toBeGreaterThan(0)
    expect(small).toBeLessThan(big)
    expect(big).toBeLessThan(0.2)
    expect(big).toBeGreaterThan(0.19)
    expect(shrinkGap(-0.2, 40)).toBeCloseTo(-small, 12)
  })
  test('per-game calibration is the n-weighted real minus panel gap over levels that meet the minimum, shrunk by total n', () => {
    const ok = realScore(20, 50, 12, '2026-11-10') // 0.40
    const tiny = realScore(1, 10, 3, '2026-11-10') // ignored
    const cal = calibrationFromPairs([
      { real: ok, panelEstimate: 0.5 },
      { real: tiny, panelEstimate: 0.9 },
    ])
    expect(cal).toBeCloseTo(shrinkGap(0.4 - 0.5, 50), 10)
    expect(calibrationFromPairs([{ real: tiny, panelEstimate: 0.9 }])).toBe(0)
    expect(calibrationFromPairs([])).toBe(0)
  })
})

describe('baseline CSV', () => {
  const header = 'game,level,matches,players,ai_points,as_of'
  test('parses rows into RealScore keyed by game and level, with a Wilson interval', () => {
    const m = parseBaselineCsv([header, 'chess,medium,60,15,42,2026-11-10', 'four,hard,41,10,35.5,2026-11-10', ''].join('\n'))
    const c = m.get('chess/medium')!
    expect(c).toMatchObject({ n: 60, players: 15, asOf: '2026-11-10' })
    expect(c.value).toBeCloseTo(0.7, 10)
    expect(c.ci95[0]).toBeLessThan(0.7)
    expect(c.ci95[1]).toBeGreaterThan(0.7)
    expect(m.get('four/hard')!.value).toBeCloseTo(35.5 / 41, 10)
    expect(m.size).toBe(2)
  })
  test('refuses a row without a date, a bad header, a bad number, a duplicate key and impossible points', () => {
    expect(() => parseBaselineCsv([header, 'chess,medium,60,15,42,'].join('\n'))).toThrow(/date/)
    expect(() => parseBaselineCsv('game,level\nchess,medium')).toThrow(/header/)
    expect(() => parseBaselineCsv([header, 'chess,medium,x,15,42,2026-11-10'].join('\n'))).toThrow()
    expect(() => parseBaselineCsv([header, 'chess,medium,60,15,42,2026-11-10', 'chess,medium,60,15,42,2026-11-10'].join('\n'))).toThrow(/duplicate/)
    expect(() => parseBaselineCsv([header, 'chess,medium,60,15,61,2026-11-10'].join('\n'))).toThrow()
    expect(() => parseBaselineCsv([header, 'chess,legend,60,15,42,2026-11-10'].join('\n'))).toThrow(/level/)
  })
  test('an empty file (header only) is an empty map', () => {
    expect(parseBaselineCsv(header + '\n').size).toBe(0)
  })
})

describe('registry block', () => {
  const base = {
    metric: 'm', value: 0.7, ci95: [0.6, 0.8] as [number, number], n: 400, opponents: 'o', siteElo: 1200,
    measuredAt: '2026-11-10', harness: 'bun' as const, commit: 'abc',
  }
  test('measured accepts an estimatePeople block and still accepts rows without one', () => {
    const people = estimatePeople(panel(0.6, 0.75, 0.9), null, 0, 'medium', { proxies: PROXIES })
    expect(MeasuredSchema.safeParse({ ...base, people }).success).toBe(true)
    expect(MeasuredSchema.safeParse(base).success).toBe(true)
  })
  test('a people block with an empty test-player description fails the full check (the browser card form of the block carries no descriptions by design)', () => {
    const people = estimatePeople(panel(0.6, 0.75, 0.9), null, 0, 'medium')
    expect(checkPeopleBlock(people, 'medium').some((e) => e.startsWith('proxies.'))).toBe(true)
    expect(PeopleSchema.safeParse(people).success).toBe(false)
  })
  test('checkPeopleBlock passes a block the estimator wrote and flags a hand edit', () => {
    const people = estimatePeople(panel(0.6, 0.75, 0.9), null, 0, 'medium', { proxies: PROXIES })
    expect(checkPeopleBlock(people, 'medium')).toEqual([])
    expect(checkPeopleBlock({ ...people, estimate: 0.9 }, 'medium').length).toBeGreaterThan(0)
    expect(checkPeopleBlock({ ...people, verdict: 'above' }, 'medium').length).toBeGreaterThan(0)
    expect(checkPeopleBlock({ ...people, verdict: 'ceiling' }, 'medium').length).toBeGreaterThan(0)
    expect(checkPeopleBlock({ ...people, band: { low: 0.1, high: 0.2 } }, 'medium').length).toBeGreaterThan(0)
  })
})
