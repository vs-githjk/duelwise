import { PRODUCT } from '@duelwise/core/src/product'
import type { CardData } from '../server/landing-fns'
import { GameTile } from './GameTile'

/**
 * One game on the landing, as information only: its art, its name and one plain line. It is not a link and has no hover or press state,
 * because the only way into a game is Step in, then the picker.
 */
export function GameInfoCard({ card }: { card: CardData }) {
  const id = card.game
  const cfg = PRODUCT.games[id]
  return (
    <li className="grid overflow-hidden rounded-card border border-line bg-surface shadow-card" data-testid={`game-info-${id}`}>
      <div className="relative aspect-[16/9] overflow-hidden bg-surface-2">
        <GameTile game={id} className="size-full" />
      </div>
      <div className="grid content-start gap-1.5 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-display-sm">{cfg.displayName}</h3>
          {cfg.devices === 'desktop' && <span className="rounded-full bg-peach-soft px-2.5 py-0.5 font-mono text-xs font-medium uppercase tracking-wider text-peach-deep">Phone and desktop</span>}
          {card.learnsFromHumans && <span className="rounded-full bg-good-soft px-2.5 py-0.5 text-xs font-semibold text-good-ink" data-testid={`info-learns-chip-${id}`}>Learns from you</span>}
        </div>
        <p className="text-sm text-muted" data-testid={`info-note-${id}`}>{card.note}</p>
      </div>
    </li>
  )
}
