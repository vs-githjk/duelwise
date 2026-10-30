import { cardRank, cardSuit } from '@duelwise/core/src/games/holdem/cards'
import { cn } from '../../lib/cn'

const RANK_WORD = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace']
const RANK_TEXT = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
// Card suit order in the core is c d h s.
const SUIT_WORD = ['clubs', 'diamonds', 'hearts', 'spades']
const SUIT_RED = [false, true, true, false]

/** Spoken name of a card, for assistive tech: "Ace of spades". */
export function cardLabel(card: number): string {
  return `${RANK_WORD[cardRank(card)]} of ${SUIT_WORD[cardSuit(card)]}`
}

/** Pip shapes drawn in code (no image files): club, diamond, heart, spade, in a 20 by 20 box. */
function Suit({ suit, className }: { suit: number; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true" fill="currentColor">
      {suit === 0 ? (
        <>
          <circle cx="10" cy="6" r="4" />
          <circle cx="5.5" cy="11.5" r="4" />
          <circle cx="14.5" cy="11.5" r="4" />
          <path d="M8.6 12 L11.4 12 L12.6 19 L7.4 19 Z" />
        </>
      ) : suit === 1 ? (
        <path d="M10 1 L17 10 L10 19 L3 10 Z" />
      ) : suit === 2 ? (
        <path d="M10 18.5 C2 12.5 1.5 8.6 1.5 6.4 C1.5 3.6 3.6 1.8 6 1.8 C7.7 1.8 9.2 2.7 10 4.2 C10.8 2.7 12.3 1.8 14 1.8 C16.4 1.8 18.5 3.6 18.5 6.4 C18.5 8.6 18 12.5 10 18.5 Z" />
      ) : (
        <>
          <path d="M10 1 C16.5 6.6 18.5 9.2 18.5 12 C18.5 14.5 16.6 16 14.4 16 C13.2 16 12.2 15.5 11.6 14.7 L12.6 19 L7.4 19 L8.4 14.7 C7.8 15.5 6.8 16 5.6 16 C3.4 16 1.5 14.5 1.5 12 C1.5 9.2 3.5 6.6 10 1 Z" />
        </>
      )}
    </svg>
  )
}

export interface CardProps {
  /** 0..51, or null for a face-down card. */
  card: number | null
  /** Plays the dealt-in animation when the card mounts; give it a key that changes per deal. */
  deal?: boolean
  /** Stagger for the dealt-in animation, in milliseconds. */
  delay?: number
  /** Dim a card that is not part of anything (an empty board slot is drawn by the caller). */
  className?: string
}

/** One playing card, original artwork drawn with CSS and SVG. Size comes from the parent (`--card-w`). */
export function Card({ card, deal = false, delay = 0, className }: CardProps) {
  const anim = deal ? { animation: 'hd-deal 360ms cubic-bezier(.2,.8,.2,1) both', animationDelay: `${delay}ms` } : undefined
  if (card === null) {
    return (
      <span
        data-testid="card-back"
        role="img"
        aria-label="Face-down card"
        className={cn('hd-card hd-back', className)}
        style={anim}
      />
    )
  }
  const suit = cardSuit(card)
  const red = SUIT_RED[suit]
  return (
    <span
      data-testid="card"
      data-card={card}
      role="img"
      aria-label={cardLabel(card)}
      className={cn('hd-card hd-face', red ? 'hd-red' : 'hd-black', className)}
      style={anim}
    >
      <span className="hd-corner" aria-hidden="true">
        <b>{RANK_TEXT[cardRank(card)]}</b>
        <Suit suit={suit} className="hd-corner-suit" />
      </span>
      <Suit suit={suit} className="hd-center-suit" />
    </span>
  )
}

/** An empty slot where a community card will land. */
export function CardSlot() {
  return <span className="hd-card hd-slot" aria-hidden="true" />
}
