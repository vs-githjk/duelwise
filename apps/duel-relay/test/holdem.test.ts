/**
 * Hold'em with a friend on two devices (M8). The relay deals every hand from decks it draws itself and keeps them in the room's stored
 * options; a seat only ever receives viewFor, so the deck, the other hole cards and a folded hand stay in the room.
 */
import { describe, expect, test } from 'bun:test'
import { FRIEND_HANDS, initMatch } from '@duelwise/core/src/games/holdem/match'
import type { Seat } from '@duelwise/core/src/types'
import { CLOSE, LIMITS, RELAY_GAMES } from '../src/limits'
import { ADA, SAM, act, connect, hostOf, rig, sync, type Rig } from './helpers'

const last = (r: Rig, s: Seat) => r.last[s]

/** Plays the match out taking a random legal action (never concede, which Resign covers) for whoever is to act. Gap in ms between actions. */
async function playOut(r: Rig, gap = 2000, guard = 4000): Promise<number> {
  let acts = 0
  for (let i = 0; i < guard && last(r, 0)?.status !== 'over'; i++) {
    for (const s of [0, 1] as const) {
      await sync(r, s)
      const v = last(r, s)
      if (!v.canAct) continue
      const moves = (v.legal as number[]).filter((c) => c !== 2)
      r.clock.t += gap
      // mostly call or check (showdowns), now and then the first other move (folds and raises)
      await act(r, s, (acts + i) % 5 === 0 ? moves[(acts * 7) % moves.length]! : play(v), v.n)
      acts++
    }
  }
  return acts
}

/** Call or check when it can: hands then run street by street to a showdown, so a match has many actions. */
const play = (v: { legal: number[] }): number => (v.legal.includes(1) ? 1 : v.legal.find((c) => c !== 2)!)

const decksOf = (r: Rig) => (r.host.peek().room!.options as { decks: number[][] }).decks

describe('Hold\'em is a relay game', () => {
  test('it is carried by the relay', () => {
    expect((RELAY_GAMES as readonly string[]).includes('holdem')).toBe(true)
  })

  test('the room is created with a short match and one CSPRNG-drawn permutation per hand', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'holdem'))
    await connect(r, SAM)
    const o = r.host.peek().room!.options as { hands: number; decks: number[][] }
    expect(o.hands).toBe(LIMITS.holdemHands)
    expect(o.decks.length).toBe(o.hands)
    for (const d of o.decks) expect([...d].sort((a, b) => a - b)).toEqual(Array.from({ length: 52 }, (_, i) => i))
    expect(o.hands).toBe(FRIEND_HANDS)
  })
})

