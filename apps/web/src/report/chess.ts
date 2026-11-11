import { Chess } from 'chess.js'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import type { Seat } from '@duelwise/core/src/types'
import type { Moment, Series } from './types'
import { isHumanLoss, nearMiss, NOT_CLOSE, type NearMiss } from './near-miss'
import { walk } from './walk'

/** Evaluation of a position in the unit of its evaluator, from White's side. */
export type ChessEval = (fen: string) => number

export interface ChessEvaluator {
  kind: 'value-net' | 'material'
  eval: ChessEval
  /** A swing at least this big, against the mover, is called a blunder. */
  blunder: number
  /** What one unit means, for the chart caption. */
  unit: string
  /** Plies the evaluator already looks ahead: 1 means its score does not see the reply (a material count). */
  searched: 1 | 2
}

const PIECE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 }
export const MATE_VALUE = 10

/** Material count in pawns, White minus Black. The fallback when no value net can be loaded. */
export function materialEval(fen: string): number {
  let sum = 0
  for (const ch of fen.split(' ', 1)[0]!) {
    const v = PIECE[ch.toLowerCase()]
    if (v) sum += ch === ch.toUpperCase() ? v : -v
  }
  return sum
}

export const MATERIAL: ChessEvaluator = { kind: 'material', eval: materialEval, blunder: 1.5, unit: 'pawns of material', searched: 1 }

const clamp = (v: number): number => Math.max(-MATE_VALUE, Math.min(MATE_VALUE, v))

/** Mate and stalemate are exact, whatever the evaluator thinks. */
function score(ev: ChessEvaluator, fen: string, game: Chess): number {
  if (game.isCheckmate()) return game.turn() === 'w' ? -MATE_VALUE : MATE_VALUE
  if (game.isDraw() || game.isStalemate()) return 0
  return clamp(ev.eval(fen))
}

function toMove(game: Chess, uci: string) {
  return game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' })
}

const fmt = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
const abs1 = (v: number): string => Math.abs(v).toFixed(1)
const moveLabel = (ply: number, san: string, mark = ''): string => `${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? '.' : '...'} ${san}${mark}`

export interface ChessPly {
  ply: number
  seat: Seat
  san: string
  /** Evaluation before and after the move, from White's side. */
  before: number
  after: number
  /** Change for the mover, measured after the opponent's reply: positive is good for whoever moved. */
  delta: number
  fenBefore: string
}

export interface ChessAnalysis {
  plies: ChessPly[]
  /** Points of the chart, from the human's side. */
  humanSide: number[]
  evaluator: ChessEvaluator
}

/** Walks the record and scores every position. Cost: one evaluation per half-move. */
export function analyseChess(rec: MatchRecordV1, ev: ChessEvaluator): ChessAnalysis {
  const steps = walk<{ fen: string }, string>(rec)
  const plies: ChessPly[] = []
  const sign = rec.humanSeat === 0 ? 1 : -1
  const humanSide: number[] = []
  const startGame = steps[0] ? new Chess(steps[0].before.fen) : null
  let prev = startGame ? score(ev, steps[0]!.before.fen, startGame) : 0
  steps.forEach((st, ply) => {
    const m = st.moves[0]!
    const g = new Chess(st.before.fen)
    const san = toMove(g, m.action).san
    const after = score(ev, st.after.fen, g)
    const moverSign = m.seat === 0 ? 1 : -1
    plies.push({ ply, seat: m.seat, san, before: prev, after, delta: (after - prev) * moverSign, fenBefore: st.before.fen })
    humanSide.push(after * sign)
    prev = after
  })
  // A move is judged after the reply: a hung piece shows up in the opponent's capture, not in the move itself.
  plies.forEach((p, i) => {
    const moverSign = p.seat === 0 ? 1 : -1
    p.delta = ((plies[i + 1]?.after ?? p.after) - p.before) * moverSign
  })
  return { plies, humanSide, evaluator: ev }
}

/**
 * The move that holds the most against the best reply (two plies of lookahead), when it clearly
 * beats the move that was played. Null when nothing does.
 */
