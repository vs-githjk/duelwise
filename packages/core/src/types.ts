import type { GameId, Level } from './product'

export type Seat = 0 | 1

export interface Result {
  winner: Seat | null
  score: [number, number]
  reason: string
}

export interface GameCore<S, A, O> {
  id: GameId
  version: string
  /** `ctx` is what a record carries besides its options: the opponent's level, for a game whose sim holds per-level limits (Glasscut's mallet). */
  init(seed: number, opts?: Record<string, unknown>, ctx?: { level?: Level }): S
  /** Realtime: both seats every frame. */
  toAct(s: S): Seat[]
  /** Realtime returns []. */
  legal(s: S, seat: Seat): A[]
  /** Pure and deterministic. */
  step(s: S, actions: [A | null, A | null]): S
  terminal(s: S): boolean
  result(s: S): Result | null
  /** Hides hidden information. */
  observe(s: S, seat: Seat): O
  /** 16 hex chars, FNV-1a 64 over a canonical encoding. */
  hash(s: S): string
  encodeAction(a: A): number
  decodeAction(n: number): A
}

export interface FeatureEncoder<O> {
  shape: number[]
  encode(o: O, out: Float32Array, offset: number): void
}

export interface Rng {
  nextU32(): number
  float(): number
  int(n: number): number
  state(): Uint32Array
}
