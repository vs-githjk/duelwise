import { PASS, SIZE, flipsFor, slackCore, type SlackState } from '@duelwise/core/src/games/slack/core'
import type { Seat } from '@duelwise/core/src/types'

// Pure match logic for the Crosscurrent dev page. No React here, so a unit test can drive a whole match.
// Seat 0 is the player (dark discs, moves first); seat 1 is the agent (pale discs).

export const HUMAN: Seat = 0
export const AGENT_SEAT: Seat = 1

/** The agent never answers faster than this, so a one-ply level does not reply instantly (plan SW6 step 2). */
export const MIN_HOLD_MS = 500
/** How long a forced pass for the player stays on screen before the page sends it. */
export const PASS_DELAY_MS = 900

/** The longest a move's cascade runs: the farthest ring of discs (7 away) starts 6 x 30 ms late and then takes the 200 ms flip. */
export const CASCADE_MS = 6 * 30 + 200
/** After the last disc has settled, the finished board is held this long before the result panel (Stormglass holds its winning sink the same way). */
export const END_HOLD_MS = 700

/** From the closing move to the result panel. With reduced motion nothing cascades, so a short beat is enough. */
export function endDelayMs(reducedMotion: boolean): number {
  return reducedMotion ? 400 : CASCADE_MS + END_HOLD_MS
}

export interface LastMove {
  seat: Seat
  /** The cell played, or null for a pass. */
  cell: number | null
  /** Cells that changed colour. */
  flips: number[]
}

export interface SlackMatch {
  state: SlackState
  /** Every action in order as [seat, code]; code 64 is a pass. A real game stores these as the match record's actions. */
  log: Array<[Seat, number]>
  /** The latest action, what the board animates: the disc placed and the discs it flipped. A pass has no cell and no flips. */
  last: LastMove | null
  /** The cell of the latest disc placed by either side. It keeps its ring through a pass, which places nothing. */
  ring: number | null
}

export function startMatch(): SlackMatch {
  // The rules ignore the seed (no luck anywhere); variety lives in the agent's own noise.
  return { state: slackCore.init(0), log: [], last: null, ring: null }
}

const FILES = 'ABCDEFGH'

/**
 * Test-only start position, read from `?moves=D3,C3`: cell names (file A to H, rank 1 to 8, A1 top left) or "pass", each played by whoever is to
 * act, from the opening. Null for a missing list and for any list with an unknown token or an illegal move, which is ignored whole.
 */
export function parseMoves(raw: string | null | undefined): SlackMatch | null {
  if (!raw) return null
  try {
    let m = startMatch()
    for (const token of raw.split(',')) {
      const t = token.trim().toUpperCase()
      const code = t === 'PASS' ? PASS : /^[A-H][1-8]$/.test(t) ? (Number(t[1]) - 1) * SIZE + FILES.indexOf(t[0]!) : -1
      if (code < 0) return null
      m = applyMove(m, m.state.turn, code)
    }
    return m
  } catch {
    return null
  }
}

/** The player's cells to offer: only on the player's own turn, and never the pass code. */
export function legalCells(m: SlackMatch): number[] {
  if (slackCore.terminal(m.state)) return []
  return slackCore.legal(m.state, HUMAN).filter((c) => c !== PASS)
}

/** The seat that must pass right now (its only action is PASS), or null. */
export function mustPass(m: SlackMatch): Seat | null {
  if (slackCore.terminal(m.state)) return null
  const seat = m.state.turn
  const legal = slackCore.legal(m.state, seat)
  return legal.length === 1 && legal[0] === PASS ? seat : null
}

/** Applies one action for the seat to act. Throws on an illegal one, exactly like the core, and leaves `m` untouched. */
export function applyMove(m: SlackMatch, seat: Seat, code: number): SlackMatch {
  const flips = code === PASS ? [] : flipsFor(m.state.cells, (seat + 1) as 1 | 2, code)
  const state = slackCore.step(m.state, seat === 0 ? [code, null] : [null, code])
  return { state, log: [...m.log, [seat, code]], last: { seat, cell: code === PASS ? null : code, flips }, ring: code === PASS ? m.ring : code }
}

