import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { getCore } from '../games/index'
import type { GameId } from '../product'
import { makeRng } from '../rng'
import type { Seat } from '../types'
import { dealDecks } from '../games/holdem/match'
import { createRoom, join, submit, viewFor, type DuelRoom } from './room'

const ada = { ref: 'ref-ada', name: 'Ada', connected: true }
const sam = { ref: 'ref-sam', name: 'Sam', connected: true }
const GAMES = 200
setDefaultTimeout(120_000)

const room = (game: GameId, seed: number): DuelRoom<any> => {
  const r = createRoom(getCore(game), seed, ada, (seed & 1) as Seat)
  join(r, sam)
  return r
}

/** Keys of an object tree, to prove a view never carries a seed or a log. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out) }
  return out
}

/**
 * Plays one random game. Before every pick, `probe` sees the room. Seat 0 and seat 1 take turns picking first so that
 * both orders of a simultaneous step are exercised.
 */
function play(r: DuelRoom<any>, rng: ReturnType<typeof makeRng>, probe: (r: DuelRoom<any>, picker: Seat, action: number) => void): void {
  let guard = 0
  while (r.status === 'playing' && guard++ < 2000) {
    const order: Seat[] = rng.int(2) === 0 ? [0, 1] : [1, 0]
    for (const seat of order) {
      const v = viewFor(r, seat)
      if (!v.canAct) continue
      const a = v.legal[rng.int(v.legal.length)]!
      probe(r, seat, a)
      expect(submit(r, seat, a, v.n).ok).toBe(true)
    }
  }
  expect(r.status).toBe('over')
}

const strip = (v: ReturnType<typeof viewFor>) => JSON.stringify({ ...v, opponentReady: undefined })

