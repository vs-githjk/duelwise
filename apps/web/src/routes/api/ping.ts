import { createFileRoute } from '@tanstack/react-router'

// The page asks this to learn whether the server can be reached (the offline chip, the queue drain). navigator.onLine alone is
// not enough: it stays true on a network that is joined but dead. The service worker never answers it from a cache.
export const Route = createFileRoute('/api/ping')({
  server: {
    handlers: {
      GET: () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }),
    },
  },
})
