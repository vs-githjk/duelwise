import { describe, expect, test } from 'bun:test'
import { replay } from '@duelwise/core/src/replay'
import { decodeRecord, encodeRecord } from '@duelwise/core/src/match-record'
import { getCore } from '@duelwise/core/src/games/index'
import { wordCore } from '@duelwise/core/src/games/word/core'
import { buildReportBody } from './build'
import { MATERIAL } from './chess'
import { publicBody, reportTiles } from './copy'
import { playRandom, playScript } from './testing'

// 1. f3 e5 2. g4 Qh4#: Black checkmates in two.
const FOOLS = ['f2f3', 'e7e5', 'g2g4', 'd8h4']
// White hangs the queen on move 3 and resigns after the knight takes it.
const HANGS_QUEEN = ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'h5e5', 'c6e5', 'f1c4', 'f8c5']

describe('chess report', () => {
  test('a record replays through the core and the report reads it', () => {
    const rec = playScript('chess', 1, FOOLS, 1)
    expect(replay(rec).ok).toBe(true)
    const r = buildReportBody(rec)
    expect(r.game).toBe('chess')
    expect(r.outcome).toBe('win')
    expect(r.evaluator).toBe('material')
    expect(r.moves).toBe(2)
    expect(r.series!.points).toHaveLength(4)
    // The mate is the last point of the chart, from Black's (the human's) side: strongly ahead.
    expect(r.series!.points[3]!).toBeGreaterThan(5)
    expect(r.moments.at(-1)!.kind).toBe('end')
    expect(r.moments.at(-1)!.label).toBe('2... Qh4#')
  })

  test('a hung queen is the worst move and names a better one', () => {
    const rec = playScript('chess', 2, HANGS_QUEEN, 0, 'medium', true)
    const r = buildReportBody(rec)
    const worst = r.moments.find((m) => m.kind === 'worst')!
    expect(worst.label).toBe('3. Qxe5+?')
    expect(worst.value).toBe('-8.0')
    expect(worst.text).toMatch(/This cost you 8\.0\./)
    expect(r.series!.marks.some((m) => m.kind === 'worst')).toBe(true)
  })

  test('the reaction line is only made from facts found in the match', () => {
    const lost = buildReportBody(playScript('chess', 3, HANGS_QUEEN, 0, 'medium', true))
    // Human (White) lost: the template needs the worst move and a better one, both present here.
    expect(lost.reaction).toContain('3. Qxe5+?')
    const won = buildReportBody(playScript('chess', 1, FOOLS, 1))
    // "I rated it as holding" speaks for the agent's value net, which a material count is not.
    expect(won.reaction).toBeNull()
    const viaNet = buildReportBody(playScript('chess', 1, FOOLS, 1), { chessEvaluator: { ...MATERIAL, kind: 'value-net' } })
    expect(viaNet.reaction).toContain('2... Qh4#!')
    expect(viaNet.note).toBeNull()
  })
})

describe('four report', () => {
  test('is deterministic and ends with the result', () => {
    const rec = playRandom('four', 5, 0)
    expect(replay(rec).ok).toBe(true)
    const a = buildReportBody(rec)
    const b = buildReportBody(rec)
    expect(a).toEqual(b)
    expect(a.evaluator).toBe('solver')
    expect(a.moments.at(-1)!.kind).toBe('end')
  })

  test('names the decisive drop of a player who threw the game away', () => {
    // Seat 0 (the human) plays column 0 over and over while seat 1 stacks column 3: a blunder-filled loss.
    const rec = playScript('four', 1, [0, 3, 0, 3, 0, 3, 1, 3], 0)
    const r = buildReportBody(rec)
    expect(r.outcome).toBe('loss')
    expect(r.moments.at(-1)!.text).toMatch(/four in a row/i)
  })

  test('a Four report carries the final board and every drop in order', () => {
    const rec = playScript('four', 1, [0, 3, 0, 3, 0, 3, 1, 3], 0)
    const v = buildReportBody(rec).fourView!
    expect(v.drops).toEqual([0, 3, 0, 3, 0, 3, 1, 3].map((c, i) => ({ by: i % 2 === 0 ? 'player' : 'ai', column: c + 1 })))
    expect(v.cells).toHaveLength(6)
    expect(v.cells.every((r) => r.length === 7)).toBe(true)
    const flat = v.cells.flat()
    expect(flat.filter((x) => x === 1)).toHaveLength(4)
    expect(flat.filter((x) => x === 2)).toHaveLength(4)
    // Top row first: the bottom row holds column 1 and column 4 discs.
    expect(v.cells[5]![0]).toBe(1)
    expect(v.cells[5]![3]).toBe(2)
  })

  test('stops solving at the wall-clock cap and says so', () => {
    const rec = playRandom('four', 9, 0)
    // fourReport takes a clock; a clock that jumps past the cap after the first call caps the solver.
    let t = 0
    const clock = () => (t += 10_000)
    const { fourReport } = require('./four') as typeof import('./four')
    const out = fourReport(rec, 'x', clock)
    expect(out.capped).toBe(rec.actions.length > 14)
  })
})

