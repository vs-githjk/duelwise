import { COLS, ROWS, stoneAt, type FourState } from '@duelwise/core/src/games/four/rules'

/** "Column 4, 2 stones, top one is Pip's" for a column button. Bottom to top order is in boardSummary. */
export function columnLabel(state: FourState, col: number, opponent: string): string {
  const n = state.h[col]!
  const head = `Column ${col + 1}`
  if (n === 0) return `${head}, empty`
  const top = stoneAt(state, col, n - 1) - 1
  const stones = `${n} ${n === 1 ? 'stone' : 'stones'}`
  return `${head}, ${stones}, top one is ${top === 0 ? 'yours' : `${opponent}'s`}${n >= ROWS ? ', full' : ''}`
}

/** Every column bottom to top, for a screen reader to read once. */
export function boardSummary(state: FourState, opponent: string): string {
  const cols: string[] = []
  for (let c = 0; c < COLS; c++) {
    const n = state.h[c]!
    if (n === 0) {
      cols.push(`Column ${c + 1}: empty.`)
      continue
    }
    const stones = Array.from({ length: n }, (_, r) => (stoneAt(state, c, r) - 1 === 0 ? 'you' : opponent))
    cols.push(`Column ${c + 1}, bottom to top: ${stones.join(', ')}.`)
  }
  return cols.join(' ')
}

export function dropAnnouncement(o: { opponent: string; lastCol: number | null; lastSeat: number | null; moves: number; over: boolean }): string {
  if (o.over) return 'Match over.'
  if (o.moves === 0) return 'Your move.'
  if (o.lastSeat !== 1 || o.lastCol === null) return ''
  return `${o.opponent} dropped a stone in column ${o.lastCol + 1}. Your move.`
}
