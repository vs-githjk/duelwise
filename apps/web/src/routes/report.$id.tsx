import { createFileRoute, notFound } from '@tanstack/react-router'
import { PRODUCT } from '@duelwise/core/src/product'
import { getReportPage } from '../server/report-fns'
import { ReportPageView } from '../report/ReportPage'
import { cardHeadline, cardImageUrl } from '../report/share-card'

export const Route = createFileRoute('/report/$id')({
  loader: async ({ params }) => {
    const page = await getReportPage({ data: { id: params.id } })
    if (!page) throw notFound()
    return page
  },
  head: ({ loaderData }) => {
    const v = loaderData?.view
    // Link previews of a private, unfinished or rejected report say nothing about it.
    const open = v && v.status !== 'private' && v.status !== 'writing' && v.status !== 'rejected' && v.body
    const title = open ? `${cardHeadline({ game: v.game, level: v.level, outcome: v.body!.outcome })} | ${PRODUCT.name}` : PRODUCT.name
    const meta: Array<Record<string, string>> = [{ title }, { name: 'robots', content: open && v.mode === 'public' ? 'noindex' : 'noindex, nofollow' }]
    if (open) {
      const image = cardImageUrl(loaderData.origin, v.id)
      meta.push(
        { property: 'og:title', content: title },
        { property: 'og:description', content: `${PRODUCT.tagline}` },
        { property: 'og:image', content: image },
        { property: 'og:image:width', content: '1200' },
        { property: 'og:image:height', content: '630' },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:image', content: image },
        { property: 'og:image:alt', content: title },
        { name: 'twitter:image:alt', content: title },
        { name: 'twitter:title', content: title },
        { name: 'twitter:description', content: PRODUCT.tagline },
        { property: 'og:url', content: `${loaderData.origin}/report/${v.id}` },
      )
    }
    return { meta }
  },
  component: Page,
})

function Page() {
  return <ReportPageView page={Route.useLoaderData()} />
}
