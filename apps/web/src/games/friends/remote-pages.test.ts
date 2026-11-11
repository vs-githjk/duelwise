import { describe, expect, test } from 'bun:test'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { fourFromMoves, stoneAt } from '@duelwise/core/src/games/four/rules'
import { slackCore } from '@duelwise/core/src/games/slack/core'
import { fleetCore } from '@duelwise/core/src/games/fleet'
import { penaltyCore } from '@duelwise/core/src/games/penalty/core'
import { wordCore } from '@duelwise/core/src/games/word/core'
import { holdemCore } from '@duelwise/core/src/games/holdem/core'
import { dealDecks } from '@duelwise/core/src/games/holdem/match'
import { makeRng } from '@duelwise/core/src/rng'
import { holdemMineFirst, holdemTableState, holdemReveal, holdemSideSummary } from './holdem-logic'
import { absoluteCells, chessMoveBetween as chessMove, fourStateFromObs, newStone, slackMoveBetween as slackMove } from './remote-logic'

describe('what a remote page rebuilds from one seat view', () => {
  test('Four: the board from either seat shows the same stones, winner and heights', () => {
    const s = fourFromMoves([3, 4, 3, 4, 3, 4, 3])
    for (const seat of [0, 1] as const) {
      const rebuilt = fourStateFromObs(fourCore.observe(s, seat))
      expect(rebuilt.n).toBe(7)
      expect(rebuilt.h).toEqual(s.h)
      expect(rebuilt.winner).toBe(0)
      for (let c = 0; c < 7; c++) for (let r = 0; r < 6; r++) expect(stoneAt(rebuilt, c, r)).toBe(stoneAt(s, c, r))
    }
  })

  test('Four: the new stone is found, a skipped reconnect or a first view shows none', () => {
    const a = fourCore.observe(fourFromMoves([3]), 1).cells
    const b = fourCore.observe(fourFromMoves([3, 3]), 1).cells
    const c = fourCore.observe(fourFromMoves([3, 3, 4, 4]), 1).cells
    expect(newStone(a, b, 1)).toEqual({ col: 3, row: 1, seat: 1 })
    expect(newStone(null, b, 1)).toBeNull()
    expect(newStone(a, c, 1)).toBeNull()
  })

  test('Crosscurrent: absolute cells agree for both seats, and the move between two boards names the disc and the flips', () => {
    const s0 = slackCore.init(0)
    const move = slackCore.legal(s0, 0)[0]!
    const s1 = slackCore.step(s0, [move, null])
    for (const seat of [0, 1] as const) {
      expect(absoluteCells(slackCore.observe(s1, seat))).toEqual(s1.cells)
    }
    const m = slackMove(absoluteCells(slackCore.observe(s0, 1)), absoluteCells(slackCore.observe(s1, 1)))
    expect(m?.cell).toBe(move)
    expect(m?.seat).toBe(0)
    expect(m?.flips.length).toBeGreaterThan(0)
    expect(slackMove(null, s1.cells)).toBeNull()
  })

  test('Chess: the move between two positions is found, and a gap of two moves is not guessed', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    const after = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'
    const two = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'
    expect(chessMove(start, after)).toEqual({ last: { from: 'e2', to: 'e4' }, san: 'e4' })
    expect(chessMove(start, two)).toBeNull()
  })

  test('the hidden games: one seat view holds nothing of the other seat', () => {
    // Word: the other seat's marker rows only, never its letters; the answer only at the end.
    let w = wordCore.init(7, { answer: 'crane' } as never)
    w = wordCore.step(w, ['jumpy', 'slate'])
    const wa = wordCore.observe(w, 0)
    expect(JSON.stringify(wa)).not.toContain('slate')
    expect(wa.answer).toBeNull()
    // Stormglass: before the end a seat has no `reveal` and sees only its own ships.
    const f = fleetCore.init(11)
    const fa = fleetCore.observe(f, 0)
    const fb = fleetCore.observe(f, 1)
    expect(fa.reveal).toBeNull()
    expect(fa.sunk).toEqual([])
    expect(fb.ships).toEqual([])
    // Twelve Yards: a view carries finished kicks and no pick of the kick in progress.
    const p = penaltyCore.init(5)
    const pa = penaltyCore.observe(p, 0)
    expect(pa.kicks).toEqual([])
    expect(Object.keys(pa).sort()).toEqual(['goals', 'kicks', 'over', 'role', 'round', 'seat', 'sudden', 'taken'])
  })
})

