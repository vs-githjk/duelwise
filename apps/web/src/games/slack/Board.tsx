import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react'
import { SIZE } from '@duelwise/core/src/games/slack/core'
import { cellName, type SlackMatch } from './match'
import './slack.css'

const FILES = 'ABCDEFGH'

/** The accessible name of one cell: where it is, who holds it, and whether the player may place there. */
export function cellLabel(i: number, v: number, legal: boolean, opponent: string): string {
  const where = `${FILES[i % SIZE]}, ${Math.floor(i / SIZE) + 1}`
  if (v === 1) return `${where}, yours`
  if (v === 2) return `${where}, ${opponent}'s`
  return `${where}, empty${legal ? ', legal' : ''}`
}

/** The cell an arrow, Home or End key moves to from `i`, or null for any other key. The edge stops, it never wraps. */
export function nextCell(key: string, i: number): number | null {
  const r = Math.floor(i / SIZE)
  const c = i % SIZE
  switch (key) {
    case 'ArrowLeft': return r * SIZE + Math.max(0, c - 1)
    case 'ArrowRight': return r * SIZE + Math.min(SIZE - 1, c + 1)
    case 'ArrowUp': return Math.max(0, r - 1) * SIZE + c
    case 'ArrowDown': return Math.min(SIZE - 1, r + 1) * SIZE + c
    case 'Home': return r * SIZE
    case 'End': return r * SIZE + SIZE - 1
    default: return null
  }
}

export interface BoardProps {
  match: SlackMatch
  opponent: string
  /** The cells the player may place on now (empty on the opponent's turn and after the end). */
  legal: readonly number[]
  /** The picked cell, or null. */
  selected: number | null
  /** The discs the picked cell would flip, shown as small dots. */
  preview: readonly number[]
  /** The cell that holds the tab stop. */
  focus: number
  onFocus: (cell: number) => void
  /** A tap, a click or Enter or Space on a cell. */
  onTap: (cell: number) => void
  /** Bumps when a match starts, so the first legal cell takes the keyboard focus once. */
  focusKey: unknown
}

/**
 * The 8 by 8 board as a real grid of 64 buttons with a roving tab stop. Only transforms and opacity change during a move; no box ever resizes.
 * Rings mark the legal cells, the last disc placed keeps a ring through a pass, and a picked cell shows a dot on every disc it would flip.
 */
export function Board({ match, opponent, legal, selected, preview, focus, onFocus, onTap, focusKey }: BoardProps) {
  const cells = useRef<Array<HTMLButtonElement | null>>([])
  const keyboardMoved = useRef(false)
  const last = match.last
  // Keep the keyboard focus on a real cell, and move it only for key presses.
  useEffect(() => {
    if (!keyboardMoved.current) return
    keyboardMoved.current = false
    cells.current[focus]?.focus()
  }, [focus])
  // A new match removes the Start button the player was on, so the first legal cell takes the focus.
  useEffect(() => {
    cells.current[focus]?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey])

  const onKey = (e: KeyboardEvent, i: number) => {
    const next = nextCell(e.key, i)
    if (next === null) return
    e.preventDefault()
    keyboardMoved.current = true
    onFocus(next)
    if (next === i) cells.current[i]?.focus()
  }

  return (
    <div className="sl-board-wrap">
      <div className="sl-board" data-testid="slack-board">
        {Array.from({ length: SIZE }, (_, k) => (
          <span key={`f${k}`} className="sl-coord sl-coord-file" style={{ '--k': k } as CSSProperties} aria-hidden="true">
            {FILES[k]}
          </span>
        ))}
        {Array.from({ length: SIZE }, (_, k) => (
          <span key={`r${k}`} className="sl-coord sl-coord-rank" style={{ '--k': k } as CSSProperties} aria-hidden="true">
            {k + 1}
          </span>
        ))}
        <div className="sl-grid" role="grid" aria-label="Crosscurrent board, 8 by 8" aria-rowcount={SIZE} aria-colcount={SIZE}>
          {Array.from({ length: SIZE }, (_, r) => (
            <div key={r} className="sl-row" role="row">
              {Array.from({ length: SIZE }, (_, c) => {
                const i = r * SIZE + c
                const v = match.state.cells[i]!
                const isLegal = legal.includes(i)
                const flipped = !!last && last.flips.includes(i)
                const placed = !!last && last.cell === i
                const dist = last && last.cell !== null ? Math.max(Math.abs(Math.floor(last.cell / SIZE) - r), Math.abs((last.cell % SIZE) - c)) : 0
                return (
                  <button
                    key={i}
                    ref={(el) => {
                      cells.current[i] = el
                    }}
                    type="button"
                    role="gridcell"
                    className="sl-cell"
                    data-alt={(r + c) % 2 ? '' : undefined}
                    data-testid={`slack-cell-${i}`}
                    data-cell={cellName(i)}
                    data-legal={isLegal ? '' : undefined}
                    data-selected={selected === i ? '' : undefined}
                    tabIndex={i === focus ? 0 : -1}
                    aria-label={cellLabel(i, v, isLegal, opponent)}
                    aria-selected={selected === i}
                    onClick={() => onTap(i)}
                    onKeyDown={(e) => onKey(e, i)}
                  >
                    {v !== 0 && (
                      <span
                        key={placed || flipped ? `m${match.log.length}` : 'd'}
                        className="sl-disc"
                        data-owner={v === 1 ? 'you' : 'them'}
                        data-last={match.ring === i ? '' : undefined}
                        data-flip={flipped ? '' : undefined}
                        data-placed={placed ? '' : undefined}
                        style={{ '--d': `${Math.max(0, dist - 1) * 30}ms` } as CSSProperties}
                      />
                    )}
                    {isLegal && selected !== i && <span className="sl-ring" aria-hidden="true" />}
                    {preview.includes(i) && <span className="sl-dot" aria-hidden="true" />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