/**
 * The agent's action for its turn. It reads the agent seat's observation and nothing else, never the
 * hidden state or anything of the player's beyond the board.
 */
export async function agentChoose(m: SlackMatch, agent: { act(obs: unknown): Promise<number[]> }): Promise<number> {
  const [code] = await agent.act(slackCore.observe(m.state, AGENT_SEAT))
  return slackCore.decodeAction(code!)
}

/** Resolves with the work's value, but not before `ms` have passed since the call. Slow work adds nothing. */
export async function holdAtLeast<T>(work: Promise<T>, ms: number): Promise<T> {
  const [value] = await Promise.all([work, new Promise<void>((r) => setTimeout(r, ms))])
  return value
}

/**
 * First tap on a legal cell selects it, a second tap on the selected cell commits, a tap on another legal cell moves the
 * selection. A tap on an illegal cell, or off the player's turn, does nothing at all.
 */
export function tapCell(m: SlackMatch, selected: number | null, cell: number): { selected: number | null; commit: boolean } {
  const legal = m.state.turn === HUMAN ? legalCells(m) : []
  if (!legal.includes(cell)) return { selected: m.state.turn === HUMAN && selected !== null && legal.includes(selected) ? selected : null, commit: false }
  return { selected: cell, commit: selected === cell }
}

/** The Place button commits only a legal selection. */
export function pressPlace(m: SlackMatch, selected: number | null): boolean {
  return selected !== null && m.state.turn === HUMAN && legalCells(m).includes(selected)
}

/** Cells the player would flip by playing `cell`, for the dot preview. [] for an illegal cell. */
export function flipPreview(m: SlackMatch, cell: number): number[] {
  return m.state.turn === HUMAN ? flipsFor(m.state.cells, 1, cell) : []
}

/** Chess-style names with row 1 at the top: A1 is the top-left cell, H8 the bottom-right. */
export function cellName(cell: number): string {
  return `${'ABCDEFGH'[cell % SIZE]}${Math.floor(cell / SIZE) + 1}`
}

export function discCounts(m: SlackMatch): [number, number] {
  const o = slackCore.observe(m.state, HUMAN)
  return o.discs
}

/** The closing disc count, for the result card's reveal line. Not used after a resignation: the board was unfinished. */
export function finalCount(m: SlackMatch, name: string): string {
  const [you, them] = discCounts(m)
  return `Final discs: You ${you}, ${name} ${them}.`
}

/** The human's own moves in a log (passes are not moves), for the result's margin. */
export function humanMoveCount(log: ReadonlyArray<readonly [Seat, number]>): number {
  return log.filter(([seat, code]) => seat === HUMAN && code !== PASS).length
}

/** The fixed status line. Text swaps in one box, the box never changes size. */
export function statusLine(m: SlackMatch, name: string): string {
  const result = slackCore.result(m.state)
  if (result) return result.winner === null ? 'Level on discs. A draw.' : result.winner === HUMAN ? 'You win.' : `${name} wins.`
  const pass = mustPass(m)
  if (pass === HUMAN) return `No move for you. ${name} plays again.`
  const last = m.last
  if (last && last.seat === AGENT_SEAT && last.cell === null) return `${name} has no move. Your turn again.`
  const moves = m.log.filter(([, code]) => code !== PASS).length
  return `Move ${moves + 1}`
}

/** Screen-reader text for the live region after a move: "Pip placed at C4, flipped 3." or the pass. */
export function announce(m: SlackMatch, name: string): string {
  const last = m.last
  if (!last) return ''
  const who = last.seat === HUMAN ? 'You' : name
  if (last.cell === null) return `${who} had no move and passed.`
  const n = last.flips.length
  return `${who} placed at ${cellName(last.cell)}, flipped ${n}.`
}

/** Live-region text: every move is announced, and when the match is over the verdict follows the closing move. */
export function liveText(m: SlackMatch, name: string, over: boolean, verdict: string): string {
  const move = announce(m, name)
  return over ? [move, verdict].filter(Boolean).join(' ') : move
}