describe('Hold\'em: what the remote page rebuilds from one seat view', () => {
  const start = () => {
    const r = makeRng(5)
    return holdemCore.init(3, { hands: 10, decks: dealDecks(10, (n) => r.int(n)) })
  }
  const act = (s: ReturnType<typeof start>, a: Parameters<typeof holdemCore.step>[1][0]) => {
    const acts: [typeof a, typeof a] = [null, null]
    acts[s.actor] = a
    return holdemCore.step(s, acts)
  }

  test('mine-first: both seats see themselves as seat 0 in bets, totals and chips', () => {
    let s = start()
    s = act(s, { type: 'raise', to: 7 })
    for (const seat of [0, 1] as const) {
      const o = holdemCore.observe(s, seat)
      const m = holdemMineFirst(o)
      expect(m.bet[0]).toBe(s.bet[seat])
      expect(m.bet[1]).toBe(s.bet[1 - seat])
      expect(m.total[0]).toBe(s.total[seat])
      expect(m.net[0]).toBe(s.net[seat])
      expect(m.hole).toEqual(s.hole[seat])
      expect(m.minRaiseTo).toBe(o.minRaiseTo)
    }
  })

  test('the table state holds my cards in the human slot, the other slot empty, and the dealer on the right side', () => {
    const s = start()
    for (const seat of [0, 1] as const) {
      const t = holdemTableState(holdemCore.observe(s, seat))
      expect(t.hole[0]).toEqual(s.hole[seat])
      expect(t.hole[1]).toEqual([])
      expect(t.button).toBe(s.button === seat ? 0 : 1)
      expect(t.hand).toBe(0)
      expect(JSON.stringify(t)).not.toContain(JSON.stringify(s.hole[1 - seat]))
    }
  })

  test('a fold: the summary flips to mine-first, shows no cards, and the pot goes to the winner', () => {
    let s = start()
    const folder = s.actor
    const before = s.hole
    s = act(s, { type: 'fold' })
    for (const seat of [0, 1] as const) {
      const o = holdemCore.observe(s, seat)
      const sum = holdemSideSummary(o.last!, seat)
      expect(sum.hole).toBeNull()
      expect(sum.winner).toBe(seat === folder ? 1 : 0)
      expect(sum.delta).toBe(seat === folder ? -1 : 1)
      const rv = holdemReveal(o.last!, seat, before[seat], 'Sam', 'show')
      // the folder put in the small blind (1), the other the big blind (2)
      expect(rv.total).toEqual(seat === folder ? [1, 2] : [2, 1])
      expect(rv.hole).toEqual(before[seat])
      expect(rv.headline).toBe(seat === folder ? 'Sam wins 1, you fold' : 'You win 1, Sam folds')
    }
  })

  test('a showdown: both hands are in the summary, mine in slot 0 whichever seat I sit in', () => {
    let s = start()
    const first = s.hole
    while (s.hand === 0 && !holdemCore.terminal(s)) s = act(s, { type: 'call' })
    for (const seat of [0, 1] as const) {
      const o = holdemCore.observe(s, seat)
      const sum = holdemSideSummary(o.last!, seat)
      expect(sum.showdown).toBe(true)
      expect(sum.hole![0]).toEqual(first[seat])
      expect(sum.hole![1]).toEqual(first[1 - seat])
    }
  })
})
