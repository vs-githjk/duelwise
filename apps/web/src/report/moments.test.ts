import { describe, expect, test } from 'bun:test'
import { GRID, NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { createBot } from '@duelwise/core/src/games/puck/bots'
import { observe, puckCore } from '@duelwise/core/src/games/puck/core'
import { unitToCell } from '@duelwise/core/src/games/puck/input'
import { getCore } from '@duelwise/core/src/games/index'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import type { Level } from '@duelwise/core/src/product'
import { createMatchRecorder } from '../lib/match-recorder'
import { PuckMatch } from '../games/puck/loop'
import { buildReportBody } from './build'
import { publicBody } from './copy'
import { MATERIAL } from './chess'
import { NOT_CLOSE, nearMiss, nearMissFor, publicNearMiss, showsNearMiss, type NearMiss } from './moments'
import { nearMissLine, turningPointFor } from './puck'
import { feedback } from '@duelwise/core/src/games/word/feedback'
import { GUESSABLE } from '@duelwise/core/src/games/word/lists'
import { wordCore } from '@duelwise/core/src/games/word/core'
import { playHoldemTo, playPairs, playRandom, playRealtime, playScript } from './testing'

const DASH = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`)
const YOU = /\b(you|your|yours)\b/i
const texts = (nm: NearMiss): string[] => [nm.turning, nm.line, nm.publicTurning, nm.publicLine, ...nm.stats.map((s) => s.label)].filter((t): t is string => t !== null)

describe('the contract', () => {
  test('a match that is not close carries no stats and no sentence, whatever the game passed', () => {
    const nm = nearMiss(false, { turning: 'x', line: 'y', stats: [{ label: 'a', value: 1 }] })
    expect(nm).toEqual(NOT_CLOSE)
    expect(nm.close).toBe(false)
    expect(nm.stats).toEqual([])
    expect(showsNearMiss(nm)).toBe(false)
  })
  test('a close match keeps at most four counts and shows', () => {
    const nm = nearMiss(true, { turning: 'It turned.', stats: [1, 2, 3, 4, 5].map((value) => ({ label: `s${value}`, value })) })
    expect(nm.stats).toHaveLength(4)
    expect(showsNearMiss(nm)).toBe(true)
    expect(nm.publicTurning).toBe('It turned.')
  })
  test('nothing to say is nothing to show, even when close', () => {
    expect(showsNearMiss(nearMiss(true, {}))).toBe(false)
    expect(showsNearMiss(null)).toBe(false)
  })
  test('the public wording swaps the sentences and keeps the counts', () => {
    const nm = nearMiss(true, { turning: 'You slipped.', publicTurning: 'The player slipped.', line: 'You were close.', publicLine: 'The player was close.', stats: [{ label: 'n', value: 1 }] })
    expect(publicNearMiss(nm)).toEqual({ ...nm, turning: 'The player slipped.', line: 'The player was close.' })
  })
})

// Glasscut: the port keeps the strings the result and report already had.
const synthetic = (winner: 0 | 1 | null, score: [number, number], reason: string): MatchRecordV1 =>
  ({ game: 'puck', coreVersion: getCore('puck').version, seed: 3, options: undefined, actions: [], humanSeat: 0, result: { winner, score, reason }, agent: { level: 'champion', version: 'x' } }) as unknown as MatchRecordV1

async function puckRecord(seed: number, level: Level) {
  const m = new PuckMatch(seed, level)
  const human = createBot('striker', seed + 1)
  const rec = createMatchRecorder({ game: 'puck', matchId: `nm-${seed}-${level}`, seed, humanSeat: 0, agent: { version: 'preview', level }, trainingAllowed: false, device: 'desktop', input: 'mouse' })
  while (!m.over) {
    const frame = m.s.frame
    const code = frame % 2 === 0 ? (() => { const t = human.act(observe(m.s, 0)); return unitToCell(t[0]) + GRID * unitToCell(t[1]) })() : NO_INPUT
    m.tick(code)
    rec.recordAction(frame, 0, code)
    rec.recordAction(frame, 1, m.inputs[1])
  }
  return (await rec.finish(puckCore, m.s)).record
}

describe('Glasscut through the contract', () => {
  test('a 5 to 7 loss: the same line as before, goals short, and no stat for posts that did not happen', () => {
    const nm = nearMissFor(synthetic(1, [5, 7], 'goals'), 'Sable')!
    expect(nm.close).toBe(true)
    expect(nm.line).toBe(nearMissLine(synthetic(1, [5, 7], 'goals'), 'Sable')!)
    expect(nm.line).toBe('You took Sable to 5 to 7.')
    expect(nm.publicLine).toBe('The player took Sable to 5 to 7.')
    expect(nm.stats).toEqual([{ label: 'Goals short', value: 2 }])
  })
  test('4 to 7 is a blowout: close false, no stats', () => {
    expect(nearMissFor(synthetic(1, [4, 7], 'goals'), 'Sable')).toEqual(NOT_CLOSE)
  })
  test('sudden death loss is close and says so', () => {
    expect(nearMissFor(synthetic(1, [6, 6], 'sudden'), 'Sable')!.line).toBe('You took Sable to sudden death at 6 to 6.')
  })
  test('on the result screen a one goal loss leaves out the line the coach already says, and the goals short count', () => {
    const rec = synthetic(1, [6, 7], 'goals')
    const result = nearMissFor(rec, 'Sable', { surface: 'result' })!
    expect(result.line).toBeNull()
    expect(result.stats).toEqual([])
    expect(showsNearMiss(result)).toBe(false)
    expect(nearMissFor(rec, 'Sable')!.line).toBe('You took Sable to 6 to 7.')
  })
  test('a win with no late chance and a draw give nothing', () => {
    expect(nearMissFor(synthetic(0, [7, 3], 'goals'), 'Sable')).toEqual(NOT_CLOSE)
    expect(nearMissFor(synthetic(null, [3, 3], 'draw'), 'Sable')).toBeNull()
  })
  for (const seed of [3, 11, 21]) {
    test(`seed ${seed}, real replay: every sentence is the one the report already printed, and nothing comes from outside the record`, async () => {
      const rec = await puckRecord(seed, 'hard')
      const nm = nearMissFor(rec, 'Sable')
      expect(nm).toEqual(nearMissFor({ ...rec }, 'Sable'))
      if (!nm || !nm.close) return
      if (rec.result.winner !== rec.humanSeat) expect(nm.line).toBe(nearMissLine(rec, 'Sable'))
      if (nm.turning !== null) expect(nm.turning).toBe(turningPointFor({ ...rec, agent: { ...rec.agent, level: 'champion' } }) ?? nm.turning)
      for (const t of texts(nm)) expect(t).not.toMatch(DASH)
      expect(nm.publicTurning ?? '').not.toMatch(YOU)
      expect(nm.publicLine ?? '').not.toMatch(YOU)
    })
  }
})

// Chess: White (the human) plays ten level moves, then hangs the queen to a knight. The record resigns after one more move; the near miss
// reads it as a loss that was played, so the test marks the result a checkmate.
const LEVEL_TEN = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3', 'g8f6', 'd2d3', 'd7d6', 'e1g1', 'e8g8', 'f1e1', 'f8e8', 'b1d2', 'c8e6', 'c4b3', 'e6b3', 'd2b3', 'c5b6']
const lost = (rec: MatchRecordV1): MatchRecordV1 => ({ ...rec, result: { ...rec.result, reason: 'checkmate' } })

describe('chess', () => {
  test('a knight hung on move 11 after ten level moves is where it turned, with the score before and after, and the loss is close', () => {
    const rec = lost(playScript('chess', 4, [...LEVEL_TEN, 'b3a5', 'b6a5', 'a2a3'], 0, 'medium', true))
    const nm = nearMissFor(rec, 'Sable', { chessEvaluator: MATERIAL })!
    expect(nm.close).toBe(true)
    expect(nm.turning).toMatch(/^11\. Na5 was where it turned: your position score went from \+0\.0 to -3\.0\./)
    expect(nm.line).toBe('Right before move 11 you were level.')
    expect(nm.stats).toEqual([{ label: 'Moves level or ahead', value: 10 }, { label: 'Moves played after the slip', value: 1 }])
    expect(nm.publicTurning).toMatch(/the player's position score/)
    expect(nm.publicLine).toBe('Right before move 11 the player was level.')
    for (const t of texts(nm)) expect(t).not.toMatch(DASH)
  })
  test('the same blunder in the first moves is a quick loss, not a near miss', () => {
    const rec = lost(playScript('chess', 2, ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'h5e5', 'c6e5', 'f1c4', 'f8c5'], 0, 'medium', true))
    expect(nearMissFor(rec, 'Sable')).toEqual(NOT_CLOSE)
  })
  test('a loss with no big drop (no slip to name) is not close', () => {
    const rec = lost(playScript('chess', 4, [...LEVEL_TEN, 'a2a3', 'a7a6'], 0, 'medium', true))
    expect(nearMissFor(rec, 'Sable')).toEqual(NOT_CLOSE)
  })
  test('a win, and a resignation, give nothing', () => {
    expect(nearMissFor(playScript('chess', 1, ['f2f3', 'e7e5', 'g2g4', 'd8h4'], 1), 'Sable')).toBeNull()
    expect(nearMissFor(playScript('chess', 4, [...LEVEL_TEN, 'b3a5', 'b6a5'], 0, 'medium', true), 'Sable')).toBeNull()
  })
  test('the report body carries it, and the public body words it about the player', () => {
    const rec = lost(playScript('chess', 4, [...LEVEL_TEN, 'b3a5', 'b6a5', 'a2a3'], 0, 'medium', true))
    const body = buildReportBody(rec)
    expect(body.nearMiss?.close).toBe(true)
    expect(publicBody(body).nearMiss?.turning).toMatch(/the player's position score/)
    expect(publicBody(body).nearMiss?.line).toMatch(/the player was level/)
  })
})

describe('Four in a Row', () => {
  test('the drop after which the solver says lost is named, with what kept it and how long the player held on', () => {
    const rec = playRandom('four', 3, 0)
    const nm = nearMissFor(rec, 'Sable')!
    expect(nm.close).toBe(true)
    expect(nm.turning).toBe('Drop 27, column 7, was where it turned: after it the solver says Sable wins. Column 5 kept it.')
    expect(nm.line).toMatch(/^Before drop 27 you could still (win|draw)\.$/)
    expect(nm.publicLine).toMatch(/^Before drop 27 the player could still (win|draw)\.$/)
    expect(nm.stats.map((s) => s.label)).toEqual(['Drops that still held a win or draw', 'Drops after it turned'])
    expect(nm.stats[1]!.value).toBe(3)
  })
  test('a long game lost to one missed block, where the solver did not reach, says which column', () => {
    const nm = nearMissFor(playRandom('four', 2, 0), 'Sable')!
    expect(nm.close).toBe(true)
    expect(nm.turning).toBe("At drop 13 you could have played column 2. Column 2 would have blocked Sable's four in a row.")
    expect(nm.publicTurning).toMatch(/the player could have played column 2/)
  })
  test('a loss in eight drops is a blowout: no strip', () => {
    expect(nearMissFor(playScript('four', 1, [0, 3, 0, 3, 0, 3, 1, 3], 0), 'Sable')).toEqual(NOT_CLOSE)
  })
  test('a loss the solver already had lost before it started is not close', () => {
    expect(nearMissFor(playRandom('four', 12, 0), 'Sable')).toEqual(NOT_CLOSE)
  })
  test('a win gives nothing', () => {
    expect(nearMissFor(playRandom('four', 40, 0), 'Sable')).toBeNull()
  })
})

describe('Crosscurrent', () => {
  test('a corner given away is the turning point, and the counts come from the board', () => {
    const rec = playRandom('slack', 13, 0)
    const nm = nearMissFor(rec, 'Sable')!
    expect(nm.close).toBe(true)
    expect(nm.turning).toBe('Placing at G7 let Sable take the H8 corner on the next move.')
    expect(nm.line).toBe('You finished 4 discs short.')
    expect(nm.stats).toEqual([{ label: 'Discs short', value: 4 }, { label: 'Corners taken', value: 0 }, { label: 'Best disc lead', value: 7 }])
    expect(nm.publicLine).toBe('The player finished 4 discs short.')
  })
  test('without a gift, the biggest single turn names the swing', () => {
    expect(nearMissFor(playRandom('slack', 7, 0), 'Sable')!.turning).toBe('Sable flipped 7 of your discs by placing at E1.')
    expect(nearMissFor(playRandom('slack', 7, 0), 'Sable')!.publicTurning).toBe("Sable flipped 7 of the player's discs by placing at E1.")
  })
  test('the margin edge: six discs short is close, and the strip may name no moment at all', () => {
    expect(nearMissFor(playRandom('slack', 15, 0), 'Sable')!.stats[0]).toEqual({ label: 'Discs short', value: 6 })
    expect(nearMissFor(playRandom('slack', 1, 0), 'Sable')!.turning).toBeNull()
  })
  test('a lost game by more than six discs is a blowout: close false, no stats', () => {
    expect(nearMissFor(playRandom('slack', 2, 0), 'Sable')).toEqual(NOT_CLOSE)
  })
  test('a win gives nothing, and so does a game the replay did not finish', () => {
    const win = playRandom('slack', 4, 0)
    if (win.result.winner === 0) expect(nearMissFor(win, 'Sable')).toBeNull()
    const cut = { ...playRandom('slack', 13, 0), actions: playRandom('slack', 13, 0).actions.slice(0, 20) }
    expect(nearMissFor(cut, 'Sable')).toBeNull()
  })
})

describe('Twelve Yards', () => {
  test('a shootout lost by one goal names the last kick that missed, and counts what the kicks show', () => {
    const nm = nearMissFor(playRandom('penalty', 6, 0), 'Sable')!
    expect(nm.close).toBe(true)
    expect(nm.turning).toBe('Kick 9: your kick to the right went wide. A goal there would have levelled the shootout.')
    expect(nm.publicTurning).toBe("Kick 9: the player's kick to the right went wide. A goal there would have levelled the shootout.")
    expect(nm.line).toBe('You finished one goal short, 4 to 5.')
    expect(nm.publicLine).toBe('The player finished one goal short, 4 to 5.')
    expect(nm.stats).toEqual([{ label: 'Goal short', value: 1 }, { label: 'Missed kick', value: 1 }])
  })
  test('saves the player made as keeper are counted, and a miss can be a save, wide or over', () => {
    const nm = nearMissFor(playRandom('penalty', 8, 0), 'Sable')!
    expect(nm.turning).toBe('Kick 3: your kick at the bottom middle went wide. A goal there would have levelled the shootout.')
    expect(nm.stats).toEqual([{ label: 'Goal short', value: 1 }, { label: 'Missed kicks', value: 2 }, { label: 'Save made', value: 1 }])
  })
  test('going out in sudden death says so and counts the extra rounds', () => {
    const nm = nearMissFor(playRandom('penalty', 15, 0), 'Sable')!
    expect(nm.line).toBe('You went out in sudden death, round 6.')
    expect(nm.stats.at(-1)).toEqual({ label: 'Sudden death rounds', value: 1 })
  })
  test('it never says how likely a kick was: the goal tables are not on the page', () => {
    for (const seed of [6, 8, 15]) for (const t of texts(nearMissFor(playRandom('penalty', seed, 0), 'Sable')!)) expect(t).not.toMatch(/\d+ (in|out of) \d+|per ?cent|%|chance|odds/i)
  })
  test('a loss by two or more goals is not close, a win is nothing, and a win for the player is nothing', () => {
    expect(nearMissFor(playRandom('penalty', 1, 0), 'Sable')).toEqual(NOT_CLOSE)
    expect(nearMissFor(playRandom('penalty', 2, 0), 'Sable')).toBeNull()
    expect(nearMissFor(playRandom('penalty', 6, 1), 'Sable')).toBeNull()
  })
  test('a counted match replays on the server\'s own random words (options.entropy), not on the seed', () => {
    const core = getCore('penalty')
    for (let base = 1; base < 200; base++) {
      const entropy = Array.from({ length: 34 }, (_, i) => Math.imul(base * 7919 + i, 0x9e3779b1) | 0)
      let st = core.init(7, { entropy })
      const actions: MatchRecordV1['actions'] = []
      for (let tick = 0; !core.terminal(st); tick++) {
        for (const seat of [0, 1] as const) actions.push([tick, seat, 0])
        st = core.step(st, [0, 0] as never)
      }
      const res = core.result(st)!
      if (res.winner !== 1 || res.score[1]! - res.score[0]! !== 1) continue
      const rec = { ...playRandom('penalty', 7, 0), actions, result: res, finalHash: core.hash(st), options: { entropy } }
      const nm = nearMissFor(rec, 'Sable')!
      expect(nm.close).toBe(true)
      expect(nm.line).toBe(`You finished one goal short, ${res.score[0]} to ${res.score[1]}.`)
      // Without its entropy the same actions replay on the seed alone and give another shootout, so the strip would be about a match nobody played.
      expect(nearMissFor({ ...rec, options: undefined }, 'Sable')?.line).not.toBe(nm.line)
      return
    }
    throw new Error('no entropy found for a one goal loss')
  })
  test('a resigned record and a cut record give nothing', () => {
    const rec = playRandom('penalty', 6, 0)
    expect(nearMissFor({ ...rec, result: { ...rec.result, reason: 'resigned' } }, 'Sable')).toBeNull()
    expect(nearMissFor({ ...rec, actions: rec.actions.slice(0, 8) }, 'Sable')).toBeNull()
  })
})

describe('Stormglass', () => {
  test('within three hits of the whole fleet: how many hits, ships sunk and shots, and no coordinate anywhere', () => {
    const nm = nearMissFor(playRandom('fleet', 1, 1), 'Sable')!
    expect(nm.close).toBe(true)
    expect(nm.turning).toBe('You were 1 hit from sinking the last ship.')
    expect(nm.publicTurning).toBe('The player was 1 hit from sinking the last ship.')
    expect(nm.line).toBe('Sable sank your last ship on shot 99; you had fired 98.')
    expect(nm.stats).toEqual([{ label: 'Hit short', value: 1 }, { label: 'Ships sunk', value: 4 }, { label: 'Shots fired', value: 98 }])
    for (const t of texts(nm)) expect(t).not.toMatch(/\b[A-J](10|[1-9])\b/)
  })
  test('two ships still afloat are counted together', () => {
    const nm = nearMissFor(playRandom('fleet', 5, 0), 'Sable')!
    expect(nm.turning).toBe('You were 2 hits from sinking the last 2 ships.')
    expect(nm.stats[0]).toEqual({ label: 'Hits short', value: 2 })
  })
  test('more than three hits short is not close, and a win or a cut game gives nothing', () => {
    expect(nearMissFor(playRandom('fleet', 9, 0), 'Sable')).toEqual(NOT_CLOSE)
    expect(nearMissFor(playRandom('fleet', 1, 0), 'Sable')).toBeNull()
    const rec = playRandom('fleet', 1, 1)
    expect(nearMissFor({ ...rec, actions: rec.actions.slice(0, 40) }, 'Sable')).toBeNull()
  })
})

describe('Word Duel', () => {
  const answerOf = (seed: number): string => wordCore.init(seed).answer
  const greens = (g: string, a: string): number => Array.from(feedback(g, a)).filter((m) => m === 2).length
  const enc = (w: string): number => wordCore.encodeAction(w)
  /** Round one: both guess something that is not the answer; round two: the player plays `mine`, the AI plays the answer. */
  const lose = (seed: number, mine: string, first = 'crane'): ReturnType<typeof playPairs> => playPairs('word', seed, [[enc(first), enc(first)], [enc(mine), enc(answerOf(seed))]], 0)
  const oneOff = (a: string): string => GUESSABLE.find((w) => w !== a && greens(w, a) === 4)!
  const wide = (a: string): string => GUESSABLE.find((w) => greens(w, a) <= 1 && w !== 'crane')!
  test('four of five right in the round the other side solved it: one more would have tied', () => {
    const a = answerOf(5)
    const nm = nearMissFor(lose(5, oneOff(a)), 'Sable')!
    expect(nm.close).toBe(true)
    expect(nm.turning).toBe(`Guess 2: ${oneOff(a).toUpperCase()} had 4 of 5 letters in the right place. One more would have tied the round.`)
    expect(nm.line).toBe('Sable solved it on guess 2.')
    expect(nm.stats[0]).toEqual({ label: 'Letters in the right place', value: 4 })
    expect(nm.stats.at(-1)!.label).toMatch(/^Words? fits? your clues$/)
  })
  test('the public wording is the same sentence, since a guess is the player\'s own and the answer is revealed', () => {
    const nm = nearMissFor(lose(5, oneOff(answerOf(5))), 'Sable')!
    expect(nm.publicTurning).toBe(nm.turning)
  })
  test('three right is not close: the edge is four', () => {
    const a = answerOf(5)
    const three = GUESSABLE.find((w) => greens(w, a) === 3)!
    expect(nearMissFor(lose(5, three), 'Sable')).toEqual(NOT_CLOSE)
  })
  test('three or fewer right is not close', () => {
    expect(nearMissFor(lose(5, wide(answerOf(5))), 'Sable')).toEqual(NOT_CLOSE)
  })
  test('only the final round counts: a near guess earlier does not make a late loss close', () => {
    const a = answerOf(5)
    const rec = playPairs('word', 5, [[enc('crane'), enc('crane')], [enc(oneOff(a)), enc('slate' === a ? 'house' : 'slate')], [enc(wide(a)), enc(a)]], 0)
    expect(nearMissFor(rec, 'Sable')).toEqual(NOT_CLOSE)
  })
  test('a tie and a win give nothing', () => {
    const a = answerOf(5)
    expect(nearMissFor(playPairs('word', 5, [[enc(a), enc(a)]], 0), 'Sable')).toBeNull()
    expect(nearMissFor(playPairs('word', 5, [[enc(a), enc('crane' === a ? 'slate' : 'crane')]], 0), 'Sable')).toBeNull()
  })
})

describe("Hold'em", () => {
  test('a match lost by five big blinds or fewer names the hand that cost the most, in the words the key moments use', () => {
    const nm = nearMissFor(playHoldemTo(10, 0, 5), 'Sable')!
    expect(nm.close).toBe(true)
    expect(nm.turning).toBe('Hand 1: Sable won 100 chips at showdown with a pair of tens, king kicker, against your pair of sixes, king kicker. That one hand cost more than the whole gap.')
    expect(nm.publicTurning).toContain("against the player's pair of sixes")
    expect(nm.line).toBe('You finished 2 chips behind after 5 hands.')
    expect(nm.stats).toEqual([{ label: 'Chips short', value: 2 }, { label: 'Hands won', value: 2 }, { label: 'Hands lost', value: 3 }, { label: 'Biggest lost pot', value: 100 }])
  })
  test('the "cost more than the gap" sentence is only said when it is true', () => {
    const said = nearMissFor(playHoldemTo(3, 0, 5, 'medium', true), 'Sable')!
    expect(said.turning).toBe('Hand 1: Sable won 2 chips at showdown with two pair, queens and fives, against your ace high. That one hand cost more than the whole gap.')
    expect(said.stats[0]).toEqual({ label: 'Chip short', value: 1 })
    const unsaid = nearMissFor(playHoldemTo(4, 0, 5, 'medium', true), 'Sable')!
    expect(unsaid.turning).toBe('Hand 1: Sable won 2 chips at showdown with a straight, five high, against your two pair, eights and twos.')
    expect(unsaid.stats[0]).toEqual({ label: 'Chips short', value: 4 })
  })
  test('under the strict bust rule every counted match uses: a close finish still shows, and a bust is not close', () => {
    expect(nearMissFor(playHoldemTo(3, 0, 5, 'medium', true, true), 'Sable')!.line).toBe('You finished 1 chip behind after 5 hands.')
    const bust = playHoldemTo(3, 0, 5, 'medium', false, true)
    expect(bust.result.reason).toBe('the other player lost all 100 chips in hand 1')
    expect(nearMissFor(bust, 'Sable')).toEqual(NOT_CLOSE)
  })
  test('a loss by more than ten chips is not close, and a concede gives nothing', () => {
    expect(nearMissFor(playHoldemTo(3, 0, 5), 'Sable')).toEqual(NOT_CLOSE)
    expect(nearMissFor(playRandom('holdem', 3, 0), 'Sable')).toBeNull()
  })
  test('a win gives nothing', () => {
    expect(nearMissFor(playHoldemTo(1, 0, 5), 'Sable')).toBeNull()
  })
  test('nothing in the strip shows a hand the table did not turn over', () => {
    for (const seed of [10, 70, 91, 96]) {
      const rec = playHoldemTo(seed, 0, 5)
      const nm = nearMissFor(rec, 'Sable')!
      const hands = (nm.turning ?? '').includes('at showdown')
      // The sentence is built from the hand summary, which only carries both hole hands when the hand reached showdown.
      expect(hands || !/against/.test(nm.turning ?? '')).toBe(true)
    }
  })
})

describe('Tinderbox and Coldstore', () => {
  test('lost by one round: the lost round the knockout left narrowest is named, with the health the winner had left', () => {
    const nm = nearMissFor(playRealtime('fighter', 9, 1), 'Sable')!
    expect(nm.close).toBe(true)
    expect(nm.turning).toBe('Sable won round 1 by elimination with only 710 of 10,000 health left.')
    expect(nm.publicTurning).toBe('Sable won round 1 by elimination with only 710 of 10,000 health left.')
    expect(nm.line).toBe('You were one round short, 1 to 2.')
    expect(nm.stats).toEqual([{ label: 'Round short', value: 1 }, { label: 'Round won', value: 1 }, { label: 'Health gap in your closest lost round', value: 710 }])
  })
  test('a round the clock ended names both health totals, and the public wording says "the player"', () => {
    const nm = nearMissFor(playRealtime('fighter', 11, 1), 'Sable')!
    expect(nm.turning).toBe('Sable won round 3 on the clock, 2,930 health to your 2,350.')
    expect(nm.publicTurning).toBe("Sable won round 3 on the clock, 2,930 health to the player's 2,350.")
    expect(nm.publicLine).toBe('The player was one round short, 1 to 2.')
  })
  test('a lost round that was not narrow gives the counts and no turning point', () => {
    const nm = nearMissFor(playRealtime('fighter', 15, 0), 'Sable')!
    expect(nm.close).toBe(true)
    expect(nm.turning).toBeNull()
    expect(nm.stats[2]).toEqual({ label: 'Health gap in your closest lost round', value: 3730 })
  })
  test('Coldstore reads the same way on its own health scale', () => {
    const nm = nearMissFor(playRealtime('arena', 1, 0), 'Sable')!
    expect(nm.turning).toBe('Sable won round 6 on the clock, 100 health to your 81.')
    expect(nm.line).toBe('You were one round short, 2 to 3.')
    expect(nm.stats).toEqual([{ label: 'Round short', value: 1 }, { label: 'Rounds won', value: 2 }, { label: 'Health gap in your closest lost round', value: 19 }])
  })
  test('a loss by two rounds is not close; a win and a draw give nothing', () => {
    expect(nearMissFor(playRealtime('fighter', 2, 0), 'Sable')).toEqual(NOT_CLOSE)
    expect(nearMissFor(playRealtime('arena', 4, 0), 'Sable')).toEqual(NOT_CLOSE)
    expect(nearMissFor(playRealtime('fighter', 1, 0), 'Sable')).toBeNull()
    expect(nearMissFor(playRealtime('arena', 2, 0), 'Sable')).toBeNull()
  })
})

describe('the report body carries the strip for every game', () => {
  test('a close loss builds the same strip the result screen shows, and a win has none', () => {
    const cases: Array<[MatchRecordV1, MatchRecordV1]> = [
      [playRandom('penalty', 6, 0), playRandom('penalty', 2, 0)],
      [playRandom('fleet', 1, 1), playRandom('fleet', 1, 0)],
      [playHoldemTo(10, 0, 5), playHoldemTo(1, 0, 5)],
      [playRealtime('fighter', 9, 1), playRealtime('fighter', 1, 0)],
      [playRealtime('arena', 1, 0), playRealtime('arena', 3, 0)],
    ]
    for (const [loss, win] of cases) {
      const body = buildReportBody(loss, { opponent: 'Sable' })
      expect(body.nearMiss).toEqual(nearMissFor(loss, 'Sable'))
      expect(showsNearMiss(body.nearMiss)).toBe(true)
      expect(buildReportBody(win, { opponent: 'Sable' }).nearMiss ?? null).toBeNull()
    }
  })
  test('the public report never says "you" in any of the strips', () => {
    for (const rec of [playRandom('penalty', 6, 0), playRandom('fleet', 1, 1), playHoldemTo(10, 0, 5), playRealtime('fighter', 11, 1), playRealtime('arena', 1, 0)]) {
      const nm = publicNearMiss(nearMissFor(rec, 'Sable')!)
      for (const t of [nm.turning, nm.line]) if (t) expect(t).not.toMatch(YOU)
    }
  })
  test('no strip carries a dash', () => {
    for (const rec of [playRandom('penalty', 6, 0), playRandom('fleet', 1, 1), playHoldemTo(10, 0, 5), playRealtime('fighter', 11, 1)]) for (const t of texts(nearMissFor(rec, 'Sable')!)) expect(t).not.toMatch(DASH)
  })
})

describe('records that cannot be trusted give nothing', () => {
  test('a record from an older core version', () => {
    expect(nearMissFor({ ...playRandom('slack', 13, 0), coreVersion: 'old' }, 'Sable')).toBeNull()
    expect(nearMissFor({ ...playRandom('penalty', 6, 0), coreVersion: 'old' }, 'Sable')).toBeNull()
  })
})