export function betterMove(ply: ChessPly, ev: ChessEvaluator): string | null {
  const base = new Chess(ply.fenBefore)
  const moverSign = ply.seat === 0 ? 1 : -1
  // An evaluator that already searches the reply is asked once per candidate; a static one needs the reply tried here.
  const lookahead = ev.searched === 2 ? 1 : 2
  const playedValue = lookahead === 1 ? ply.after * moverSign : ply.before * moverSign + ply.delta
  let best: { san: string; v: number } | null = null
  for (const mv of base.moves({ verbose: true })) {
    const g = new Chess(ply.fenBefore)
    const played = g.move(mv)
    let worst = score(ev, g.fen(), g) * moverSign
    if (lookahead === 2) {
      worst = Infinity
      const replies = g.moves({ verbose: true })
      if (replies.length === 0) worst = score(ev, g.fen(), g) * moverSign
      for (const r of replies) {
        const h = new Chess(g.fen())
        h.move(r)
        worst = Math.min(worst, score(ev, h.fen(), h) * moverSign)
      }
    }
    if (!best || worst > best.v) best = { san: played.san, v: worst }
  }
  return best && best.san !== ply.san && best.v > playedValue + 0.5 ? best.san : null
}

export interface ChessReport {
  moments: Moment[]
  series: Series
  blunders: number
  humanMoves: number
  /** Facts the persona reaction line is built from. */
  facts: { bestTurn: string | null; worstTurn: string | null; aiMiss: string | null; alt: string | null; swingTurn: string | null; lastMoveNumber: number }
}

export function chessReport(rec: MatchRecordV1, a: ChessAnalysis, reason: string): ChessReport {
  const human = a.plies.filter((p) => p.seat === rec.humanSeat)
  const ai = a.plies.filter((p) => p.seat !== rec.humanSeat)
  const ev = a.evaluator
  const moments: Moment[] = []
  const marks: Series['marks'] = []
  const used = new Set<number>()

  const best = human.reduce<ChessPly | null>((b, p) => (p.delta >= ev.blunder / 2 && (!b || p.delta > b.delta) ? p : b), null)
  const worst = human.reduce<ChessPly | null>((b, p) => (p.delta <= -ev.blunder && (!b || p.delta < b.delta) ? p : b), null)
  const aiMiss = ai.reduce<ChessPly | null>((b, p) => (p.delta <= -ev.blunder && (!b || p.delta < b.delta) ? p : b), null)

  const push = (p: ChessPly, kind: 'best' | 'worst' | 'turning', mark: string, tag: string, text: string, publicText?: string) => {
    used.add(p.ply)
    moments.push({ kind, label: moveLabel(p.ply, p.san, mark), tag, text, publicText, value: fmt(p.delta), valueLabel: 'score swing' })
    marks.push({ at: p.ply, label: moveLabel(p.ply, p.san, mark), kind })
  }
  if (best) push(best, 'best', '!', 'best move', `Your biggest gain: the position score moved ${fmt(best.delta)} your way.`, `The player's biggest gain: the position score moved ${fmt(best.delta)} their way.`)
  if (worst) {
    const alt = betterMove(worst, ev)
    push(worst, 'worst', '?', 'worst move', alt ? `This cost you ${abs1(worst.delta)}. ${alt} held more.` : `This cost you ${abs1(worst.delta)}.`,
      alt ? `This cost the player ${abs1(worst.delta)}. ${alt} held more.` : `This cost the player ${abs1(worst.delta)}.`)
  }
  // The turning point: the half-move after which the human's side changed from behind to ahead, or the biggest single swing of either side.
  const swing = a.plies.reduce<ChessPly | null>((b, p) => (!used.has(p.ply) && Math.abs(p.delta) >= ev.blunder && (!b || Math.abs(p.delta) > Math.abs(b.delta)) ? p : b), null)
  if (swing) {
    const mine = swing.seat === rec.humanSeat
    push(swing, 'turning', mine ? '!' : '?', 'turning point', mine ? `You moved the position score by ${abs1(swing.delta)} here.` : `The AI moved the position score by ${abs1(swing.delta)} here.`,
      mine ? `The player moved the position score by ${abs1(swing.delta)} here.` : undefined)
  }
  moments.sort((x, y) => (marks.find((m) => m.label === x.label)?.at ?? 0) - (marks.find((m) => m.label === y.label)?.at ?? 0))

  const last = a.plies[a.plies.length - 1]
  if (last) moments.push({ kind: 'end', label: moveLabel(last.ply, last.san), tag: 'last move', text: reason, value: undefined })
  const alt = worst ? betterMove(worst, ev) : null
  return {
    moments,
    series: { label: 'Position score after each move, from your side', publicLabel: "Position score after each move, from the player's side", unit: ev.unit, points: a.humanSide, marks },
    blunders: human.filter((p) => p.delta <= -ev.blunder).length,
    humanMoves: human.length,
    facts: {
      bestTurn: best ? moveLabel(best.ply, best.san, '!') : null,
      worstTurn: worst ? moveLabel(worst.ply, worst.san, '?') : null,
      aiMiss: aiMiss ? moveLabel(aiMiss.ply, aiMiss.san) : null,
      alt,
      swingTurn: swing ? moveLabel(swing.ply, swing.san) : null,
      lastMoveNumber: last ? Math.floor(last.ply / 2) + 1 : 0,
    },
  }
}