describe('Hold\'em on the relay: nothing hidden reaches a seat', () => {
  test('a whole match: no frame before the end carries decks, options, the seed or the other seat\'s hole cards', async () => {
    const r = rig({ hostSeat: 1 })
    await connect(r, hostOf(ADA, 'holdem'))
    await connect(r, SAM)
    const decks = decksOf(r).map((d) => d.slice())
    const acts = await playOut(r)
    expect(acts).toBeGreaterThan(20)
    for (const s of [0, 1] as const) expect(last(r, s).status).toBe('over')
    let showdowns = 0
    let folds = 0
    for (const s of [0, 1] as const) {
      const views = r.frames[s].map((f) => JSON.parse(f)).filter((f) => f.t === 'view')
      for (const v of views) {
        if (v.status !== 'over') {
          expect(v.seed).toBeNull()
          expect(JSON.stringify(v)).not.toMatch(/"(decks?|options|entropy|state|log|pending)"/)
        }
        expect(v.obs.hole.length).toBe(2)
        // this seat's hole cards are the ones the room dealt it for that hand: top of decks[hand], never the other seat's
        const d = decks[v.obs.hand]
        if (d) {
          const button = v.obs.hand % 2
          const mine = s === button ? [d[50], d[48]] : [d[51], d[49]]
          const theirs = s === button ? [d[51], d[49]] : [d[50], d[48]]
          expect(v.obs.hole).toEqual(mine)
          expect(v.obs.hole).not.toEqual(theirs)
          // a hand still in progress shows none of the undealt deck: the board is the first dealt cards only
          const dealt = d.slice(0, 48).reverse()
          expect(v.obs.board).toEqual(dealt.slice(0, v.obs.board.length))
        }
        const sum = v.obs.last
        if (sum) {
          sum.showdown ? showdowns++ : folds++
          if (!sum.showdown) expect(sum.hole).toBeNull()
          if (sum.showdown) {
            const d = decks[sum.hand]!
            const button = sum.hand % 2
            const holes = [0, 1].map((seat) => (seat === button ? [d[50], d[48]] : [d[51], d[49]]))
            expect(sum.hole).toEqual(holes)
          }
        }
      }
    }
    expect(showdowns + folds).toBeGreaterThan(5)
  })

  test('a folded hand\'s cards are in no frame of the seat that did not fold, and the seed shown at the end does not deal the match', async () => {
    const r = rig({ hostSeat: 0 })
    await connect(r, hostOf(ADA, 'holdem'))
    await connect(r, SAM)
    const decks = decksOf(r).map((d) => d.slice())
    const seed = r.host.peek().room!.seed
    // seat 0 is the button in hand 0 and acts first: it folds at once.
    const v0 = last(r, 0)
    expect(v0.canAct).toBe(true)
    await act(r, 0, 0, v0.n)
    const folderHole = [decks[0]![50], decks[0]![48]]
    const winnerFrames = r.frames[1].map((f) => JSON.parse(f)).filter((f) => f.t === 'view')
    for (const v of winnerFrames) {
      expect(JSON.stringify(v.obs.hole)).not.toBe(JSON.stringify(folderHole))
      if (v.obs.last) expect(v.obs.last.hole).toBeNull()
    }
    await playOut(r)
    const over = last(r, 0)
    expect(over.seed).toBe(seed)
    // the seed is public at the end; it must not be able to rebuild the cards that were dealt
    expect(initMatch(seed, { hands: LIMITS.holdemHands }).hole).not.toEqual(initMatch(seed, { hands: LIMITS.holdemHands, decks }).hole)
  })

  test('a rematch is dealt from fresh decks and the sides swap', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'holdem'))
    await connect(r, SAM)
    const first = decksOf(r).map((d) => d.join(','))
    await playOut(r)
    r.take(await r.msg(0, JSON.stringify({ t: 'rematch' })))
    r.take(await r.msg(1, JSON.stringify({ t: 'rematch' })))
    const second = decksOf(r).map((d) => d.join(','))
    expect(second.length).toBe(LIMITS.holdemHands)
    expect(second.some((d) => first.includes(d))).toBe(false)
    expect(last(r, 0).status).toBe('playing')
    expect(last(r, 0).obs.hand).toBe(0)
  })

  test('a relay that wakes mid-match rebuilds the same deals and plays on', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'holdem'))
    await connect(r, SAM)
    const decks = decksOf(r).map((d) => d.join(','))
    for (let i = 0; i < 12; i++) {
      for (const s of [0, 1] as const) {
        await sync(r, s)
        const v = last(r, s)
        if (v.canAct) {
          r.clock.t += 1500
          await act(r, s, play(v), v.n)
        }
      }
    }
    const handNow = last(r, 0).obs.hand
    r.wake()
    await sync(r, 0)
    expect(decksOf(r).map((d) => d.join(','))).toEqual(decks)
    expect(last(r, 0).obs.hand).toBe(handNow)
    await playOut(r)
    expect(last(r, 1).status).toBe('over')
  })
})

describe('a long Hold\'em match: reconnect, idle expiry and the write budget', () => {
  test('a whole match with a pause of 10 minutes between hands never goes idle, and a drop and return in the middle keeps the seat', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'holdem'))
    await connect(r, SAM)
    let acts = 0
    let dropped = false
    for (let i = 0; i < 4000 && last(r, 0)?.status !== 'over'; i++) {
      for (const s of [0, 1] as const) {
        await sync(r, s)
        const v = last(r, s)
        if (!v.canAct) continue
        // ten minutes of thinking every ten actions: under the idle limit each time, well over it in total, inside the room life
        r.clock.t += acts % 10 === 0 ? 10 * 60_000 : 2000
        expect(await r.host.alarm()).toEqual([])
        if (!dropped && acts === 10) {
          // a phone loses signal and comes back: the same person gets the same seat and the live view
          dropped = true
          const who = r.host.peek().room!.seats[s]!.ref === ADA.ref ? ADA : SAM
          r.live.delete(who.ref)
          r.take(await r.host.disconnect(who.ref))
          const back = await connect(r, who)
          expect(back).toMatchObject({ ok: true, seat: s })
          expect(last(r, s).canAct).toBe(true)
        }
        await act(r, s, play(v), v.n)
        acts++
      }
    }
    expect(last(r, 0).status).toBe('over')
    expect(r.clock.t - 1_700_000_000_000).toBeGreaterThan(LIMITS.idleMs * 2)
    expect(r.host.peek().room).not.toBeNull()
  })

  test('twenty idle minutes mid-match close the room', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'holdem'))
    await connect(r, SAM)
    await sync(r, 0)
    const v = last(r, 0).canAct ? last(r, 0) : last(r, 1)
    const seat: Seat = last(r, 0).canAct ? 0 : 1
    await act(r, seat, play(v), v.n)
    r.clock.t += LIMITS.idleMs + 1
    const outs = await r.host.alarm()
    expect(outs.some((o) => o.kind === 'close' && o.code === CLOSE.expired)).toBe(true)
  })

  test('one match, played at a human pace, stays far inside the room\'s write budget', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'holdem'))
    await connect(r, SAM)
    await playOut(r, 2500)
    expect(r.store.puts + r.store.alarms).toBeLessThan(LIMITS.reserveRows)
  })
})
