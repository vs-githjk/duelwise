import { describe, expect, test } from 'bun:test'
import { replay } from '@duelwise/core/src/replay'
import { buildReportBody } from './build'
import { hasKeyMoments, reportTiles } from './copy'
import { playedHands } from './holdem'
import { realtimeFacts } from './realtime'
import { playRandom, playRealtime } from './testing'
import { humanActionCount } from './walk'
import { publicBody } from './copy'

describe("Hold'em report is built from the record", () => {
  const rec = playRandom('holdem', 5, 0, 'medium')
  const body = buildReportBody(rec)
  test("counts the player's real actions, the same count the share card prints", () => {
    expect(body.moves).toBeGreaterThan(0)
    expect(body.moves).toBe(humanActionCount(rec))
    expect(reportTiles({ game: 'holdem', mode: 'owner', status: 'ready' }, body)[0]).toMatchObject({ label: 'Your moves', value: String(body.moves) })
  })
  test('hand swings sum to the final chip result', () => {
    const hands = playedHands(rec)
    expect(hands.length).toBeGreaterThan(0)
    const total = hands.reduce((n, h) => n + h.human, 0)
    // The match result is about seat 0 chips; with the human in seat 0 the swings add up to it unless a concede ended the match early.
    if (rec.result.reason.startsWith('ahead by')) expect(Math.abs(total)).toBe(Number(/\d+/.exec(rec.result.reason)![0]))
  })
  test('key moments are the biggest real swings', () => {
    const hands = playedHands(rec)
    const win = Math.max(0, ...hands.map((h) => h.human))
    const loss = Math.min(0, ...hands.map((h) => h.human))
    const best = body.moments.find((m) => m.kind === 'best')
    const worst = body.moments.find((m) => m.kind === 'worst')
    if (win > 0) expect(best!.value).toBe(`+${win}`)
    else expect(best).toBeUndefined()
    if (loss < 0) expect(worst!.value).toBe(`-${-loss}`)
    else expect(worst).toBeUndefined()
    expect(body.moments.at(-1)!.kind).toBe('end')
    expect(hasKeyMoments(body)).toBe(win > 0 || loss < 0)
  })
  test('the public wording never says "you"', () => {
    const pub = publicBody(body)
    for (const m of pub.moments) expect(m.text).not.toMatch(/\byou\b|\byour\b/i)
  })
  for (const game of ['holdem', 'fighter', 'arena'] as const) {
    test(`${game}: public tags and value labels never say "you"`, () => {
      const rec = game === 'holdem' ? playRandom('holdem', 5, 0, 'medium') : playRealtime(game, 3, 0)
      const pub = publicBody(buildReportBody(rec))
      for (const m of pub.moments) expect(`${m.tag} ${m.valueLabel ?? ''} ${m.text}`).not.toMatch(/\byou\b|\byour\b/i)
    })
  }
})

describe('real-time reports', () => {
  for (const game of ['fighter', 'arena'] as const) {
    const rec = playRealtime(game, 3, 0, 'hard')
    const body = buildReportBody(rec)
    test(`${game}: the record replays and the report shows the real score, not "Rounds."`, () => {
      expect(replay(rec).ok).toBe(true)
      expect(body.rounds).toEqual({ you: rec.result.score[0], ai: rec.result.score[1] })
      expect(body.reason).toMatch(/\d rounds? to \d|A draw, \d rounds each/)
      expect(body.reason).not.toBe('Rounds.')
      const tiles = reportTiles({ game, mode: 'owner', status: 'ready' }, body)
      expect(body.moves).toBe(humanActionCount(rec))
      expect(tiles).toContainEqual({ label: 'Recorded inputs', value: String(humanActionCount(rec)) })
      expect(tiles[0]).toMatchObject({ label: 'Rounds won', value: `You ${rec.result.score[0]}, Opponent ${rec.result.score[1]}` })
    })
    test(`${game}: an older core still reports recorded inputs`, () => {
      expect(buildReportBody({ ...rec, coreVersion: 'old' }).moves).toBe(humanActionCount(rec))
    })
    test(`${game}: moments are real or absent`, () => {
      expect(body.moments.at(-1)!.kind).toBe('end')
      for (const m of body.moments.filter((x) => x.kind !== 'end')) {
        expect(m.text.length).toBeGreaterThan(10)
        expect(m.label).toMatch(/^(Round \d+|Try next)/)
      }
      // Every named round is one the record actually played.
      const played = realtimeFacts(rec).rounds.length
      for (const m of body.moments.filter((x) => x.kind !== 'end' && x.label.startsWith('Round '))) expect(Number(/\d+/.exec(m.label)![0])).toBeLessThanOrEqual(played)
    })
  }
  test('the other seat sees the score from their side', () => {
    const rec = playRealtime('fighter', 3, 1, 'hard')
    const body = buildReportBody(rec)
    expect(body.rounds).toEqual({ you: rec.result.score[1], ai: rec.result.score[0] })
  })
})
