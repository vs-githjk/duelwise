import type { GameId, Level } from '@duelwise/core/src/product'
import type { NearMiss } from './near-miss'

/** One row of "Key moments": a label, one honest sentence, and an optional signed number. */
export interface Moment {
  kind: 'best' | 'worst' | 'turning' | 'end' | 'info'
  /** The move or turn, for example "17. Qh5?" or "Guess 3". */
  label: string
  /** Short tag under the label, for example "worst move". */
  tag: string
  text: string
  /** The same sentence about "the player" instead of "you", for the public view. Absent when `text` needs no change. */
  publicText?: string
  /** Signed swing shown at the right, with its unit in `valueLabel`. */
  value?: string
  valueLabel?: string
}

/** A line chart series: one point per half-move, from the human's side (up is better for the human). */
export interface Series {
  label: string
  /** The label worded about "the player", for the public view. */
  publicLabel: string
  unit: string
  /** What one point is: a half-move (the default, labelled "move n" at the end by halves) or one placement (Crosscurrent), labelled "placement n". */
  axis?: 'placement'
  /** Value after each half-move, index 0 is after move 1. */
  points: number[]
  /** Indexes into `points` that carry a marker, with their labels. */
  marks: Array<{ at: number; label: string; kind: 'best' | 'worst' | 'turning' }>
}

export interface WordRow {
  seat: 'player' | 'ai'
  guess: string
  /** Marker row per guess: 0 absent, 1 present, 2 correct. The AI's letters are never shown before the game ends; the game is over here, so they are. */
  markers: number[]
}

/** Four in a Row: the final position and every drop in order. Absent on reports built before it existed. */
export interface FourView {
  /** Final board, top row first, seven columns: 0 empty, 1 the player's disc, 2 the AI's. */
  cells: Array<Array<0 | 1 | 2>>
  /** Every drop in order, with the column (1 to 7) it went in. */
  drops: Array<{ by: 'player' | 'ai'; column: number }>
}

/** Crosscurrent: the final board from the player's side and the disc counts. Absent on reports built before it existed. */
export interface SlackView {
  /** Final board, 64 cells row by row from the top left (A1): 0 empty, 1 the player's disc, 2 the AI's. */
  cells: Array<0 | 1 | 2>
  /** Final discs: the player's, then the AI's. */
  discs: [number, number]
  /** The corner cells (0, 7, 56, 63) in that order and who placed each, or null where nobody did. */
  corners: Array<'player' | 'ai' | null>
  /** The player's disc colour: dark when they moved first, pale when they moved second. Absent (an older body) means dark. */
  youColor?: 'dark' | 'pale'
}

/** One penalty of a Twelve Yards shootout, from the player's side. */
export interface PenaltyKickRow {
  /** 1-based kick number across the whole shootout. */
  n: number
  /** The round it belongs to (a round is one kick each), and whether that round was sudden death. */
  round: number
  sudden: boolean
  /** True when the player took it; false when the opponent did and the player kept goal. */
  byMe: boolean
  /** Where the shooter aimed (0..8, top left to bottom right) and which way the keeper went (0..4: left high, left low, stay, right high, right low). */
  zone: number
  dive: number
  outcome: 'goal' | 'saved' | 'over' | 'wide'
}

/** Twelve Yards: every kick of the shootout and the final goals. Absent on reports built before it existed. */
export interface PenaltyView {
  kicks: PenaltyKickRow[]
  /** Goals: the player's, then the opponent's. */
  goals: [number, number]
  /** Whether the player kicked first. */
  youFirst: boolean
  /** The shootout went past five kicks each. */
  sudden: boolean
}

/** What the report says about the match itself: derived from the record alone (no account, no rating). */
export interface ReportBody {
  game: GameId
  level: Level
  outcome: 'win' | 'loss' | 'draw'
  reason: string
  /** `reason` worded about "the player", for the public view. */
  publicReason: string
  /** Moves by the player (turn games) or rounds (word). Realtime games: 0, and `rounds` carries the score instead. */
  moves: number
  /** Real-time games: rounds won by the player and by the AI. Absent on turn-based games and on older reports. */
  rounds?: { you: number; ai: number } | null
  durationMs: number
  /** How the strength numbers were obtained: a value net, a material count, a perfect solver, or none. */
  /** Moves you made that cost a lot, by the evaluator named below. Null when the game has no such count. */
  blunders: number | null
  evaluator: 'value-net' | 'material' | 'solver' | 'none'
  moments: Moment[]
  series: Series | null
  /** Word Duel: both seats' guesses with their marker rows. */
  wordRows: WordRow[] | null
  /** Four in a Row: the final board and the drop order. */
  fourView?: FourView | null
  /** Crosscurrent: the final board and disc counts. */
  slackView?: SlackView | null
  /** Twelve Yards: the kick map data. */
  penaltyView?: PenaltyView | null
  /** After a close loss: where it turned and how near it got, replayed from the record. Absent on reports built before it existed and for any match that was not close. */
  nearMiss?: NearMiss | null
  /** A persona line built from the moments, or null when the match gave it nothing true to say. */
  reaction: string | null
  /** Honest caveat shown under the moments (for example "from the first stone the solver checks"). */
  note: string | null
}
