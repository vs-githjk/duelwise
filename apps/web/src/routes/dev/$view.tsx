import { Suspense, lazy, useMemo, type ComponentType } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { NotFound } from '../../components/NotFound'

// Dev views are for local work only. In a production build the condition is false, the glob is dead
// code and no view is bundled; the route then shows not-found.
const views: Record<string, () => Promise<{ default: ComponentType }>> = import.meta.env.DEV ? import.meta.glob<{ default: ComponentType }>('../../dev-views/*.tsx') : {}

export const Route = createFileRoute('/dev/$view')({
  ssr: false,
  component: DevView,
})

function DevView() {
  const { view } = Route.useParams()
  const loader = views[`../../dev-views/${view}.tsx`]
  const Page = useMemo(() => (loader ? lazy(loader) : null), [loader])
  if (!Page) return <NotFound />
  return (
    <Suspense fallback={<p className="py-10 text-muted">Loading</p>}>
      <Page />
    </Suspense>
  )
}
