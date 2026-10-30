import { createFileRoute } from '@tanstack/react-router'
import { getCardPng, getCardSvg } from '../server/report-card'

const NOT_FOUND = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })

// The share card for a public report, nothing private in it. /report-card/<id> is the SVG (the report page turns it
// into a download in the browser); /report-card/<id>.png is the PNG that og:image and twitter:image point at, because
// link previews do not draw SVG. A private, unfinished or unknown report is a 404 in both forms.
export const Route = createFileRoute('/report-card/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { id: string }; request: Request }) => {
        const site = process.env.BETTER_AUTH_URL?.replace(/\/$/, '') || new URL(request.url).origin
        const wantsPng = params.id.endsWith('.png')
        const id = wantsPng ? params.id.slice(0, -4) : params.id
        const link = `${site.replace(/^https?:\/\//, '')}/report/${id}`
        if (wantsPng) {
          const png = await getCardPng(id, link, site)
          if (!png) return NOT_FOUND()
          return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=300' } })
        }
        const svg = await getCardSvg(id, link)
        if (!svg) return NOT_FOUND()
        return new Response(svg, { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=300' } })
      },
    },
  },
})