describe('word report', () => {
  test('lists both seats guess by guess and counts the words that still fit', () => {
    let s = wordCore.init(0, { answer: 'crane' })
    expect(s.answer).toBe('crane')
    const rec = playRandom('word', 4, 0)
    const r = buildReportBody(rec)
    expect(r.wordRows!.length).toBe(rec.actions.length)
    expect(r.wordRows!.filter((w) => w.seat === 'player').length).toBe(r.wordRows!.filter((w) => w.seat === 'ai').length)
    expect(r.wordRows![0]!.markers).toHaveLength(5)
    expect(r.moments.at(-1)!.text).toMatch(/The word was [A-Z]{5}\./)
    void s
  })
})

describe('a record from an older core version', () => {
  test('gets the plain result, not a replay with the current answer list', () => {
    const rec = { ...playRandom('word', 4, 0), coreVersion: 'word-1' }
    const r = buildReportBody(rec)
    expect(r.wordRows).toBeNull()
    expect(r.moments.map((m) => m.kind)).toEqual(['end'])
    expect(r.note).toMatch(/older version/)
  })
})

describe("Hold'em has its own report", () => {
  test('no placeholder note, a real move count, and the closing result row', () => {
    const r = buildReportBody(playRandom('holdem', 2, 0))
    expect(r.evaluator).toBe('none')
    expect(r.moves).toBeGreaterThan(0)
    expect(r.note).toBeNull()
    expect(r.moments.at(-1)!.kind).toBe('end')
  })
})

describe('Fleet report', () => {
  const rec = playRandom('fleet', 3, 0)
  const core = getCore('fleet')

  test("a fleet record is not read as a Hold'em hand", () => {
    const r = buildReportBody(rec)
    expect(r.game).toBe('fleet')
    expect(r.evaluator).toBe('none')
    expect(r.moments.map((m) => m.label)).toContain('Shots used')
    expect(r.moments.some((m) => /hand|chip|fold/i.test(m.text))).toBe(false)
    expect(r.moments.at(-1)!.kind).toBe('end')
  })

  test('shots used and ships left match the record', () => {
    const r = buildReportBody(rec)
    const mine = rec.actions.filter((a) => a[1] === 0 && core.decodeAction(a[2] as number).kind === 'shot').length
    const theirs = rec.actions.filter((a) => a[1] === 1 && core.decodeAction(a[2] as number).kind === 'shot').length
    expect(r.moments.find((m) => m.label === 'Shots used')!.text).toBe(`You fired ${mine} shots; Marlow fired ${theirs}.`)
    // The count on the tile, the share card and the report card is shots only, never the five placements.
    expect(r.moves).toBe(mine)
    const left = r.moments.find((m) => m.label === 'Ships left')!
    expect(left.value).toMatch(/^\d of 5$/)
    // Exactly one side lost every ship.
    expect(left.text.includes('0.') || left.text.startsWith('You finished with 0')).toBe(true)
  })

  test('the tile says shots, owner and public', () => {
    const r = buildReportBody(rec)
    expect(reportTiles({ game: 'fleet', mode: 'owner', status: 'ready' }, r)[0]).toMatchObject({ label: 'Your shots', value: String(r.moves) })
    expect(reportTiles({ game: 'fleet', mode: 'public', status: 'ready' }, r)[0]).toMatchObject({ label: 'Shots fired', value: String(r.moves) })
  })

  test('the stored record keeps all five setup actions of both seats, and they decode as ships', () => {
    const stored = decodeRecord(encodeRecord(rec))
    for (const seat of [0, 1]) {
      const placed = stored.actions.filter((a) => a[1] === seat && core.decodeAction(a[2] as number).kind === 'place')
      expect(placed).toHaveLength(5)
      expect(placed.map((a) => a[0])).toEqual([0, 1, 2, 3, 4])
    }
  })

  test('the luck line ends with the verdict and stays under 180 characters', () => {
    for (const seed of [3, 4, 5, 6, 7, 8]) {
      for (const seat of [0, 1] as const) {
        const r = buildReportBody(playRandom('fleet', seed, seat))
        const luck = r.moments.find((m) => m.label === 'Luck')
        if (!luck) continue
        expect(luck.text.length).toBeLessThan(180)
        expect(luck.text).toMatch(/You ran (lucky|unlucky|about even)(, and still lost on the chase)?\.$/)
        expect(luck.publicText!).not.toMatch(/\b(You|Your|you|your)\b/)
      }
    }
  })

  test('the report rebuilds identically and the record replays', () => {
    expect(replay(rec).ok).toBe(true)
    const r1 = buildReportBody(rec)
    const r2 = buildReportBody(rec)
    expect(r1).toEqual(r2)
  })

  test('a public report holds no setup: no coordinates, no ship cells, no first person', () => {
    const body = publicBody(buildReportBody(rec))
    const text = JSON.stringify(body)
    expect(text).not.toMatch(/\b[A-J](10|[1-9])\b/)
    expect(text).not.toMatch(/vertical|"cells?"|ships":/)
    expect(text).not.toMatch(/\b(You|Your|you|your)\b/)
    // The public wording still names the player.
    expect(body.moments.find((m) => m.label === 'Shots used')!.text).toMatch(/^The player fired/)
  })

  test('a resigned match with no shots still reports, with no luck line', () => {
    const r = buildReportBody(playScript('fleet', 9, [], 0, 'medium', true))
    expect(r.moments.map((m) => m.kind)).toEqual(['end'])
  })
})
