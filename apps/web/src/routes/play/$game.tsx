import { Suspense, lazy, useMemo } from 'react'
import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { PRODUCT } from '@duelwise/core/src/product'
import { extraFolders, gameBySlug, isPlayable, loadGame } from '../../games/registry'

function resolve(slug: string): { folder: string; title: string } | null {
  const id = gameBySlug(slug)
  if (id) return { folder: id, title: PRODUCT.games[id].displayName }
  if (extraFolders().includes(slug)) return { folder: slug, title: slug }
  return null
}

export const Route = createFileRoute('/play/$game')({
  // Play pages use workers, storage and the pointer, so they render on the client.
  ssr: false,
  beforeLoad: ({ params }) => {
    if (!resolve(params.game)) throw notFound()
  },
  head: ({ params }) => ({ meta: [{ title: `${resolve(params.game)?.title ?? 'Play'} | ${PRODUCT.name}` }] }),
  component: PlayGame,
})

function PlayGame() {
  const { game } = Route.useParams()
  const target = resolve(game)!
  const playable = extraFolders().includes(target.folder) || isPlayable(target.folder as never)
  const Page = useMemo(() => (playable ? lazy(() => loadGame(target.folder)!) : null), [playable, target.folder])
  if (!Page) {
    return (
      <section className="grid max-w-md gap-3 py-10" data-testid="not-built">
        <h1 className="font-display text-display-md">{target.title}</h1>
        <p className="text-muted">This game is still being built. Check back soon.</p>
        <Link to="/play" className="inline-flex min-h-11 items-center text-action">
          Back to all games
        </Link>
      </section>
    )
  }
  return (
    <Suspense fallback={<p className="py-10 text-muted">Loading</p>}>
      <Page />
    </Suspense>
  )
}
