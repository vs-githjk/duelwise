import { createFileRoute } from '@tanstack/react-router'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { CHALLENGE_GAMES } from '../../lib/challenge-games'
import { CreateChallenge } from '../../games/friends/Challenge'
import { renderRemoteGame } from '../../games/friends/RemoteGame'

// Start a friend game over a link. Everything runs in the browser (the page holds the live socket), so SSR stops at the data check.
export const Route = createFileRoute('/f/')({
  ssr: 'data-only',
  // A game's own page sends people here with ?game=chess so the chooser opens on it.
  // Only checks that this is a game. Which games a link can carry (CHALLENGE_GAMES) is checked in the lazy component, so this route file
  // stays off the shared chunk that holds that list and the landing page does not load it.
  validateSearch: (s: Record<string, unknown>): { game?: GameId } => (typeof s.game === 'string' && Object.prototype.hasOwnProperty.call(PRODUCT.games, s.game) ? { game: s.game as GameId } : {}),
  head: () => ({ meta: [{ title: `Play a friend | ${PRODUCT.name}` }] }),
  component: Start,
})

function Start() {
  const { game } = Route.useSearch()
  return <CreateChallenge {...(game && (CHALLENGE_GAMES as readonly string[]).includes(game) ? { initial: game } : {})} renderGame={renderRemoteGame} />
}
