import { createFileRoute, redirect } from '@tanstack/react-router'
import { PRODUCT } from '@duelwise/core/src/product'

/** /leaderboard has no page of its own: it opens the first game's board (the others are one click away in its header). */
export const Route = createFileRoute('/leaderboard/')({
  beforeLoad: () => {
    const first = Object.values(PRODUCT.games)[0]!
    throw redirect({ to: '/leaderboard/$game', params: { game: first.slug }, replace: true })
  },
})