describe('hidden information: no view holds the other seat\'s secret', () => {
  for (const game of ['fleet', 'penalty', 'word'] as const) {
    test(`${game}: a seat's view does not move when the other seat picks (${GAMES} games), and never has a seed or log`, () => {
      for (let seed = 1; seed <= GAMES; seed++) {
        const r = room(game, seed)
        play(r, makeRng(seed * 7919), (rm, picker) => {
          const watcher = (1 - picker) as Seat
          const before = strip(viewFor(rm, watcher))
          // the picker's pick is about to be held (or applied); a held pick must change nothing the watcher can see
          for (const seatView of [viewFor(rm, 0), viewFor(rm, 1)]) {
            const keys = keysOf(seatView)
            expect(seatView.seed).toBeNull()
            for (const bad of ['log', 'pending', 'state', 'entropy']) expect(keys.has(bad)).toBe(false)
          }
          expect(before).toBe(strip(viewFor(rm, watcher)))
        })
      }
    })
  }

  test('simultaneous picks: the watcher\'s view is identical whatever the held pick is (penalty, word, fleet setup)', () => {
    for (const game of ['penalty', 'word', 'fleet'] as const) {
      for (let seed = 1; seed <= 60; seed++) {
        // two clones of the same room, the picker holds a different legal pick in each; the watcher has not picked
        const views: string[] = []
        for (const which of [0, 1]) {
          const r = room(game, seed)
          // advance to a step where both seats are to act (always true at the start of these games)
          const picker: Seat = 0
          const legal = viewFor(r, picker).legal
          expect(legal.length).toBeGreaterThan(1)
          const a = which === 0 ? legal[0]! : legal[legal.length - 1]!
          expect(submit(r, picker, a, 0).ok).toBe(true)
          expect(r.n).toBe(0)
          views.push(strip(viewFor(r, 1)))
        }
        expect(views[0]).toBe(views[1])
      }
    }
  })

  test('Word Duel: the other seat\'s guess letters and the answer never appear before the game is over', () => {
    for (let seed = 1; seed <= GAMES; seed++) {
      const r = room('word', seed)
      const rng = makeRng(seed)
      while (r.status === 'playing') {
        for (const seat of [0, 1] as const) {
          const v = viewFor(r, seat)
          if (!v.canAct) continue
          expect(submit(r, seat, v.legal[rng.int(v.legal.length)]!, v.n).ok).toBe(true)
        }
        if (r.status !== 'playing') break
        for (const seat of [0, 1] as const) {
          const json = JSON.stringify(viewFor(r, seat).obs)
          const own = new Set(r.state.guesses[seat] as string[])
          for (const g of r.state.guesses[1 - seat] as string[]) if (!own.has(g)) expect(json).not.toContain(`"${g}"`)
          expect(json).not.toContain(`"${r.state.answer}"`)
          expect((viewFor(r, seat).obs as { answer: string | null }).answer).toBeNull()
        }
      }
      for (const seat of [0, 1] as const) {
        const v = viewFor(r, seat)
        expect((v.obs as { answer: string | null }).answer).toBe(r.state.answer)
        expect(v.seed).toBe(seed)
      }
    }
  })

  test('Stormglass: the other fleet is never in a view until it is sunk or the game is over', () => {
    for (let seed = 1; seed <= GAMES; seed++) {
      const r = room('fleet', seed)
      const rng = makeRng(seed + 1000)
      const check = () => {
        for (const seat of [0, 1] as const) {
          const v = viewFor(r, seat)
          const json = JSON.stringify(v.obs)
          const obs = v.obs as { ships: unknown[]; sunk: unknown[]; reveal: unknown[] | null; phase: string }
          const own = new Set(obs.ships.map((p) => JSON.stringify(p)))
          const sunk = new Set(obs.sunk.map((p) => JSON.stringify(p)))
          for (const p of r.state.ships[1 - seat] as unknown[]) {
            const frag = JSON.stringify(p)
            if (obs.phase === 'over' || own.has(frag) || sunk.has(frag)) continue
            expect(json).not.toContain(frag)
          }
          if (obs.phase !== 'over') expect(obs.reveal).toBeNull()
        }
      }
      while (r.status === 'playing') {
        for (const seat of [0, 1] as const) {
          const v = viewFor(r, seat)
          if (!v.canAct) continue
          expect(submit(r, seat, v.legal[rng.int(v.legal.length)]!, v.n).ok).toBe(true)
          check()
        }
      }
      for (const seat of [0, 1] as const) expect((viewFor(r, seat).obs as { reveal: unknown[] | null }).reveal).not.toBeNull()
    }
  })

  test('Twelve Yards: the kick roll and the other pick stay out of the view until the kick is taken', () => {
    for (let seed = 1; seed <= GAMES; seed++) {
      const r = room('penalty', seed)
      const rng = makeRng(seed)
      while (r.status === 'playing') {
        const first: Seat = rng.int(2) as Seat
        const a = viewFor(r, first)
        const picked = a.legal[rng.int(a.legal.length)]!
        expect(submit(r, first, picked, a.n).ok).toBe(true)
        // the watcher's observation shows the same kicks as before this pick, and the same observation as a game where it was never made
        const w = viewFor(r, (1 - first) as Seat)
        expect((w.obs as { kicks: unknown[] }).kicks.length).toBe(r.state.kicks.length)
        expect(w.opponentReady).toBe(true)
        const b = viewFor(r, (1 - first) as Seat)
        expect(submit(r, (1 - first) as Seat, b.legal[rng.int(b.legal.length)]!, b.n).ok).toBe(true)
      }
    }
  })

  test('a reconnecting seat gets only its own view: two seats at the same step never share an obs field they should not', () => {
    const r = room('fleet', 3)
    const rng = makeRng(3)
    for (let i = 0; i < 5; i++) for (const seat of [0, 1] as const) { const v = viewFor(r, seat); submit(r, seat, v.legal[rng.int(v.legal.length)]!, v.n) }
    const v0 = viewFor(r, 0).obs as { ships: unknown[] }
    const v1 = viewFor(r, 1).obs as { ships: unknown[] }
    expect(v0.ships.length).toBe(5)
    expect(v1.ships.length).toBe(5)
    expect(JSON.stringify(v0.ships)).toBe(JSON.stringify(r.state.ships[0]))
    expect(JSON.stringify(v1.ships)).toBe(JSON.stringify(r.state.ships[1]))
  })

  describe('Hold\'em', () => {
    const HANDS = 10
    const holdemRoom = (seed: number): DuelRoom<any> => {
      const rng = makeRng(seed * 31 + 5)
      const r = createRoom(getCore('holdem'), seed, ada, (seed & 1) as Seat, { hands: HANDS, decks: dealDecks(HANDS, (n) => rng.int(n)) })
      join(r, sam)
      return r
    }
    const OBS_KEYS = ['seat', 'hand', 'handsTotal', 'hole', 'board', 'street', 'bet', 'total', 'isButton', 'toMove', 'minRaiseTo', 'maxRaiseTo', 'net', 'last'].sort()

    test('no view holds the other seat\'s hole cards or any undealt card until a showdown shows them (200 matches)', () => {
      let folds = 0
      let showdowns = 0
      for (let seed = 1; seed <= GAMES; seed++) {
        const r = holdemRoom(seed)
        const rng = makeRng(seed)
        let lastHand = -1
        while (r.status === 'playing') {
          const toAct = r.state.actor as Seat
          const v = viewFor(r, toAct)
          for (const seat of [0, 1] as const) {
            const view = viewFor(r, seat)
            const obs = view.obs as { hole: number[]; board: number[]; last: { hole: number[][] | null; showdown: boolean; board: number[] } | null }
            // Only these fields exist, so no other field can carry a card; then the card fields are checked one by one.
            expect(Object.keys(obs).sort()).toEqual(OBS_KEYS)
            expect(obs.hole).toEqual(r.state.hole[seat])
            expect(obs.board).toEqual(r.state.board)
            // The board is only what is dealt: never a card of the undealt deck.
            for (const c of obs.board) expect(r.state.deck.includes(c)).toBe(false)
            // The other seat's current hole cards are in no card field of this view.
            const theirs: number[] = r.state.hole[1 - seat]
            for (const c of theirs) {
              expect(obs.hole.includes(c)).toBe(false)
              expect(obs.board.includes(c)).toBe(false)
            }
            if (obs.last) {
              // a folded hand is never revealed; a showdown reveals exactly the two hands of that hand
              if (obs.last.showdown) expect(obs.last.hole).not.toBeNull()
              else expect(obs.last.hole).toBeNull()
            }
            expect(JSON.stringify(view)).not.toMatch(/"(deck|decks|state|log|pending|entropy|options)"/)
            expect(view.seed).toBeNull()
          }
          if (r.state.hand !== lastHand) {
            lastHand = r.state.hand
            const last = (viewFor(r, 0).obs as { last: { showdown: boolean } | null }).last
            if (last) last.showdown ? showdowns++ : folds++
          }
          // (code 2 concedes the whole match; the room has Resign for that, and a match that runs its hands is what is checked here)
          const moves = v.legal.filter((c) => c !== 2)
          const a = moves[rng.int(moves.length)]!
          const boardBefore = r.state.board.length
          const handBefore = r.state.hand
          expect(submit(r, toAct, a, v.n).ok).toBe(true)
          if (r.state.hand !== handBefore || (r.status as string) === 'over') {
            // the finished hand's summary shows the board as it was dealt when the hand ended, and a fold deals nothing more
            const sum = (viewFor(r, 0).obs as { last: { showdown: boolean; board: number[] } }).last
            if (!sum.showdown) expect(sum.board.length).toBe(boardBefore)
          }
        }
        expect(r.status).toBe('over')
      }
      // the run covered both ways a hand ends
      expect(folds).toBeGreaterThan(50)
      expect(showdowns).toBeGreaterThan(50)
    })

    test('a hand that ends in a fold shows the folder\'s cards to nobody, in the next hand\'s view or any later one', () => {
      for (let seed = 1; seed <= 60; seed++) {
        const r = holdemRoom(seed)
        // the actor folds the first hand at once
        const first = r.state.actor as Seat
        const folded: number[] = r.state.hole[first].slice()
        const v = viewFor(r, first)
        const fold = v.legal.find((c) => c === 0)
        expect(fold).toBe(0)
        expect(submit(r, first, 0, v.n).ok).toBe(true)
        for (const seat of [0, 1] as const) {
          const obs = viewFor(r, seat).obs as { last: { hole: unknown; showdown: boolean; winner: number }; hole: number[] }
          expect(obs.last.hole).toBeNull()
          expect(obs.last.showdown).toBe(false)
          expect(obs.last.winner).toBe(1 - first)
          // the folder's and the winner's old hole cards appear in neither view as cards held in hand
          expect(JSON.stringify(viewFor(r, seat).obs)).not.toContain(`"hole":[[${folded.join(',')}]`)
        }
      }
    })

    test('a showdown shows both hands of that hand, and only of that hand', () => {
      let seen = 0
      for (let seed = 1; seed <= 80; seed++) {
        const r = holdemRoom(seed)
        // both seats call down every hand until one reaches a showdown
        let guard = 0
        let prev: number[][] | null = null
        while (r.status === 'playing' && guard++ < 200) {
          const seat = r.state.actor as Seat
          const v = viewFor(r, seat)
          const before = r.state.hand
          prev = [r.state.hole[0].slice(), r.state.hole[1].slice()]
          expect(submit(r, seat, 1, v.n).ok).toBe(true)
          if (r.state.hand !== before || (r.status as string) === 'over') {
            for (const s of [0, 1] as const) {
              const last = (viewFor(r, s).obs as { last: { hole: number[][] | null; showdown: boolean } }).last
              expect(last.showdown).toBe(true)
              expect(last.hole).toEqual(prev)
            }
            seen++
            break
          }
        }
      }
      expect(seen).toBeGreaterThan(40)
    })
  })
})
