import { expect, test } from 'bun:test'
import { dayLabel, localDays } from './local-days'

const NOW = new Date('2026-10-22T04:30:00.000Z') // 21:30 PDT on the 21st

test('a match at 21:20 PDT lands on the local 21st, not the UTC 22nd', () => {
  const d = localDays(['2026-10-22T04:20:00.000Z'], NOW, -420)
  expect(d[6]).toEqual({ day: '2026-10-21', matches: 1 })
  expect(d.map((x) => x.day)[0]).toBe('2026-10-15')
})

test('UTC viewer sees the UTC day', () => {
  expect(localDays(['2026-10-22T04:20:00.000Z'], NOW, 0)[6]).toEqual({ day: '2026-10-22', matches: 1 })
})

test('the day label carries the month', () => {
  expect(dayLabel('2026-10-21')).toBe('Oct 21')
  expect(dayLabel('2026-11-01')).toBe('Nov 1')
  expect(dayLabel('nope')).toBe('')
})
