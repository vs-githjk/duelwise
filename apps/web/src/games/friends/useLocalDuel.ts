import { useCallback, useRef, useState } from 'react'
import { createRoom, join, resign as resignRoom, submit, viewFor, voteRematch, type DuelRoom, type DuelView } from '@duelwise/core/src/duel'
import type { GameCore, Seat } from '@duelwise/core/src/types'

/**
 * Two people, one device. The room core (packages/core/src/duel) runs in the page and both seats are played by whoever holds the
 * phone: nothing here starts a rated match, finishes one, uploads one or reads the server. A friend game is never rated, never
 * stored and never trained on (decisions.md, Nov 9 and Nov 10), so this file imports no recorder, no server function and no storage.
 */

/** Room refs for the two people, who keep them across a rematch even though the sides swap. */
export const PLAYER_ONE = 'p1'
export const PLAYER_TWO = 'p2'

export interface LocalSetup {
  /** Player one, player two. Already trimmed; blanks are filled by `normalizeNames`. */
  names: [string, string]
  /** The game seat player one takes at the start: 0 moves first, or a coin flip. */
  side: 'random' | Seat
  /** Turn the board to face whoever is to move (chess). */
  flip: boolean
}

/** Where a duel gets its randomness: a game seed and a coin. Injected so tests are deterministic. */
export interface Entropy {
  seed(): number
  coin(): 0 | 1
}

export const browserEntropy: Entropy = {
  seed: () => crypto.getRandomValues(new Uint32Array(1))[0]!,
  coin: () => (crypto.getRandomValues(new Uint8Array(1))[0]! & 1) as 0 | 1,
}

export interface LocalDuel<S> {
  room: DuelRoom<S>
  core: GameCore<S, any, any>
  flip: boolean
}

const NAME_MAX = 24

/** Trims, collapses spaces, falls back to "Player 1" or "Player 2", and tells two equal names apart ("Sam", "Sam 2"). */
export function normalizeNames(names: [string, string]): [string, string] {
  const clean = (n: string, i: number) => n.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim() || `Player ${i + 1}`
  const a = clean(names[0], 0)
  let b = clean(names[1], 1)
  if (b.toLowerCase() === a.toLowerCase()) b = `${b.slice(0, NAME_MAX - 2)} 2`
  return [a, b]
}

export function startLocalDuel<S>(core: GameCore<S, any, any>, setup: LocalSetup, entropy: Entropy = browserEntropy): LocalDuel<S> {
  const [one, two] = normalizeNames(setup.names)
  const oneSeat: Seat = setup.side === 'random' ? entropy.coin() : setup.side
  const room = createRoom(core, entropy.seed(), { ref: PLAYER_ONE, name: one, connected: true }, oneSeat)
  join(room, { ref: PLAYER_TWO, name: two, connected: true })
  return { room, core, flip: setup.flip }
}

/** The seat whose turn it is; after the game, the seat that moved last (or White when no move was made). */
export function moverOf<S>(d: LocalDuel<S>): Seat {
  const t = d.core.toAct(d.room.state)[0]
  if (t !== undefined) return t
  const last = d.room.log[d.room.log.length - 1]
  return last ? last[1] : 0
}

/**
 * The seat whose pick the room is waiting for, or null when the game is over. In a turn game that is the seat to move; in a simultaneous game it is the
 * lowest seat that has not picked yet (seat 0 picks first, then seat 1). Reads only who has picked, never what was picked.
 */
export function pickerOf<S>(d: LocalDuel<S>): Seat | null {
  if (d.room.status !== 'playing') return null
  for (const s of d.core.toAct(d.room.state)) if (d.room.pending[s] === null) return s
  return null
}

/** The seat whose side sits at the bottom of the board: the seat to move when the board turns, else seat 0 (White) always. */
export function facing<S>(d: LocalDuel<S>): Seat {
  return d.flip && d.room.status === 'playing' ? moverOf(d) : 0
}

