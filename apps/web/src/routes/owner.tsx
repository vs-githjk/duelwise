import { createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect } from 'react'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import { OwnerDashboard, type OwnerFilters } from '../components/owner/OwnerDashboard'
import { browserZone } from '../server/owner-zone'
import { getOwnerView } from '../server/telemetry-fns'

interface Search {
  range?: '24h' | '30d'
  game?: GameId
  level?: Level
  page?: number
  who?: 'owner' | 'test' | 'all'
}

export const Route = createFileRoute('/owner')({
  // The loader still runs on the server, so the owner check answers a real 404, but the page renders on the client: only the browser knows its time zone, so rendering it on the server would show numbers for the wrong day and then change them.
  ssr: 'data-only',
  validateSearch: (s: Record<string, unknown>): Search => {
    const out: Search = {}
    if (s.range === '24h' || s.range === '30d') out.range = s.range
    if (typeof s.game === 'string' && Object.prototype.hasOwnProperty.call(PRODUCT.games, s.game)) out.game = s.game as GameId
    if (s.level === 'easy' || s.level === 'medium' || s.level === 'hard' || s.level === 'champion') out.level = s.level
    if (s.who === 'owner' || s.who === 'test' || s.who === 'all') out.who = s.who
    const p = Number(s.page)
    if (Number.isInteger(p) && p > 0 && p < 10_000) out.page = p
    return out
  },
  loaderDeps: ({ search }) => ({ range: search.range, game: search.game, level: search.level, page: search.page, who: search.who }),
  loader: async ({ deps }) => {
    // The server render has no browser zone (tz stays unset there); the browser always names one, an empty string when it cannot read its own.
    const view = await getOwnerView({ data: typeof window === 'undefined' ? deps : { ...deps, tz: browserZone() ?? '' } })
    // Anyone who is not the owner sees the same page as an address that does not exist.
    if (!view) throw notFound()
    return view
  },
  head: () => ({ meta: [{ title: 'Observability' }, { name: 'robots', content: 'noindex, nofollow' }] }),
  pendingComponent: Loading,
  component: Page,
})

function Loading() {
  return (
    <div className="grid gap-4 py-8" data-testid="owner-loading" aria-busy="true">
      <div className="h-10 w-56 rounded-control bg-neutral-soft" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-32 rounded-card border border-line bg-surface" />
        ))}
      </div>
    </div>
  )
}

function Page() {
  const view = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/owner' })
  const router = useRouter()
  const filters: OwnerFilters = { range: search.range ?? '7d', game: search.game, level: search.level, page: search.page ?? 0, who: search.who ?? 'human' }
  const refresh = useCallback(() => {
    router.invalidate().catch(() => {})
  }, [router])
  // Data that came from the server render was counted in UTC; load it again with the browser's zone before showing a single number.
  const needsZone = !view.zoneAsked
  useEffect(() => {
    if (needsZone) refresh()
  }, [needsZone, refresh])
  if (needsZone) return <Loading />
  return (
    <OwnerDashboard
      v={view}
      filters={filters}
      onRefresh={refresh}
      onFilters={(f) => {
        const next = { ...filters, ...f }
        void navigate({ search: { range: next.range === '7d' ? undefined : next.range, game: next.game, level: next.level, page: next.page > 0 ? next.page : undefined, who: next.who === 'human' ? undefined : next.who } })
      }}
    />
  )
}
