import { describe, expect, test } from 'bun:test'
import { replay } from '@duelwise/core/src/replay'
import { decodeRecord, encodeRecord } from '@duelwise/core/src/match-record'
import { getCore } from '@duelwise/core/src/games/index'
import { wordCore } from '@duelwise/core/src/games/word/core'
import { buildReportBody } from './build'
import { MATERIAL } from './chess'
import { publicBody, reportTiles } from './copy'
import { playPairs, playRandom, playScript } from './testing'
import { habitSentence } from './penalty'
import { humanActionCount } from './walk'

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

describe('Crosscurrent report', () => {
  const CORNERS = [0, 7, 56, 63]
  const rec = playRandom('slack', 3, 0)
  const core = getCore('slack')
  /** Independent replay: every placement with who played it, the discs it flipped and the disc lead (human minus opponent) after it. */
  function facts(r: typeof rec) {
    let s = core.init(r.seed)
    const out: Array<{ seat: number; cell: number; flips: number; lead: number }> = []
    let passes = [0, 0]
    for (const [, seat, n] of r.actions) {
      const code = n as number
      const before = (s as { cells: number[] }).cells
      s = core.step(s, (seat === 0 ? [code, null] : [null, code]) as never)
      if (code === 64) { passes[seat]!++; continue }
      const cells = (s as { cells: number[] }).cells
      const flips = cells.filter((v, i) => v !== before[i] && before[i] !== 0).length
      const mine = cells.filter((v) => v === r.humanSeat + 1).length
      const theirs = cells.filter((v) => v === 2 - r.humanSeat).length
      out.push({ seat, cell: code, flips, lead: mine - theirs })
    }
    return { out, passes }
  }

  test('is its own report, not a Hold\'em hand and not a bare result', () => {
    const r = buildReportBody(rec)
    expect(r.game).toBe('slack')
    expect(r.evaluator).toBe('none')
    expect(r.moments.length).toBeGreaterThan(1)
    expect(r.moments.at(-1)!.kind).toBe('end')
    expect(r.moments.at(-1)!.text).toMatch(/discs/)
    expect(r.moments.some((m) => /hand|chip|fold|ship|column/i.test(m.text))).toBe(false)
    expect(r.series).not.toBeNull()
    expect(r.slackView).toBeTruthy()
  })

  test('the chart has one point per disc placed (passes are not moves) and ends at the final disc lead', () => {
    const r = buildReportBody(rec)
    const f = facts(rec)
    expect(r.series!.points).toEqual(f.out.map((x) => x.lead))
    expect(r.moves).toBe(f.out.filter((x) => x.seat === rec.humanSeat).length)
    expect(humanActionCount(rec)).toBe(r.moves)
    expect(r.series!.unit).toMatch(/disc/)
  })

  test('chart marks sit on the move they name', () => {
    const r = buildReportBody(rec)
    const f = facts(rec)
    for (const m of r.series!.marks) {
      expect(m.at).toBeGreaterThanOrEqual(0)
      expect(m.at).toBeLessThan(f.out.length)
    }
    const labels = r.series!.marks.map((m) => m.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  test('the corner line counts each side\'s corner placements and nothing else', () => {
    for (const seed of [3, 4, 5, 6, 7, 8, 9, 10]) {
      for (const seat of [0, 1] as const) {
        const rr = playRandom('slack', seed, seat)
        const f = facts(rr)
        const mine = f.out.filter((x) => x.seat === seat && CORNERS.includes(x.cell)).length
        const theirs = f.out.filter((x) => x.seat !== seat && CORNERS.includes(x.cell)).length
        const line = buildReportBody(rr).moments.find((m) => m.label === 'Corners')
        if (mine + theirs === 0) expect(line).toBeUndefined()
        else {
          expect(line!.text).toContain(`You took ${mine === 1 ? '1 corner' : `${mine} corners`}`)
          expect(line!.text).toContain(`Marlow took ${theirs}`)
        }
      }
    }
  })

  test('the biggest turn of each side matches the flips in the record', () => {
    const r = buildReportBody(rec)
    const f = facts(rec)
    const mineBest = Math.max(0, ...f.out.filter((x) => x.seat === rec.humanSeat).map((x) => x.flips))
    const best = r.moments.find((m) => m.tag === 'biggest turn')
    if (mineBest >= 3) expect(best!.value).toBe(`+${mineBest}`)
    else expect(best).toBeUndefined()
    const theirBest = Math.max(0, ...f.out.filter((x) => x.seat !== rec.humanSeat).map((x) => x.flips))
    const worst = r.moments.find((m) => m.tag === "Marlow's biggest turn")
    if (theirBest >= 3) expect(worst!.value).toBe(`+${theirBest}`)
    else expect(worst).toBeUndefined()
  })

  test('the "lead changed for good" line names a placement after which the leader led and kept leading to the end', () => {
    let named = 0
    for (const seed of [44, ...Array.from({ length: 150 }, (_, i) => i + 1)]) {
      const rr = playRandom('slack', seed, 0)
      const f = facts(rr)
      const m = buildReportBody(rr).moments.find((x) => x.tag === 'the lead changed for good')
      if (!m) continue
      named++
      const n = Number(/Placement (\d+)/.exec(m.label)![1]) - 1
      const final = Math.sign(f.out.at(-1)!.lead)
      expect(final).not.toBe(0)
      for (const x of f.out.slice(n)) expect(Math.sign(x.lead)).toBe(final)
      expect(Math.sign(f.out[n - 1]?.lead ?? 0)).not.toBe(final)
    }
    expect(named).toBeGreaterThan(20)
  })

  test('the passes line matches the record', () => {
    for (const seed of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const rr = playRandom('slack', seed, 0)
      const f = facts(rr)
      const line = buildReportBody(rr).moments.find((m) => m.label === 'Passes')
      if (f.passes[0] + f.passes[1] === 0) expect(line).toBeUndefined()
      else expect(line!.text).toContain(`You passed ${f.passes[0]}`)
    }
  })

  test('the final board counts add up to the final discs on the tile', () => {
    const r = buildReportBody(rec)
    const v = r.slackView!
    expect(v.cells).toHaveLength(64)
    expect(v.cells.filter((c) => c === 1).length).toBe(v.discs[0])
    expect(v.cells.filter((c) => c === 2).length).toBe(v.discs[1])
    const tile = reportTiles({ game: 'slack', mode: 'owner', status: 'ready', level: 'medium' }, r).find((t) => t.label === 'Final discs')!
    expect(tile.value).toBe(`${v.discs[0]} to ${v.discs[1]}`)
    expect(reportTiles({ game: 'slack', mode: 'owner', status: 'ready', level: 'medium' }, r)[0]).toMatchObject({ label: 'Your moves', value: String(r.moves) })
  })

  test('the public view says "the player", never "you", and rebuilds identically', () => {
    const r = buildReportBody(rec)
    expect(buildReportBody(rec)).toEqual(r)
    expect(replay(rec).ok).toBe(true)
    const pub = publicBody(r)
    expect(JSON.stringify({ moments: pub.moments, series: pub.series, reason: pub.reason })).not.toMatch(/\b(You|Your|you|your)\b/)
  })

  test('a resigned match reports without inventing moments', () => {
    const r = buildReportBody(playScript('slack', 9, [19, 18], 0, 'medium', true))
    expect(r.moments.at(-1)!.kind).toBe('end')
    expect(r.moments.map((m) => m.kind)).toEqual(['end'])
    expect(r.slackView ?? null).toBeNull()
    expect(r.series).toBeNull()
  })

  test('a record from an older core version gives the result only', () => {
    const r = buildReportBody({ ...rec, coreVersion: 'old' })
    expect(r.moments.map((m) => m.kind)).toEqual(['end'])
  })

  test('the closing note says what the chart counts', () => {
    expect(buildReportBody(rec).note).toMatch(/discs/i)
  })
})

describe('Twelve Yards report', () => {
  const core = getCore('penalty')
  /** The player's picks and the keeper's, one pair per tick: seat 0 kicks on even ticks. `mine` is used for the player's own seat, whichever it is. */
  function pairs(human: 0 | 1, shots: number[], dives: number[], theirShots: number[], theirDives: number[], ticks = 40): Array<[number, number]> {
    const out: Array<[number, number]> = []
    let a = 0
    let b = 0
    let c = 0
    let d = 0
    for (let t = 0; t < ticks; t++) {
      const humanShoots = t % 2 === human
      const mine = humanShoots ? shots[a++ % shots.length]! : dives[b++ % dives.length]!
      const theirs = humanShoots ? theirDives[c++ % theirDives.length]! : theirShots[d++ % theirShots.length]!
      out.push(human === 0 ? [mine, theirs] : [theirs, mine])
    }
    return out
  }
  /** Independent replay of the record: each kick with its roll's outcome, read straight from the core. */
  function kicksOf(r: ReturnType<typeof playPairs>) {
    let s = core.init(r.seed) as { kicks: Array<{ kicker: number; zone: number; dive: number; goal: boolean; onTarget: boolean }> }
    for (let t = 0; !core.terminal(s as never); t++) {
      const cur: [number | null, number | null] = [null, null]
      for (const [tick, seat, n] of r.actions) if (tick === t) cur[seat as 0 | 1] = n
      s = core.step(s as never, cur as never) as typeof s
    }
    return s.kicks
  }
  const rec = playPairs('penalty', 5, pairs(0, [6, 6, 2, 6, 8], [0, 1, 2], [0, 8, 2, 6], [2, 0, 3]), 0)

  test('is its own report: a kick map, real counts and the closing row, nothing from another game', () => {
    const r = buildReportBody(rec)
    expect(r.game).toBe('penalty')
    expect(r.penaltyView).toBeTruthy()
    expect(r.moments.at(-1)!.kind).toBe('end')
    expect(r.moments.at(-1)!.text).toContain(r.reason)
    expect(r.moments.some((m) => /hand|chip|fold|disc|column|guess/i.test(m.text))).toBe(false)
    expect(r.series).toBeNull()
    expect(r.evaluator).toBe('none')
  })

  test('the map is the shootout as the core played it: every kick, its spot, the dive and the outcome, and the goals add up to the result', () => {
    const r = buildReportBody(rec)
    const ks = kicksOf(rec)
    const v = r.penaltyView!
    expect(v.kicks).toHaveLength(ks.length)
    ks.forEach((k, i) => {
      const row = v.kicks[i]!
      expect(row.n).toBe(i + 1)
      expect(row.zone).toBe(k.zone)
      expect(row.dive).toBe(k.dive)
      expect(row.byMe).toBe(k.kicker === rec.humanSeat)
      expect(row.outcome === 'goal').toBe(k.goal)
      expect(row.outcome === 'saved').toBe(k.onTarget && !k.goal)
      expect(row.outcome === 'over' || row.outcome === 'wide').toBe(!k.onTarget)
    })
    expect(v.goals).toEqual([rec.result.score[rec.humanSeat], rec.result.score[1 - rec.humanSeat]])
  })

  test('the player\'s kick count is the kicks they took, from either seat; dives are not kicks', () => {
    for (const human of [0, 1] as const) {
      const rr = playPairs('penalty', 5, pairs(human, [6, 6, 2, 6, 8], [0, 1, 2], [0, 8, 2, 6], [2, 0, 3]), human)
      const r = buildReportBody(rr)
      const took = kicksOf(rr).filter((k) => k.kicker === human).length
      expect(r.moves).toBe(took)
      expect(humanActionCount(rr)).toBe(took)
      expect(r.penaltyView!.kicks.filter((k) => k.byMe)).toHaveLength(took)
      expect(r.penaltyView!.youFirst).toBe(human === 0)
    }
  })

  test('a habit is only named when it repeated, in the player\'s own kicks', () => {
    expect(habitSentence([6, 6, 2, 6, 8])!.text).toBe('You went bottom left 3 of 5 times.')
    expect(habitSentence([6, 6, 6])!.text).toBe('You went bottom left every time, 3 of 3.')
    expect(habitSentence([4, 4, 4, 4, 4])!.text).toContain('down the middle every time, 5 of 5')
    expect(habitSentence([0, 3, 6, 1, 8])!.text).toBe('You aimed on the left of the goal 3 of 5 times, at 3 spots.')
    expect(habitSentence([6, 7, 8, 0, 4])!.text).toBe('You aimed low 3 of 5 times.')
    expect(habitSentence([0, 2, 7, 4, 3])!.text).toBe('No habit showed: your 5 kicks went to 5 different spots.')
    expect(habitSentence([6, 6])).toBeNull()
    expect(habitSentence([6, 6, 2], false)!.text).toBe('No habit showed: the player\'s 3 kicks went to 2 different spots.')
    expect(habitSentence([6, 6, 6, 6, 6], false)!.text).toBe('The player went bottom left every time, 5 of 5.')
    // The report shows the same sentence for the kicks the record holds.
    const mine = kicksOf(rec).filter((k) => k.kicker === rec.humanSeat).map((k) => k.zone)
    expect(buildReportBody(rec).moments.find((m) => m.label === 'Kick habit')!.text).toBe(habitSentence(mine)!.text)
  })

  test('the keeper line counts the dives that went the player\'s way, from the record', () => {
    const r = buildReportBody(rec)
    const mine = kicksOf(rec).filter((k) => k.kicker === rec.humanSeat)
    const side = (d: number) => (d === 2 ? 1 : d < 2 ? 0 : 2)
    const read = mine.filter((k) => side(k.dive) === k.zone % 3).length
    const m = r.moments.find((x) => x.tag === 'who guessed the side')!
    expect(m.text).toContain(`on ${read} of your ${mine.length} kicks`)
  })

  test('the owner\'s lines say you, and the public lines say the player and never you', () => {
    const r = buildReportBody(rec)
    const pub = publicBody(r)
    expect(r.moments.some((m) => /\byou\b/i.test(m.text))).toBe(true)
    for (const m of pub.moments) expect(m.text).not.toMatch(/\byou(r|rs)?\b/i)
    expect(pub.reason).not.toMatch(/\byou\b/i)
  })

  test('a shootout that reached sudden death says so and names the round it ended in', () => {
    let sudden: ReturnType<typeof playPairs> | null = null
    for (let seed = 1; seed < 400 && !sudden; seed++) {
      try {
        const rr = playPairs('penalty', seed, pairs(0, [0, 1, 2, 3, 4, 5, 6, 7, 8], [0, 1, 2, 3, 4], [8, 7, 6, 5, 4], [2, 1, 0]), 0)
        if (kicksOf(rr).length > 10) sudden = rr
      } catch {
        // this seed did not finish inside the picks given
      }
    }
    expect(sudden).not.toBeNull()
    const r = buildReportBody(sudden!)
    expect(r.penaltyView!.sudden).toBe(true)
    const m = r.moments.find((x) => x.tag === 'sudden death')!
    expect(m.text).toContain(`round ${r.penaltyView!.kicks.at(-1)!.round}`)
    expect(r.penaltyView!.kicks.some((k) => k.sudden)).toBe(true)
    expect(r.penaltyView!.kicks.filter((k) => !k.sudden)).toHaveLength(10)
  })

  test('a resigned match reports the result alone, and a record from an older core gets the plain result', () => {
    const cut = { ...rec, actions: rec.actions.slice(0, 6), result: { winner: 1 as const, score: [0, 1] as [number, number], reason: 'resigned' } }
    const r = buildReportBody(cut)
    expect(r.penaltyView).toBeNull()
    expect(r.moments.map((m) => m.kind)).toEqual(['end'])
    const old = buildReportBody({ ...rec, coreVersion: 'penalty-1' })
    expect(old.penaltyView ?? null).toBeNull()
    expect(old.note).toMatch(/older version/)
  })

  test('no em or en dash anywhere in the words the report writes', () => {
    const r = buildReportBody(rec)
    const all = [...r.moments.flatMap((m) => [m.label, m.tag, m.text, m.publicText ?? '']), r.note ?? '', r.reason]
    for (const t of all) expect(t).not.toMatch(/[–—]/)
  })
})
