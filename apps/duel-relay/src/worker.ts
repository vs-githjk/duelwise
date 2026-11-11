import { ROOM_CODE, verifyDuelToken } from '@duelwise/core/src/duel/token'
import type { Env } from './room-do'
import type { Identity } from './host'
import { LIMITS } from './limits'

export { RoomDO } from './room-do'
export { LimiterDO } from './limiter-do'
export { BudgetDO } from './budget-do'
export type { Env } from './room-do'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

function originAllowed(req: Request, env: Env): boolean {
  const origin = req.headers.get('Origin')
  if (!origin) return true // not a browser; the signed token is the gate
  if (LOCAL.test(origin)) return true
  return (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin)
}

/**
 * GET /room/:code?t=<token>  with Upgrade: websocket. The token is checked here, before any room object wakes, so a
 * bad token never costs a Durable Object request. /health answers 200 for deploy checks.
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/health') return json(200, { ok: true })
    const m = /^\/room\/([A-Z2-7]{6})$/.exec(url.pathname)
    if (!m || !ROOM_CODE.test(m[1]!)) return json(404, { error: 'not-found' })
    if (req.method !== 'GET' || req.headers.get('Upgrade') !== 'websocket') return json(426, { error: 'websocket-required' })
    if (!originAllowed(req, env)) return json(403, { error: 'origin' })
    const token = await verifyDuelToken(url.searchParams.get('t') ?? '', env.DUEL_SIGNING_SECRET, Date.now())
    if (!token || token.code !== m[1] || token.exp - Date.now() > LIMITS.maxTokenLifeMs) return json(401, { error: 'bad-token' })
    const id: Identity = { ref: token.ref, name: token.name.slice(0, LIMITS.maxNameChars), host: token.host, ...(token.pid ? { pid: token.pid } : {}), ...(token.rt ? { rt: token.rt } : {}) }
    const headers = new Headers(req.headers)
    for (const k of [...headers.keys()]) if (k.startsWith('x-duel-')) headers.delete(k)
    headers.set('x-duel-code', m[1]!)
    headers.set('x-duel-id', encodeURIComponent(JSON.stringify(id)))
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]!))
    return stub.fetch(new Request(`https://room.internal/room/${m[1]}`, { method: 'GET', headers }))
  },
}
