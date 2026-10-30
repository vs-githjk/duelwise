import { createFileRoute } from '@tanstack/react-router'
import { refuseCrossSite } from '../../server/origin'
import { resignFromRequest } from '../../server/resign-route'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// A plain endpoint, not a server function, so navigator.sendBeacon (which cannot speak the RPC
// format) can reach it when the tab closes. The Resign button posts here too.
export const Route = createFileRoute('/api/resign')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const refused = refuseCrossSite(request)
        if (refused) return refused
        const text = await request.text()
        if (text.length > 2048) return json(413, { error: 'too large' })
        let input: unknown
        try {
          input = JSON.parse(text)
        } catch {
          return json(400, { error: 'expected JSON' })
        }
        const r = await resignFromRequest(input)
        return json(r.status, r.body)
      },
    },
  },
})
