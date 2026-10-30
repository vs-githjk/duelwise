import { Chess } from 'chess.js'
import type { GameCore, Result, Seat } from '../../types'
import { hashState } from '../../hash'
import { legalUci } from './legal'
import { decodeAbs, encodeAbs } from './policy-index'

/** Immutable chess state: the FEN plus the position keys seen since the last capture or pawn move. */
export interface ChessState {
  fen: string
  /** First four FEN fields of every position since the last irreversible move; the last is the current one. */
  keys: string[]
}

/** A move as a UCI string; queen promotions have no suffix (see policy-index.ts). */
export type ChessAction = string

export interface ChessObservation {
  fen: string
  seat: Seat
  /** True when the observer is the seat to act. */
  toMove: boolean
  /** How many times the current position has occurred since the last irreversible move (1 = first time). */
  repeats: number
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const keyOf = (fen: string): string => fen.split(' ', 4).join(' ')

// chess.js objects are mutable; every cached one is only ever read from.
const CACHE_MAX = 256
const cache = new Map<string, Chess>()
function board(fen: string): Chess {
  let c = cache.get(fen)
  if (c) return c
  c = new Chess(fen)
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  cache.set(fen, c)
  return c
}

type Status = { over: false } | { over: true; result: Result }
interface Analysis {
  status: Status
  legal: string[]
}
const DRAW = (reason: string): Result => ({ winner: null, score: [0.5, 0.5], reason })
const analysisCache = new WeakMap<ChessState, Analysis>()

/** Everything derived from a state, computed once: move generation is the expensive part of chess.js. */
function analyze(s: ChessState): Analysis {
  const hit = analysisCache.get(s)
  if (hit) return hit
  assertState(s)
  const c = board(s.fen)
  const moves = legalUci(c)
  let out: Analysis
  if (moves.length === 0) {
    if (c.inCheck()) {
      const winner: Seat = c.turn() === 'w' ? 1 : 0
      out = { status: { over: true, result: { winner, score: winner === 0 ? [1, 0] : [0, 1], reason: 'checkmate' } }, legal: [] }
    } else out = { status: { over: true, result: DRAW('stalemate') }, legal: [] }
  } else if (c.isInsufficientMaterial()) out = { status: { over: true, result: DRAW('insufficient material') }, legal: [] }
  else if (Number.parseInt(s.fen.split(' ')[4] ?? '0', 10) >= 100) out = { status: { over: true, result: DRAW('fifty-move rule') }, legal: [] }
  else if (repeats(s) >= 3) out = { status: { over: true, result: DRAW('threefold repetition') }, legal: [] }
  else out = { status: { over: false }, legal: moves }
  analysisCache.set(s, out)
  return out
}

const status = (s: ChessState): Status => analyze(s).status

function repeats(s: ChessState): number {
  const cur = s.keys[s.keys.length - 1]!
  let n = 0
  for (const k of s.keys) if (k === cur) n++
  return n
}

function assertState(s: ChessState): void {
  if (typeof s?.fen !== 'string') throw new Error('chess: bad state ' + JSON.stringify(s))
}

const seatToMove = (s: ChessState): Seat => {
  assertState(s)
  return s.fen.split(' ', 2)[1] === 'w' ? 0 : 1
}

export const chessCore: GameCore<ChessState, ChessAction, ChessObservation> = {
  id: 'chess',
  version: 'chess-1',
  /** The seed is unused (the start position is fixed); `opts.fen` starts from another position. */
  init(_seed, opts) {
    const fen = typeof opts?.fen === 'string' ? opts.fen : START_FEN
    new Chess(fen) // validates
    return { fen, keys: [keyOf(fen)] }
  },
  toAct: (s) => (status(s).over ? [] : [seatToMove(s)]),
  legal(s, seat) {
    return seat === seatToMove(s) ? analyze(s).legal.slice() : []
  },
  step(s, actions) {
    if (status(s).over) throw new Error('chess: the game is over')
    const seat = seatToMove(s)
    const other = (1 - seat) as Seat
    if (actions[other] !== null && actions[other] !== undefined) throw new Error('chess: only seat ' + seat + ' may act')
    const a = actions[seat]
    if (a === null || a === undefined) throw new Error('chess: missing action for seat ' + seat)
    if (typeof a !== 'string' || a.length < 4 || a.length > 5) throw new Error('chess: bad move ' + JSON.stringify(a))
    const c = board(s.fen)
    const from = a.slice(0, 2)
    const to = a.slice(2, 4)
    let promotion = a.length === 5 ? a[4] : undefined
    if (promotion === undefined && c.get(from as never)?.type === 'p' && (to[1] === '8' || to[1] === '1')) promotion = 'q'
    // Play on the cached board and take the move back, so it is unchanged for the next reader.
    let m: ReturnType<Chess['move']>
    let fen: string
    try {
      m = c.move({ from, to, promotion })
      fen = c.fen()
    } finally {
      if (c.fen() !== s.fen) c.undo()
    }
    const key = keyOf(fen)
    const irreversible = m.piece === 'p' || m.captured !== undefined
    return { fen, keys: irreversible ? [key] : [...s.keys, key] }
  },
  terminal: (s) => status(s).over,
  result(s) {
    const st = status(s)
    return st.over ? st.result : null
  },
  observe(s, seat) {
    return { fen: s.fen, seat, toMove: !status(s).over && seatToMove(s) === seat, repeats: repeats(s) }
  },
  hash: (s) => hashState({ fen: s.fen, keys: s.keys }),
  encodeAction: (a) => encodeAbs(a),
  decodeAction: (n) => decodeAbs(n),
}
