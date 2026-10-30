import type { HandSummary } from '@duelwise/core/src/games/holdem/match'
import { cardName } from '@duelwise/core/src/games/holdem/cards'
import { HUMAN } from './seats'
import { deltaWords } from './progress'

const SUIT_GLYPH: Record<string, string> = { c: '\u2663', d: '\u2666', h: '\u2665', s: '\u2660' }
const short = (cards: number[]) => cards.map((c) => cardName(c).replace('T', '10').replace(/[cdhs]$/, (s) => SUIT_GLYPH[s]!)).join(' ')

/** The sentence for one finished hand, from the human's side. */
export function historyLine(h: HandSummary, opponent: string): string {
  if (h.winner === null) return `Split pot of ${h.pot}`
  const won = Math.abs(h.delta)
  const how = h.showdown ? 'at showdown' : h.winner === HUMAN ? `${opponent} folded` : 'you folded'
  return h.winner === HUMAN ? `You won ${won}, ${how}` : `${opponent} won ${won}, ${how}`
}

/** Whose cards are whose at a showdown, e.g. "You K\u2660 5\u2666, Pip A\u2666 Q\u2666, board K\u2663 5\u2665 9\u2666 2\u2663 3\u2660"; null when the hand ended without a showdown. */
export function historyCards(h: HandSummary, opponent: string): string | null {
  if (!h.showdown || !h.hole) return null
  return `You ${short(h.hole[HUMAN])}, ${opponent} ${short(h.hole[1 - HUMAN])}, board ${short(h.board)}`
}

/** A running list of finished hands, newest first, with the chip change from the human's side. */
export function HandHistory({ hands, opponent }: { hands: readonly HandSummary[]; opponent: string }) {
  return (
    <section className="grid gap-2 rounded-card border border-line bg-surface p-4" data-testid="hand-history" aria-label="Hand history">
      <h2 className="font-display text-display-sm">Hands</h2>
      {hands.length === 0 ? (
        <p className="text-sm text-muted">Finished hands appear here.</p>
      ) : (
        <ol className="grid max-h-64 gap-1 overflow-y-auto text-sm" reversed>
          {[...hands].reverse().map((h) => (
            <li key={h.hand} className="flex items-baseline justify-between gap-3" data-testid="history-row" data-delta={h.delta}>
              <span className="min-w-0">
                <b className="font-mono tabular">Hand {h.hand + 1}:</b> {historyLine(h, opponent)}
                {historyCards(h, opponent) ? <span className="block overflow-x-auto whitespace-nowrap text-xs text-muted" data-testid="history-cards">{historyCards(h, opponent)}</span> : null}
              </span>
              <span className={`font-mono tabular font-semibold ${h.delta > 0 ? 'text-good-ink' : h.delta < 0 ? 'text-bad-ink' : 'text-muted'}`} role="img" aria-label={deltaWords(h.delta)}>{h.delta > 0 ? `+${h.delta}` : h.delta}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
