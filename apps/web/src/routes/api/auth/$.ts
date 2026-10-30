import { createFileRoute } from '@tanstack/react-router'
import { getAuth } from '../../../server/caller'

// Better Auth owns everything under /api/auth: sign-in, sign-out, OAuth callbacks, session.
export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => (await getAuth()).handler(request),
      POST: async ({ request }: { request: Request }) => (await getAuth()).handler(request),
    },
  },
})
