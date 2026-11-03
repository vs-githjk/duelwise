import { describe, expect, test } from 'bun:test'
import { NotBuiltError, getCore } from './index'
import type { GameId } from '../product'

describe('per-game core stubs', () => {
  const owners: Record<GameId, RegExp> = {
    chess: /Lane A/,
    four: /Lane A/,
    holdem: /Lane A/,
    word: /Lane B/,
    fighter: /Lane C/,
    arena: /Lane C/,
    fleet: /Fleet lane/,
  }
  for (const id of Object.keys(owners) as GameId[]) {
    test(`getCore(${id}) is either built or throws NotBuiltError naming the owning lane`, () => {
      try {
        const core = getCore(id)
        expect(core.id).toBe(id)
      } catch (e) {
        expect(e).toBeInstanceOf(NotBuiltError)
        expect((e as NotBuiltError).message).toMatch(owners[id])
        expect((e as NotBuiltError).message).toContain(id)
        expect((e as NotBuiltError).game).toBe(id)
      }
    })
  }
})
