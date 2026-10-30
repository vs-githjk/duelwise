import { describe, expect, test } from 'bun:test'
import { offlineTally, recordOffline, tallyLine, type TallyStore } from './offline-record'

function store(): TallyStore { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) } }
const win = { winner: 0 as const, score: [1, 0] as [number, number], reason: 'x' }
const loss = { winner: 1 as const, score: [0, 1] as [number, number], reason: 'x' }
const draw = { winner: null, score: [0, 0] as [number, number], reason: 'x' }

describe('offline record', () => {
  test('tallies wins, losses and draws per game on this device only', () => {
    const s = store()
    recordOffline('word', win, 0, s)
    recordOffline('word', loss, 0, s)
    recordOffline('word', loss, 0, s)
    recordOffline('word', draw, 0, s)
    recordOffline('four', win, 1, s)
    expect(offlineTally('word', s)).toEqual({ wins: 1, losses: 2, draws: 1 })
    expect(offlineTally('four', s)).toEqual({ wins: 0, losses: 1, draws: 0 })
    expect(tallyLine(offlineTally('word', s))).toBe('Your offline record on this device: 1 win, 2 losses, 1 draw.')
  })

  test('survives missing or broken storage', () => {
    expect(offlineTally('word', undefined)).toEqual({ wins: 0, losses: 0, draws: 0 })
    const broken: TallyStore = { getItem: () => '{not json', setItem: () => { throw new Error('full') } }
    expect(() => recordOffline('word', win, 0, broken)).not.toThrow()
  })
})
