import { describe, expect, test } from 'bun:test'
import { addDays, dayKeyIn, resolveZone, shortDateIn, timeIn, zoneLabel } from './owner-zone'

describe('owner zone', () => {
  test('only a zone Intl knows is accepted; everything else is UTC and flagged', () => {
    expect(resolveZone('America/New_York')).toEqual({ zone: 'America/New_York', zoneFallback: false })
    expect(resolveZone('UTC')).toEqual({ zone: 'UTC', zoneFallback: false })
    for (const bad of [undefined, null, '', 'Mars/Base', "UTC'; select 1;--", 'a b', 5, ['UTC'], 'x'.repeat(65)]) expect(resolveZone(bad)).toEqual({ zone: 'UTC', zoneFallback: true })
  })

  test('the day of an instant is the day on the zone clock', () => {
    const t = new Date('2026-11-02T03:30:00.000Z')
    expect(dayKeyIn(t, 'UTC')).toBe('2026-11-02')
    expect(dayKeyIn(t, 'America/New_York')).toBe('2026-11-01')
    expect(dayKeyIn(t, 'Asia/Kolkata')).toBe('2026-11-02')
    expect(dayKeyIn(new Date('2026-11-01T04:00:00.000Z'), 'America/New_York')).toBe('2026-11-01') // midnight EDT
    expect(dayKeyIn(new Date('2026-11-01T03:59:00.000Z'), 'America/New_York')).toBe('2026-10-31')
  })

  test('stepping days is calendar arithmetic across month ends, leap days and the fall-back day', () => {
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(Array.from({ length: 4 }, (_, i) => addDays('2026-11-01', i - 2))).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
  })

  test('times and dates are on the zone clock, with 24 hour midnight', () => {
    expect(timeIn('2026-11-02T05:05:00.000Z', 'America/New_York')).toBe('00:05')
    expect(timeIn('2026-11-02T05:05:00.000Z', 'UTC')).toBe('05:05')
    expect(timeIn('nonsense', 'UTC')).toBe('')
    expect(shortDateIn('2026-11-02T03:30:00.000Z', 'America/New_York')).toBe('Nov 1')
    expect(shortDateIn('2026-11-02T03:30:00.000Z', 'UTC')).toBe('Nov 2')
  })

  test('the label names the zone in plain words and follows daylight saving', () => {
    expect(zoneLabel('America/New_York', new Date('2026-11-01T12:00:00.000Z'))).toBe('Eastern Time (EST)')
    expect(zoneLabel('America/New_York', new Date('2026-10-30T12:00:00.000Z'))).toBe('Eastern Time (EDT)')
    expect(zoneLabel('America/Los_Angeles', new Date('2026-11-01T12:00:00.000Z'))).toBe('Pacific Time (PST)')
    expect(zoneLabel('UTC')).toBe('UTC')
  })
})
