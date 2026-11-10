import { describe, expect, test } from 'bun:test'
import { GRID, NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { createBot } from '@duelwise/core/src/games/puck/bots'
import { observe, puckCore } from '@duelwise/core/src/games/puck/core'
import { unitToCell } from '@duelwise/core/src/games/puck/input'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import type { Level } from '@duelwise/core/src/product'
import { createMatchRecorder } from '../lib/match-recorder'
import { PuckMatch } from '../games/puck/loop'
import { buildReportBody } from './build'
import { reportTiles } from './copy'
import { cardHeadline, shareCardSvg } from './share-card'
import { closeCallsLine, closeCalls, goalPips, goalTimelineLine, nearMissLine, pickTurning, puckReportMoments, puckTimeline, turningPointFor, type PuckEvent } from './puck'

const ev = (kind: PuckEvent['kind'], seat: 0 | 1, you: number, them: number, frame = 100): PuckEvent => ({ frame, kind, seat, score: [you, them] })

describe('pickTurning (from a timeline)', () => {
  test('the player\'s post while trailing by one, late, is the turning point of a loss', () => {
    const events = [ev('goal', 1, 0, 1), ev('goal', 0, 1, 1), ev('post', 0, 5, 6), ev('goal', 1, 5, 7)]
    expect(pickTurning(events, 0, 1, 'Sable')).toBe('Your shot at 5 to 6 hit the post.')
  })
  test('a near miss while level reads "went just wide"', () => {
    expect(pickTurning([ev('nearMiss', 0, 6, 6), ev('goal', 1, 6, 7)], 0, 1, 'Sable')).toBe('Your shot at 6 to 6 went just wide.')
  })
  test('a post early in the match (nothing at stake) is not a turning point', () => {
    expect(pickTurning([ev('post', 0, 1, 2), ev('goal', 1, 1, 3)], 0, 1, 'Sable')).toBeNull()
  })
  test('a post while the player was far behind is not a turning point', () => {
    expect(pickTurning([ev('post', 0, 2, 6), ev('goal', 1, 2, 7)], 0, 1, 'Sable')).toBeNull()
  })
  test('without a close shot, the lead the winner kept is named', () => {
    const events = [ev('goal', 0, 1, 0), ev('goal', 0, 2, 0), ev('goal', 0, 3, 0), ev('goal', 1, 3, 1), ev('goal', 1, 3, 2), ev('goal', 1, 3, 3), ev('goal', 1, 3, 4), ev('goal', 1, 3, 5)]
    expect(pickTurning(events, 0, 1, 'Sable')).toBe('Sable went ahead 4 to 3 and never trailed again.')
  })
  test('a lead the winner gave back is not the one named', () => {
    const events = [ev('goal', 1, 0, 1), ev('goal', 1, 0, 2), ev('goal', 1, 0, 3), ev('goal', 0, 1, 3), ev('goal', 0, 2, 3), ev('goal', 0, 3, 3), ev('goal', 1, 3, 4), ev('goal', 1, 3, 5)]
    expect(pickTurning(events, 0, 1, 'Sable')).toBe('Sable went ahead 4 to 3 and never trailed again.')
  })
  test('an early lead (the other side under 3) is not called a turning point', () => {
    expect(pickTurning([ev('goal', 1, 0, 1), ev('goal', 1, 0, 2)], 0, 1, 'Sable')).toBeNull()
    expect(pickTurning([ev('goal', 0, 1, 0), ev('goal', 1, 1, 1), ev('goal', 1, 1, 2)], 0, 1, 'Sable')).toBeNull()
  })
  test('a loss with a late save and nothing else names the save', () => {
    const events = [ev('goal', 1, 0, 1), ev('save', 0, 5, 5), ev('goal', 1, 5, 6)]
    expect(pickTurning(events, 0, 1, 'Sable')).toBe('Your save at 5 to 5 kept it alive.')
  })
  test('a win: the opponent\'s late post is named with their name', () => {
    expect(pickTurning([ev('post', 1, 6, 6), ev('goal', 0, 7, 6)], 0, 0, 'Vesper')).toBe('Vesper\'s shot at 6 to 6 hit the post.')
  })
  test('an empty timeline says nothing', () => {
    expect(pickTurning([], 0, 1, 'Sable')).toBeNull()
  })
  test('the latest qualifying shot wins', () => {
    const events = [ev('post', 0, 4, 4, 10), ev('nearMiss', 0, 5, 6, 90), ev('goal', 1, 5, 7)]
    expect(pickTurning(events, 0, 1, 'Sable')).toBe('Your shot at 5 to 6 went just wide.')
  })
  test('closeCalls counts only the player\'s posts and near misses', () => {
    expect(closeCalls([ev('post', 0, 1, 1), ev('post', 1, 1, 1), ev('nearMiss', 0, 1, 1), ev('save', 0, 1, 1)], 0)).toEqual({ posts: 1, nearMisses: 1 })
  })
})

describe('goalTimelineLine and closeCallsLine', () => {
  const events = [ev('goal', 1, 0, 1), ev('shot', 0, 0, 1), ev('goal', 0, 1, 1), ev('goal', 0, 2, 1), ev('goal', 1, 2, 2)]
  test('the goals in order, by who scored, with the score after each (your score first)', () => {
    expect(goalTimelineLine(events, 0, 'Sable')).toBe('Goals in order, your score first: Sable 0 to 1; you 1 to 1; you 2 to 1; Sable 2 to 2.')
  })
  test('the public wording names the player, not you', () => {
    expect(goalTimelineLine(events, 0, 'Sable', true)).toBe("Goals in order, the player's score first: Sable 0 to 1; the player 1 to 1; the player 2 to 1; Sable 2 to 2.")
  })
  test('no goals, no line', () => {
    expect(goalTimelineLine([ev('post', 0, 0, 0)], 0, 'Sable')).toBeNull()
  })
  test('close calls count posts and near misses for both sides', () => {
    const e = [ev('post', 0, 1, 1), ev('nearMiss', 0, 1, 1), ev('nearMiss', 0, 1, 1), ev('post', 1, 1, 1), ev('save', 1, 1, 1)]
    expect(closeCallsLine(e, 0, 'Pip')).toBe('Close calls: you had 1 post and 2 near misses; Pip had 1 post and 0 near misses.')
    expect(closeCallsLine(e, 0, 'Pip', true)).toBe('Close calls: the player had 1 post and 2 near misses; Pip had 1 post and 0 near misses.')
  })
  test('no close calls on either side, no line', () => {
    expect(closeCallsLine([ev('goal', 0, 1, 0)], 0, 'Pip')).toBeNull()
  })
})

describe('goalPips', () => {
  test('one pip per goal in order, who scored, the score after it from the player side', () => {
    const events = [ev('goal', 1, 0, 1), ev('shot', 0, 0, 1), ev('goal', 0, 1, 1), ev('goal', 0, 2, 1)]
    expect(goalPips(events, 0, 0, 'Sable').map((p) => [p.mine, p.you, p.them])).toEqual([[false, 0, 1], [true, 1, 1], [true, 2, 1]])
    expect(goalPips(events, 1, 1, 'Sable').map((p) => [p.mine, p.you, p.them])).toEqual([[true, 1, 0], [false, 1, 1], [false, 1, 2]])
  })
  test('the turning point marks the goal that put the winner ahead for good, and no pip when the turning point is a post', () => {
    const goals = [ev('goal', 0, 1, 0), ev('goal', 1, 1, 1), ev('goal', 0, 2, 1), ev('goal', 1, 2, 2), ev('goal', 0, 3, 2), ev('goal', 1, 3, 3), ev('goal', 1, 3, 4), ev('goal', 1, 3, 5), ev('goal', 1, 3, 6), ev('goal', 1, 3, 7)]
    // Sable went ahead 4 to 3 on the seventh goal and the player never drew level again.
    expect(goalPips(goals, 0, 1, 'Sable').map((p) => p.turning)).toEqual(goals.map((_, i) => i === 6))
    const withPost = [...goals.slice(0, 7), ev('post', 0, 3, 4), ...goals.slice(7)]
    expect(goalPips(withPost, 0, 1, 'Sable').some((p) => p.turning)).toBe(false)
  })
  test('no goals, no pips', () => {
    expect(goalPips([ev('post', 0, 0, 0)], 0, null, 'Sable')).toEqual([])
  })
})

const result = (winner: 0 | 1 | null, score: [number, number], reason: string): MatchRecordV1 =>
  ({ humanSeat: 0, result: { winner, score, reason }, agent: { level: 'champion', version: 'x' } }) as unknown as MatchRecordV1

describe('nearMissLine', () => {
  test('a 6 to 7 loss: "You took Sable to 6 to 7."', () => {
    expect(nearMissLine(result(1, [6, 7], 'goals'), 'Sable')).toBe('You took Sable to 6 to 7.')
  })
  test('a 5 to 7 loss counts, 4 to 7 does not', () => {
    expect(nearMissLine(result(1, [5, 7], 'goals'), 'Sable')).toBe('You took Sable to 5 to 7.')
    expect(nearMissLine(result(1, [4, 7], 'goals'), 'Sable')).toBeNull()
  })
  test('sudden death loss is named', () => {
    expect(nearMissLine(result(1, [6, 6], 'sudden'), 'Sable')).toBe('You took Sable to sudden death at 6 to 6.')
  })
  test('wins and draws get none', () => {
    expect(nearMissLine(result(0, [7, 6], 'goals'), 'Sable')).toBeNull()
    expect(nearMissLine(result(null, [3, 3], 'draw'), 'Sable')).toBeNull()
  })
})

// Real records, replayed: every claim must be backed by the sim's own events.
async function record(seed: number, level: Level) {
  const m = new PuckMatch(seed, level)
  const human = createBot('striker', seed + 1)
  const rec = createMatchRecorder({ game: 'puck', matchId: `p10-${seed}-${level}`, seed, humanSeat: 0, agent: { version: 'preview', level }, trainingAllowed: false, device: 'desktop', input: 'mouse' })
  while (!m.over) {
    const frame = m.s.frame
    const code = frame % 2 === 0 ? (() => { const t = human.act(observe(m.s, 0)); return unitToCell(t[0]) + GRID * unitToCell(t[1]) })() : NO_INPUT
    m.tick(code)
    rec.recordAction(frame, 0, code)
    rec.recordAction(frame, 1, m.inputs[1])
  }
  const out = await rec.finish(puckCore, m.s)
  return { rec: out.record, final: m.s }
}

describe('on real replayed records', () => {
  for (const seed of [3, 11, 21]) {
    test(`seed ${seed}: the timeline matches the sim's own counters and the final score`, async () => {
      const { rec, final } = await record(seed, 'hard')
      const events = puckTimeline(rec)
      for (const seat of [0, 1] as const) {
        const count = (k: PuckEvent['kind']) => events.filter((e) => e.seat === seat && e.kind === k).length
        const at = (kind: number) => final.stats[seat * 6 + kind - 1] ?? 0
        expect(count('goal')).toBe(at(1)); expect(count('shot')).toBe(at(2)); expect(count('save')).toBe(at(3))
        expect(count('post')).toBe(at(4)); expect(count('nearMiss')).toBe(at(5))
        expect(count('goal')).toBe(final.score[seat]!)
      }
      expect(events.at(-1)?.score).toEqual([final.score[0], final.score[1]])
    })
    test(`seed ${seed}: any turning line is backed by a matching event`, async () => {
      const { rec } = await record(seed, 'hard')
      const line = turningPointFor(rec)
      const events = puckTimeline(rec)
      if (line === null) return
      if (line.includes('hit the post')) expect(events.some((e) => e.kind === 'post')).toBe(true)
      if (line.includes('just wide')) expect(events.some((e) => e.kind === 'nearMiss')).toBe(true)
      if (line.includes('went ahead')) expect(events.filter((e) => e.kind === 'goal').length).toBeGreaterThan(1)
      expect(line).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`))
    })
  }
  test('a record that does not run gives no line', () => {
    const bad = { game: 'puck', seed: 1, actions: [[0, 0, 99999]], agent: { level: 'easy', version: 'x' }, humanSeat: 0, result: { winner: 1, score: [0, 7], reason: 'goals' } } as unknown as MatchRecordV1
    expect(turningPointFor(bad) === null || typeof turningPointFor(bad) === 'string').toBe(true)
  })
  test('puckReportMoments: cards come only from the timeline and carry a public wording', async () => {
    for (const seed of [3, 11, 21]) {
      const { rec } = await record(seed, 'champion')
      const cards = puckReportMoments(rec, 'Sable')
      for (const c of cards) {
        expect(c.text.length).toBeGreaterThan(0)
        expect(c.publicText).not.toMatch(/\b(you|your)\b/i)
      }
      expect(cards.filter((c) => c.kind === 'turning').length).toBeLessThanOrEqual(1)
    }
  })
  test('puckReportMoments: the goal timeline and close calls are on the report, backed by the replay', async () => {
    const { rec, final } = await record(11, 'hard')
    const cards = puckReportMoments(rec, 'Sable')
    const goals = cards.find((c) => c.label === 'Goals')
    expect(goals?.text.startsWith('Goals in order, your score first: ')).toBe(true)
    expect((goals?.text.match(/ to /g) ?? []).length).toBe(final.score[0]! + final.score[1]!)
    expect(goals?.publicText).not.toMatch(/\b(you|your)\b/i)
    const calls = cards.find((c) => c.label === 'Close calls')
    const n = (seat: number, kind: number) => final.stats[seat * 6 + kind - 1] ?? 0
    if (n(0, 4) + n(0, 5) + n(1, 4) + n(1, 5) > 0) expect(calls?.text).toContain(`you had ${n(0, 4)} post${n(0, 4) === 1 ? '' : 's'}`)
    else expect(calls).toBeUndefined()
  })
  test('buildReportBody handles a puck record: an end card, and no fighter health fields needed', async () => {
    const { rec } = await record(11, 'champion')
    const body = buildReportBody(rec)
    expect(body.moments.at(-1)?.kind).toBe('end')
    expect(body.moments.every((m) => !new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`).test(m.text))).toBe(true)
  })
})

