import { useEffect, useRef } from 'react'
import { PieceArt, PIECE_NAME, type PieceType } from './Pieces'

const CHOICES: PieceType[] = ['q', 'r', 'b', 'n']
const label = (t: PieceType) => PIECE_NAME[t][0]!.toUpperCase() + PIECE_NAME[t].slice(1)

export interface PromotionProps {
  /** Called with the chosen piece letter (q r b n). */
  onPick: (piece: PieceType) => void
  onCancel: () => void
}

/** Four real buttons over the board. The first takes focus; Escape cancels and the move is not played. */
export function Promotion({ onPick, onCancel }: PromotionProps) {
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    first.current?.focus()
  }, [])
  return (
    <div
      className="absolute inset-0 z-30 grid place-items-center bg-black/45"
      data-testid="promotion-picker"
      role="dialog"
      aria-label="Choose a piece to promote to"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="grid grid-cols-4 gap-1 rounded-card bg-surface p-2 shadow-sheet">
        {CHOICES.map((t, i) => (
          <button
            key={t}
            ref={i === 0 ? first : undefined}
            type="button"
            aria-label={label(t)}
            onClick={() => onPick(t)}
            className="grid aspect-square w-[min(18vw,72px)] place-items-center rounded-control bg-surface-2 outline-none hover:bg-action-soft focus-visible:ring-4 focus-visible:ring-action"
          >
            <PieceArt type={t} color="w" className="size-4/5" />
          </button>
        ))}
      </div>
    </div>
  )
}
