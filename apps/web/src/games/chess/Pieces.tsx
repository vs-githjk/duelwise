import type { ReactNode } from 'react'

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k'
export type PieceColor = 'w' | 'b'

export const PIECE_NAME: Record<PieceType, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }

// An original piece set drawn in code (no third-party artwork, so nothing to license). Each piece is a
// filled silhouette with one outline in a 45 x 45 box; white and black differ in fill and outline
// colour only, so both read on the light and the dark squares.
const FOOT = <path d="M9 39h27v-3.5c0-1.7-1.3-3-3-3H12c-1.7 0-3 1.3-3 3z" />

function body(type: PieceType, ink: string): ReactNode {
  switch (type) {
    case 'p':
      return (
        <>
          <circle cx="22.5" cy="13" r="5.5" />
          <path d="M17.5 21.5c0-1.6 2.2-2.8 5-2.8s5 1.2 5 2.8c0 2.2-1.6 3.8-2.6 5.6-.9 1.7-1.2 3.3-1.2 5.4h-2.4c0-2.1-.3-3.7-1.2-5.4-1-1.8-2.6-3.4-2.6-5.6z" />
          {FOOT}
        </>
      )
    case 'r':
      return (
        <>
          <path d="M11 10h4.5v3h3.5v-3h7v3h3.5v-3H34v8.5l-3 3v10.5H14V21.5l-3-3z" />
          {FOOT}
        </>
      )
    case 'n':
      return (
        <>
          <path d="M13 33c0-8 1.5-13 6-17-1.6-.6-3-1.8-3.4-3.4-.4-1.6.4-2.8 1.9-3.6L20.5 6l2.3 2C29.5 9 34.5 14.5 34.5 24c0 4-.6 6-.9 9z" />
          <circle cx="23.5" cy="14.5" r="1.4" fill={ink} stroke="none" />
          {FOOT}
        </>
      )
    case 'b':
      return (
        <>
          <path d="M22.5 6.5c-1.4 0-2.5 1.1-2.5 2.5 0 .7.3 1.3.7 1.8-3.3 1.9-5.2 5.2-5.2 8.7 0 2.6 1.2 4.4 2.7 5.8-1.2 1.6-2.2 3.6-2.2 7.2h13c0-3.6-1-5.6-2.2-7.2 1.5-1.4 2.7-3.2 2.7-5.8 0-3.5-1.9-6.8-5.2-8.7.4-.5.7-1.1.7-1.8 0-1.4-1.1-2.5-2.5-2.5z" />
          <path d="M22.5 13.5v7M19.5 17h6" fill="none" stroke={ink} />
          {FOOT}
        </>
      )
    case 'q':
      return (
        <>
          <circle cx="9" cy="14" r="2.6" />
          <circle cx="16" cy="9.5" r="2.6" />
          <circle cx="22.5" cy="8" r="2.6" />
          <circle cx="29" cy="9.5" r="2.6" />
          <circle cx="36" cy="14" r="2.6" />
          <path d="M9 16l3.5 16.5h20L36 16l-6.5 8-3.2-9.5-3.8 9.5-3.8-9.5L15.5 24z" />
          {FOOT}
        </>
      )
    case 'k':
      return (
        <>
          <path d="M22.5 4v8M18.5 8h8" fill="none" strokeWidth="2.6" />
          <path d="M22.5 15c-4.5 0-9 3-9 7.5 0 3 1.8 5 3.5 6.5L15.5 33h14l-1.5-4c1.7-1.5 3.5-3.5 3.5-6.5 0-4.5-4.5-7.5-9-7.5z" />
          {FOOT}
        </>
      )
  }
}

/**
 * Gradients that give the pieces light from the top left. Rendered once inside the board; the stop colours
 * come from the piece tokens, so both themes and both colours stay on the tokens.
 */
export function PieceGradients() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="dw-piece-w" x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--piece-white)' }} />
          <stop offset="0.55" style={{ stopColor: 'var(--piece-white)', stopOpacity: 0.92 }} />
          <stop offset="1" style={{ stopColor: 'var(--piece-white-shade)' }} />
        </linearGradient>
        <linearGradient id="dw-piece-b" x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--piece-black-light)' }} />
          <stop offset="0.5" style={{ stopColor: 'var(--piece-black)' }} />
          <stop offset="1" style={{ stopColor: 'var(--piece-black)' }} />
        </linearGradient>
      </defs>
    </svg>
  )
}

export function PieceArt({ type, color, className }: { type: PieceType; color: PieceColor; className?: string }) {
  const white = color === 'w'
  const ink = white ? '#2a2623' : '#f1ece0'
  return (
    <svg viewBox="0 0 45 45" className={className} aria-hidden="true" focusable="false">
      <g fill={white ? 'url(#dw-piece-w)' : 'url(#dw-piece-b)'} stroke={ink} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
        {body(type, ink)}
      </g>
    </svg>
  )
}
