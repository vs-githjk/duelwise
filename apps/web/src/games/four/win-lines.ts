import { COLS, ROWS, stoneAt, type FourState } from '@duelwise/core/src/games/four/rules'

// Pure board geometry, kept apart from useFourMatch so a page that only draws the winning run does not load the match recorder and the agent.

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
]

/** One winning run of four or more stones, from its first cell to its last, as [col, row]. */
export interface WinLine {
  from: readonly [number, number]
  to: readonly [number, number]
}

/** Every winning run (one per direction and start), or an empty list when nobody has won. */
export function winningLines(s: FourState): WinLine[] {
  const out: WinLine[] = []
  if (s.winner === null) return out
  const mine = (c: number, r: number) => c >= 0 && c < COLS && r >= 0 && r < ROWS && stoneAt(s, c, r) === s.winner! + 1
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (!mine(c, r)) continue
      for (const [dc, dr] of DIRECTIONS) {
        if (mine(c - dc, r - dr)) continue // start of a run only
        let len = 0
        while (mine(c + dc * len, r + dr * len)) len++
        if (len >= 4) out.push({ from: [c, r], to: [c + dc * (len - 1), r + dr * (len - 1)] })
      }
    }
  }
  return out
}

/** The stones of the winning lines (the whole run when it is longer than four), or an empty set. */
export function winningCells(s: FourState): ReadonlySet<string> {
  const out = new Set<string>()
  for (const { from, to } of winningLines(s)) {
    const n = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]))
    const dc = Math.sign(to[0] - from[0])
    const dr = Math.sign(to[1] - from[1])
    for (let i = 0; i <= n; i++) out.add(`${from[0] + dc * i},${from[1] + dr * i}`)
  }
  return out
}
