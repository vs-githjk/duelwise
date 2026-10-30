import { expect, test } from 'bun:test'
import { EV } from '@duelwise/core/src/games/fighter/state.ts'
import { ANIMATION_MAP } from './animation-map.ts'
import { buildFixture, FIXTURE_FRAMES } from './fixture.ts'

test('the fixture is deterministic and shows real combat', () => {
  const a = buildFixture()
  const b = buildFixture()
  expect(a.length).toBe(FIXTURE_FRAMES + 1)
  expect(JSON.stringify(a[900])).toBe(JSON.stringify(b[900]))
  const moves = new Set<number>()
  let hits = 0
  let blocks = 0
  for (const s of a) for (const f of s.fighters) {
    moves.add(f.moveId)
    if (f.events & EV.HIT_TAKEN) hits++
    if (f.events & EV.BLOCKED) blocks++
  }
  console.log('fixture moves', [...moves].sort((x, y) => x - y).join(','), 'hits', hits, 'blocks', blocks)
  expect(hits).toBeGreaterThan(3)
  expect(moves.size).toBeGreaterThanOrEqual(10)
  for (const id of moves) expect(ANIMATION_MAP[id]).toBeDefined()
})