/** A chess loss is only called close when it was lost after at least this many of the player's own moves: nothing is "almost" in the opening. */
export const NEAR_MISS_MIN_MOVES = 8

/**
 * The near miss of a lost game, from the position scores the report already charts. The turning point is the player's move with the
 * biggest drop in position score (at least a blunder by the evaluator's own measure), and the game is close only when the position was
 * still level or better for the player right before that move and it came after the opening. Otherwise the loss is not close.
 */
export function chessNearMiss(rec: MatchRecordV1, a: ChessAnalysis): NearMiss | null {
  if (!isHumanLoss(rec)) return null
  const ev = a.evaluator
  const sign = rec.humanSeat === 0 ? 1 : -1
  const mine = a.plies.filter((p) => p.seat === rec.humanSeat)
  // A move only counts as a slip if it still cost a blunder after the player's own next move: a trade (the capture and then the recapture)
  // looks like a loss until the recapture, and must not be named. `held` is the drop measured over those three half-moves.
  const settled = (p: ChessPly): number => {
    const next = a.plies[p.ply + 2]
    return next ? (next.after - p.before) * (p.seat === 0 ? 1 : -1) : p.delta
  }
  const slip = mine.reduce<ChessPly | null>((b, p) => (p.delta <= -ev.blunder && settled(p) <= -ev.blunder && (!b || settled(p) < settled(b)) ? p : b), null)
  if (!slip) return NOT_CLOSE
  const level = ev.blunder / 2
  const before = slip.before * sign
  const myMovesBefore = mine.filter((p) => p.ply < slip.ply).length
  if (myMovesBefore < NEAR_MISS_MIN_MOVES || before < -level) return NOT_CLOSE
  const after = before + settled(slip)
  const label = moveLabel(slip.ply, slip.san)
  const n = Math.floor(slip.ply / 2) + 1
  const alt = betterMove(slip, ev)
  const kept = alt ? ` ${alt} held more.` : ''
  const held = a.plies.filter((p) => p.ply < slip.ply && p.seat === rec.humanSeat && a.humanSide[p.ply]! >= -level).length
  const state = before >= level ? 'ahead' : 'level'
  return nearMiss(true, {
    turning: `${label} was where it turned: your position score went from ${fmt(before)} to ${fmt(after)}.${kept}`,
    publicTurning: `${label} was where it turned: the player's position score went from ${fmt(before)} to ${fmt(after)}.${kept}`,
    line: `Right before move ${n} you were ${state}.`,
    publicLine: `Right before move ${n} the player was ${state}.`,
    stats: [
      { label: 'Moves level or ahead', value: held },
      { label: 'Moves played after the slip', value: mine.filter((p) => p.ply > slip.ply).length },
    ],
  })
}
