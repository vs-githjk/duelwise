import { createFileRoute } from '@tanstack/react-router'
import { refuseCrossSite } from '../../server/origin'
import { finishFromRequest } from '../../server/finish-route'
import { MAX_BODY_BYTES } from '../../server/match-handlers'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// A plain endpoint, not a server function, so navigator.sendBeacon can deliver a finished match's
// record when the tab closes before the normal upload settled. Same checks as the upload path.
export const Route = createFileRoute('/api/finish')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const refused = refuseCrossSite(request)
        if (refused) return refused
        const declared = Number(request.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json(413, { error: 'upload is too large' })
        const bytes = new Uint8Array(await request.arrayBuffer())
        const r = await finishFromRequest(bytes)
        return json(r.status, r.body)
      },
    },
  },
})
