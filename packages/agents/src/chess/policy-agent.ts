// Easy, Medium and Hard: a Maia-style policy net trained on human games of one rating band picks the move.
// The net scores every move index; only legal moves are kept, then the move is sampled at the level's
// temperature (1 = as the humans of that band choose, 0 = the single most likely move), optionally
// cut to a nucleus (topP), after the tactical guard (guard.ts) has played a mate in one or dropped a hanging move.

import { chessPlaneEncoder, PLANES } from '@duelwise/core/src/games/chess/encode'
import { encodeAbs, relEncode } from '@duelwise/core/src/games/chess/policy-index'
import type { ChessObservation } from '@duelwise/core/src/games/chess/core'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { Agent } from '../agent-types'
import { OrtSession, type OrtSessionOpts } from '../runtime/ort-session'
import { BLACK, Board, moveToUci } from './board'
import { findMateInOne, nucleus, safeMoves } from './guard'
import { nonRepeatingMoves } from './repetition'
import type { ChessState } from '@duelwise/core/src/games/chess/core'
import type { ValueNet } from './value-eval'

export type PolicyBand = 'b1100' | 'b1500' | 'b1900' | 'b2200'

export interface PolicyConfig {
  band: PolicyBand
  /** 0 plays the most likely legal move. */
  temperature: number
  /** Seeded variety: only moves whose logit is within this much of the best can be drawn, weighted by softmax (also when temperature is 0). Unset or 0: off. */
  logitMargin?: number
  /** Nucleus sampling: only the most likely moves covering this much probability can be drawn (1 or unset: all). */
  topP?: number
  /** Tactical guard: 'mate' always plays a mate in one; 'material' also drops moves that lose guardMargin (default 3) points or more (guard.ts). */
  guard?: 'mate' | 'material'
  /** With the 'material' guard: a move is dropped when it loses this many points or more (default 3). */
  guardMargin?: number
}

/** Probabilities over the legal moves from their logits. temperature 0 puts everything on the first maximum, unless a
 *  positive `margin` is given: then moves within `margin` logits of the best share the mass by softmax and the rest get none. */
export function movePolicy(logits: ArrayLike<number>, indices: readonly number[], temperature: number, margin = 0): Float64Array {
  const p = new Float64Array(indices.length)
  if (indices.length === 0) return p
  let best = 0
  for (let i = 1; i < indices.length; i++) if (logits[indices[i]!]! > logits[indices[best]!]!) best = i
  if (temperature <= 0 && margin <= 0) {
    p[best] = 1
    return p
  }
  const t = temperature <= 0 ? 1 : temperature
  const top = logits[indices[best]!]!
  let sum = 0
  for (let i = 0; i < indices.length; i++) {
    if (margin > 0 && top - logits[indices[i]!]! > margin) continue
    p[i] = Math.exp((logits[indices[i]!]! - top) / t)
    sum += p[i]!
  }
  for (let i = 0; i < p.length; i++) p[i]! /= sum
  return p
}

export function sampleIndex(p: Float64Array, rng: Rng): number {
  let r = rng.float()
  for (let i = 0; i < p.length; i++) {
    r -= p[i]!
    if (r < 0) return i
  }
  // Rounding left a sliver: take the last move that has any weight.
  for (let i = p.length - 1; i >= 0; i--) if (p[i]! > 0) return i
  return 0
}

export async function createPolicyAgent(
  config: PolicyConfig,
  modelBytes: Uint8Array,
  opts: { seat?: 0 | 1; ort?: OrtSessionOpts; value?: ValueNet } = {},
): Promise<Agent> {
  const session = await OrtSession.create(modelBytes, opts.ort)
  let seat = opts.seat ?? 1
  let rng = makeRng(0)
  const planes = new Float32Array(PLANES * 64)
  return {
    reset(seed, forSeat) {
      if (forSeat !== undefined) seat = forSeat
      // Mixing in the seat keeps two agents of one level from drawing the same random numbers.
      rng = makeRng((seed ^ Math.imul(seat + 1, 0x9e3779b1)) | 0)
    },
    async act(obs, state) {
      const o = obs as ChessObservation
      const board = Board.fromFen(o.fen)
      // Clearly ahead: never walk back into a position already seen in this game (the draw by repetition).
      const keys = (state as ChessState | undefined)?.keys
      let moves = nonRepeatingMoves(board, board.legalMoves(), keys ? keys.slice(0, -1) : undefined, opts.value)
      if (moves.length === 0) throw new Error('chess policy agent: no legal move in ' + o.fen)
      if (config.guard) {
        const mate = findMateInOne(board, moves)
        if (mate !== null) return [encodeAbs(moveToUci(mate))]
        if (config.guard === 'material') moves = safeMoves(board, moves, config.guardMargin ?? 3)
      }
      const legal = moves.map(moveToUci)
      chessPlaneEncoder.encode(o, planes, 0)
      const out = await session.run('input', planes, [1, PLANES, 8, 8])
      const logits = out['out0']!
      const turn = board.side === BLACK ? 'b' : 'w'
      const idx = legal.map((u) => relEncode(u, turn))
      const p = nucleus(movePolicy(logits, idx, config.temperature, config.logitMargin ?? 0), config.topP ?? 1)
      return [encodeAbs(legal[sampleIndex(p, rng)]!)]
    },
    dispose() {
      void session.dispose()
    },
  }
}
