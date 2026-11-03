import { expect, test } from 'bun:test'
import lines from '../personas/lines.json'
import { isCloseLoss, sayLine, situationOf, type SaysInput } from './says'

const base: SaysInput = { game: 'word', level: 'medium', result: { winner: 0, score: [1, 0], reason: 'solved first' }, humanSeat: 0, call: null, humanMoves: 3 }

test('every line is short, names no dashes and exists for each persona and situation', () => {
  for (const level of ['easy', 'medium', 'hard', 'champion']) {
    const set = (lines as Record<string, Record<string, string>>)[level]!
    for (const s of ['win', 'loss', 'closeLoss', 'draw', 'callWrong', 'callRight']) expect(set[s]).toBeDefined()
    for (const [k, v] of Object.entries(set)) {
      expect(v.length, `${level}.${k}`).toBeLessThanOrEqual(90)
      expect(/[\u2013\u2014]/.test(v), `${level}.${k} dash`).toBe(false)
    }
  }
})
test('situations: call lines beat result lines, a win above the call is a plain win', () => {
  expect(situationOf(base)).toBe('win')
  expect(situationOf({ ...base, call: 'medium' })).toBe('callRight')
  expect(situationOf({ ...base, call: 'easy' })).toBe('win')
  const lost = { ...base, result: { winner: 1 as const, score: [0, 1] as [number, number], reason: 'solved first' } }
  expect(situationOf({ ...lost, call: 'hard' })).toBe('callWrong')
  expect(situationOf({ ...lost, call: 'easy' })).toBe('loss')
  expect(situationOf({ ...lost, humanMoves: 6 })).toBe('closeLoss')
  expect(situationOf({ ...base, result: { winner: null, score: [0, 0], reason: 'draw' } })).toBe('draw')
})
test('close loss rules per game', () => {
  const r = (a: number, b: number) => ({ winner: 1 as const, score: [a, b] as [number, number], reason: 'rounds' })
  expect(isCloseLoss({ game: 'arena', result: r(6, 7), humanSeat: 0, humanMoves: 0 })).toBe(true)
  expect(isCloseLoss({ game: 'arena', result: r(2, 7), humanSeat: 0, humanMoves: 0 })).toBe(false)
  expect(isCloseLoss({ game: 'chess', result: r(0, 1), humanSeat: 0, humanMoves: 31 })).toBe(true)
  expect(isCloseLoss({ game: 'chess', result: r(0, 1), humanSeat: 0, humanMoves: 12 })).toBe(false)
})
test('the unit and the called name are filled in, the record line needs real numbers', () => {
  const lost = { ...base, game: 'arena' as const, level: 'easy' as const, result: { winner: 1 as const, score: [6, 7] as [number, number], reason: 'rounds' } }
  expect(sayLine(lost).text).toBe('One round short against Pip. That one stings. Run it back.')
  expect(sayLine({ ...base, level: 'champion', result: { winner: 1, score: [0, 1], reason: 'x' } }).text).toBe('Sable took it. Sable usually does. Again?')
  expect(sayLine({ ...base, level: 'champion', result: { winner: 1, score: [0, 1], reason: 'x' }, record: { wins: 400, losses: 12 } }).text).toContain('400 and 12 against people')
  expect(sayLine({ ...base, level: 'medium', call: 'champion', result: { winner: 1, score: [0, 1], reason: 'x' } }).text).toBe('You called Sable. Marlow would like a word first.')
})

test('an uncounted or practice win never promises the next opponent', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    for (const call of [null, level] as (string | null)[]) {
      for (const progress of ['plain', 'practice'] as const) {
        const t = sayLine({ ...base, level: level as SaysInput['level'], call: call as SaysInput['call'], progress }).text
        expect(t, `${level} ${call} ${progress}`).not.toMatch(/up next|is up\b|unlocked|told|notices|bites|Sable has/i)
      }
    }
  }
  expect(sayLine({ ...base, level: 'easy', progress: 'plain' }).text).toBe('Clean win over Pip. Well done.')
  expect(sayLine({ ...base, level: 'easy', progress: 'practice' }).text).toBe('Clean win over Pip. Win it again in a rated match to open Marlow.')
  expect(sayLine({ ...base, level: 'easy', progress: 'counted' }).text).toContain('Marlow is up next')
  expect(sayLine({ ...base, level: 'easy' }).text).toContain('Marlow is up next')
})

test('Stormglass: a loss one shot short of sinking the last ship is a close match, and nothing else is', () => {
  const lost = { winner: 1 as const, score: [0, 1] as [number, number], reason: 'fleet sunk' }
  const at = (shortBy?: number) => isCloseLoss({ game: 'fleet', result: lost, humanSeat: 0, humanMoves: 60, ...(shortBy === undefined ? {} : { shortBy }) })
  expect(at(1)).toBe(true)
  expect(at(2)).toBe(false)
  expect(at(0)).toBe(false)
  expect(at()).toBe(false)
  expect(sayLine({ ...base, game: 'fleet', level: 'easy', result: lost, shortBy: 1 }).text).toBe('One shot short against Pip. That one stings. Run it back.')
})