export function localView<S>(d: LocalDuel<S>, seat: Seat = moverOf(d)): DuelView {
  return viewFor(d.room, seat, d.core)
}

/** The seat to move plays `action` (an encoded action). Returns the room's verdict. */
export function playLocal<S>(d: LocalDuel<S>, action: number): ReturnType<typeof submit> {
  return submit(d.room, moverOf(d), action, d.room.n, d.core)
}

/** A named seat submits an encoded action: the seat the room is waiting for (`pickerOf`) and no other. For simultaneous games, where two seats pick in turn behind a curtain. */
export function playAs<S>(d: LocalDuel<S>, seat: Seat, action: number): ReturnType<typeof submit> {
  return submit(d.room, seat, action, d.room.n, d.core)
}

/** The player to move gives up. */
export function resignLocal<S>(d: LocalDuel<S>): void {
  resignRoom(d.room, moverOf(d))
}

/** Both people say yes on the one device. The sides swap. */
export function rematchLocal<S>(d: LocalDuel<S>, entropy: Entropy = browserEntropy): boolean {
  const seed = entropy.seed()
  voteRematch(d.room, 0, seed, d.core)
  return voteRematch(d.room, 1, seed, d.core)
}

/** Wins by person (not by seat, which swaps every game), and draws. */
export function tallyOf<S>(d: LocalDuel<S>): { one: number; two: number; draws: number } {
  const t = { one: 0, two: 0, draws: 0 }
  for (const g of d.room.series) {
    if (g.winner === null) t.draws++
    else if (g.winner === PLAYER_ONE) t.one++
    else t.two++
  }
  return t
}

/** The seat a person sits in right now. */
export function seatOfPlayer<S>(d: LocalDuel<S>, ref: typeof PLAYER_ONE | typeof PLAYER_TWO): Seat {
  return d.room.seats[0]?.ref === ref ? 0 : 1
}

export interface LocalDuelApi<S> {
  duel: LocalDuel<S>
  /** Bumps on every change, so a memo can depend on the room (which is mutated in place). */
  version: number
  /** Applies an encoded action for the seat to move. False when the room refuses it. */
  play(action: number): boolean
  /** Applies an encoded action for a named seat (simultaneous games). False when the room refuses it. */
  playAs(seat: Seat, action: number): boolean
  /** The seat to resign for, named (the person holding the device behind the curtain). */
  resignAs(seat: Seat): void
  resign(): void
  /** Both people say yes; the sides swap. */
  rematch(): void
  setFlip(flip: boolean): void
}

/**
 * React's side of `LocalDuel`: the room is made on first render from `setup` and lives in a ref (the room core mutates it in place); a counter
 * re-renders on every change. A new game is a new mount, so leaving and starting again are the parent's switch, not this hook's.
 */
export function useLocalDuel<S>(core: GameCore<S, any, any>, setup: LocalSetup, entropy: Entropy = browserEntropy): LocalDuelApi<S> {
  const ref = useRef<LocalDuel<S> | null>(null)
  if (ref.current === null) ref.current = startLocalDuel(core, setup, entropy)
  const [version, setVersion] = useState(0)
  const bump = () => setVersion((v) => v + 1)
  const play = useCallback((action: number) => {
    const r = playLocal(ref.current!, action)
    if (r.ok) bump()
    return r.ok
  }, [])
  const playAs_ = useCallback((seat: Seat, action: number) => {
    const r = playAs(ref.current!, seat, action)
    if (r.ok) bump()
    return r.ok
  }, [])
  const resignAs = useCallback((seat: Seat) => {
    resignRoom(ref.current!.room, seat)
    bump()
  }, [])
  const resign = useCallback(() => {
    resignLocal(ref.current!)
    bump()
  }, [])
  const rematch = useCallback(() => {
    rematchLocal(ref.current!, entropy)
    bump()
  }, [entropy])
  const setFlip = useCallback((flip: boolean) => {
    ref.current!.flip = flip
    bump()
  }, [])
  return { duel: ref.current, version, play, playAs: playAs_, resignAs, resign, rematch, setFlip }
}
