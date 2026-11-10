import { COLS, ROWS, stoneAt, type FourState } from '@duelwise/core/src/games/four/rules'

/** "Column 4, 2 stones, top one is Pip's" for a column button. Bottom to top order is in boardSummary. */
export function columnLabel(state: FourState, col: number, opponent: string, humanSeat = 0, names?: readonly [string, string]): string {
  const n = state.h[col]!
  const head = `Column ${col + 1}`
  if (n === 0) return `${head}, empty`
  const top = stoneAt(state, col, n - 1) - 1
  const stones = `${n} ${n === 1 ? 'stone' : 'stones'}`
  return `${head}, ${stones}, top one is ${names ? `${names[top]!}'s` : top === humanSeat ? 'yours' : `${opponent}'s`}${n >= ROWS ? ', full' : ''}`
}

/** Every column bottom to top, for a screen reader to read once. */
export function boardSummary(state: FourState, opponent: string, humanSeat = 0, names?: readonly [string, string]): string {
  const cols: string[] = []
  for (let c = 0; c < COLS; c++) {
    const n = state.h[c]!
    if (n === 0) {
      cols.push(`Column ${c + 1}: empty.`)
      continue
    }
    const stones = Array.from({ length: n }, (_, r) => (names ? names[stoneAt(state, c, r) - 1]! : stoneAt(state, c, r) - 1 === humanSeat ? 'you' : opponent))
    cols.push(`Column ${c + 1}, bottom to top: ${stones.join(', ')}.`)
  }
  return cols.join(' ')
}

/** What a screen reader hears after the opponent drops, or the opening prompt. `humanSeat` is the player's side (0 drops first, 1 drops second; default 0). */
export function dropAnnouncement(o: { opponent: string; lastCol: number | null; lastSeat: number | null; moves: number; over: boolean; humanSeat?: number }): string {
  const human = o.humanSeat ?? 0
  if (o.over) return 'Match over.'
  if (o.moves === 0) return human === 0 ? 'Your move.' : `You drop second. ${o.opponent} opens.`
  if (o.lastSeat === human || o.lastSeat === null || o.lastCol === null) return ''
  return `${o.opponent} dropped a stone in column ${o.lastCol + 1}. Your move.`
}