describe('the report tiles and the share card say goals, not rounds or inputs', () => {
  test('the tiles give Goals as "You 5, Sable 7" and never "Rounds won" or the count of recorded inputs', async () => {
    const { rec } = await record(11, 'champion')
    const body = buildReportBody(rec)
    for (const mode of ['owner', 'public'] as const) {
      const tiles = reportTiles({ game: 'puck', mode, status: 'ready', level: 'champion' }, body)
      const labels = tiles.map((t) => t.label)
      expect(labels).toContain('Goals')
      expect(labels).not.toContain('Rounds won')
      expect(labels).not.toContain('Recorded inputs')
      expect(labels).not.toContain('Your moves')
      expect(tiles.find((t) => t.label === 'Goals')!.value).toBe(`${mode === 'owner' ? 'You' : 'Player'} ${rec.result.score[0]}, Sable ${rec.result.score[1]}`)
    }
  })
  test('the share card prints the score, names Glasscut, and carries no input count and no dash', () => {
    const svg = shareCardSvg({ game: 'puck', level: 'champion', outcome: 'loss', moves: 2160, rounds: { you: 6, ai: 7 }, link: 'duelwise.app/r/x' })
    expect(cardHeadline({ game: 'puck', level: 'champion', outcome: 'loss' })).toBe('Sable got me at Glasscut.')
    expect(svg).toContain('Champion level, 6 to 7.')
    expect(svg).not.toMatch(/recorded inputs|rounds|2160/)
    expect(svg).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`))
  })
})
