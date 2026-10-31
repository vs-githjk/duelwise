import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { createStartsCore } from './four-gate'

const dir = mkdtempSync(join(tmpdir(), 'four-gate-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function startsFile(positions: number[][]): string {
  const f = join(dir, `starts-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(f, JSON.stringify({ game: 'four', positions }))
  return f
}

describe('four-gate holdout starts', () => {
  test('a game starts from the position people reached, and a seed pair shares it', () => {
    process.env.FOUR_GATE_STARTS = startsFile([[3, 3, 2, 4], [0, 1]])
    const core = createStartsCore()
    const a = core.init(0, undefined)
    const b = core.init(1, undefined)
    expect(core.hash(a)).toBe(core.hash(b))
    let expected = fourCore.init(0, undefined)
    for (const col of [3, 3, 2, 4]) {
      const seat = fourCore.toAct(expected)[0]!
      expected = fourCore.step(expected, seat === 0 ? [col as never, null] : [null, col as never])
    }
    expect(core.hash(a)).toBe(fourCore.hash(expected))
    // seeds 2 and 3 use the second position
    expect(core.hash(core.init(2, undefined))).not.toBe(core.hash(a))
    // and the positions repeat once they run out
    expect(core.hash(core.init(4, undefined))).toBe(core.hash(a))
  })

  test('a position that is not legal, an empty file or a missing variable is an error, not a silent plain game', () => {
    process.env.FOUR_GATE_STARTS = startsFile([[9]])
    expect(() => createStartsCore().init(0, undefined)).toThrow()
    process.env.FOUR_GATE_STARTS = startsFile([])
    expect(() => createStartsCore()).toThrow()
    delete process.env.FOUR_GATE_STARTS
    expect(() => createStartsCore()).toThrow()
  })
})
