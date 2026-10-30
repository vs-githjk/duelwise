import { expect, test } from 'bun:test'
import { M } from '@duelwise/core/src/games/fighter/moves'
import { moveListRows } from './moveList'
import { MOVE_INPUT } from './moveInputs'

test('the move list includes Throw, Deflect and Rush with notes, and no hit data for the two that do not hit', () => {
  const rows = moveListRows()
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of [M.THROW, M.DEFLECT, M.RUSH]) {
    const r = byId.get(id)
    expect(r, `move ${id} is missing`).toBeDefined()
    expect(r!.note).toBeTruthy()
    expect(MOVE_INPUT[id]).toBeDefined()
  }
  expect(byId.get(M.DEFLECT)!.damage).toBeNull()
  expect(byId.get(M.RUSH)!.onHit).toBeNull()
  // Every real attack is still there with numbers.
  expect(byId.get(M.STAND_L)!.damage).toBeGreaterThan(0)
  expect(rows.every((r) => r.startup >= 0 && r.recovery >= 0)).toBe(true)
  expect(rows.every((r) => MOVE_INPUT[r.id] !== undefined)).toBe(true)
})
