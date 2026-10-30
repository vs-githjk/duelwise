import { Link } from '@tanstack/react-router'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'

/** Shown instead of a desktop-only game (fighter, arena) on a narrow or touch-only screen. */
export function DesktopOnlyNotice({ game }: { game: GameId }) {
  const name = PRODUCT.games[game].displayName
  return (
    <section className="mx-auto grid max-w-md gap-3 rounded-card border border-line bg-surface p-6 shadow-card" data-testid="desktop-only">
      <h2 className="font-display text-display-sm">{name} is a desktop game</h2>
      <p className="text-muted">It needs a keyboard and a wide screen. Open this page on a laptop or desktop to play, or pick a game that works on your phone.</p>
      <Link to="/play" className="inline-flex min-h-11 items-center justify-center rounded-control bg-action px-4 font-semibold text-action-ink">
        See all games
      </Link>
    </section>
  )
}
