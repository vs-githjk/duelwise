import { DurableObject } from 'cloudflare:workers'
import { dealDecks } from '@duelwise/core/src/games/holdem/match'
import { signDuelResult } from '@duelwise/core/src/duel/result-proof'
import type { Seat } from '@duelwise/core/src/types'
import { RoomHost, type Identity, type LimiterPort, type Out } from './host'
import { CLOSE, isRealtimeGame } from './limits'
import type { LimiterDO } from './limiter-do'
import type { BudgetDO } from './budget-do'
import { RealtimeHost, type RtOut } from './realtime-host'

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDO>
  LIMITER: DurableObjectNamespace<LimiterDO>
  BUDGET: DurableObjectNamespace<BudgetDO>
  /** Secret. Set with `wrangler secret put`, never in wrangler.toml. */
  DUEL_SIGNING_SECRET: string
  /** Comma separated origins allowed to open a socket from a browser; localhost is always allowed. */
  ALLOWED_ORIGINS?: string
}

// Sockets are tagged by caller reference, not by seat: a rematch swaps the seats of sockets that stay open.
const tagOf = (ref: string) => `ref:${ref}`
/** Tag of every socket of a realtime room, so a message after a wake is routed without a storage read. */
const RT_TAG = 'rt'
const refFromTags = (tags: string[]): string | null => {
  const t = tags.find((x) => x.startsWith('ref:'))
  return t ? t.slice(4) : null
}

function randomU32(): number {
  const a = new Uint32Array(1)
  crypto.getRandomValues(a)
  return a[0]!
}

/** An unbiased integer in 0..n-1 from the platform CSPRNG (rejection sampling, no modulo bias). */
function randomBelow(n: number): number {
  const limit = Math.floor(4294967296 / n) * n
  let x = randomU32()
  while (x >= limit) x = randomU32()
  return x % n
}

/**
 * One Durable Object per challenge code (SQLite-backed, WebSocket Hibernation). All rules live in RoomHost; this class
 * maps sockets to it. Identity arrives in the x-duel-id header, which only the Worker in this package can set (it
 * strips any client copy), because room objects have no public route.
 */
export class RoomDO extends DurableObject<Env> {
  private host: RoomHost | null = null
  private rt: RealtimeHost | null = null
  /** Whether this object serves a realtime room. Unknown until a host token names the game or storage is asked once. */
  private realtime: boolean | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private getRt(): RealtimeHost {
    if (this.rt) return this.rt
    const limiterFor = (ref: string) => this.env.LIMITER.get(this.env.LIMITER.idFromName(ref)) as unknown as LimiterDO
    const budget = this.env.BUDGET.get(this.env.BUDGET.idFromName('day')) as unknown as BudgetDO
    this.rt = new RealtimeHost({
      store: {
        get: <T>(k: string) => this.ctx.storage.get<T>(k),
        put: (k, v) => this.ctx.storage.put(k, v),
        deleteAll: () => this.ctx.storage.deleteAll(),
        setAlarm: (at) => (at === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(at)),
      },
      limiter: { reserve: (ref, c, now) => limiterFor(ref).reserve(c, now), release: (ref, c) => limiterFor(ref).release(c) },
      budget: { reserve: (game, refs, now) => budget.reserve(game, refs, now), settle: (extra, now) => budget.settle(extra, now) },
      now: () => Date.now(),
      randomSeed: randomU32,
      randomSeat: () => (randomU32() & 1) as Seat,
      live: (ref) => this.isLive(ref),
      signResult: (rec) => signDuelResult(rec, this.env.DUEL_SIGNING_SECRET),
    })
    return this.rt
  }

  /** A host token names the game; a guest (or the alarm) asks storage once whether this room is a realtime room. */
  private async isRealtime(hostGame?: string): Promise<boolean> {
    if (hostGame !== undefined) return (this.realtime = isRealtimeGame(hostGame)) // a host token is authoritative
    if (this.realtime === null) this.realtime = (await this.ctx.storage.get('rt')) !== undefined
    return this.realtime
  }

  private getHost(): RoomHost {
    if (this.host) return this.host
    const limiterFor = (ref: string) => this.env.LIMITER.get(this.env.LIMITER.idFromName(ref)) as unknown as LimiterDO
    const limiter: LimiterPort = {
      reserve: (ref, c, now) => limiterFor(ref).reserve(c, now),
      release: (ref, c) => limiterFor(ref).release(c),
    }
    this.host = new RoomHost({
      store: {
        get: <T>(k: string) => this.ctx.storage.get<T>(k),
        put: (k, v) => this.ctx.storage.put(k, v),
        deleteAll: () => this.ctx.storage.deleteAll(),
        setAlarm: (at) => (at === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(at)),
      },
      limiter,
      now: () => Date.now(),
      randomSeed: randomU32,
      randomDecks: (hands) => dealDecks(hands, randomBelow),
      randomSeat: () => (randomU32() & 1) as Seat,
      live: (ref) => this.isLive(ref),
      signResult: (rec) => signDuelResult(rec, this.env.DUEL_SIGNING_SECRET),
    })
    return this.host
  }

  private isLive(ref: string): boolean {
    return this.ctx.getWebSockets(tagOf(ref)).some((w) => w.readyState === 1)
  }

  private dispatch(outs: Array<Out | RtOut>): void {
    for (const o of outs) {
      for (const ws of this.ctx.getWebSockets(tagOf(o.ref))) {
        if (ws.readyState !== 1) continue
        if (o.kind === 'send') ws.send(JSON.stringify(o.msg))
        else ws.close(o.code, o.reason)
      }
    }
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 })
    const code = req.headers.get('x-duel-code') ?? ''
    let id: Identity
    try { id = JSON.parse(decodeURIComponent(req.headers.get('x-duel-id') ?? '')) } catch { return new Response('bad identity', { status: 400 }) }
    const rt = await this.isRealtime(id.host?.game)
    const res = rt ? await this.getRt().connect(id, code, req.headers.get('x-duel-cv') ?? '') : await this.getHost().connect(id, code)
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    if (!res.ok) {
      this.ctx.acceptWebSocket(server, ['refused'])
      server.close(res.code, res.reason)
      return new Response(null, { status: 101, webSocket: client })
    }
    for (const old of this.ctx.getWebSockets(tagOf(id.ref))) old.close(CLOSE.replaced, 'replaced')
    this.ctx.acceptWebSocket(server, rt ? [tagOf(id.ref), RT_TAG] : [tagOf(id.ref)])
    this.dispatch(res.out)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const ref = refFromTags(this.ctx.getTags(ws))
    if (ref === null) return
    if (this.ctx.getTags(ws).includes(RT_TAG)) return this.dispatch(await this.getRt().message(ref, message))
    this.dispatch(await this.hostAfterWake().message(ref, message))
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const ref = refFromTags(this.ctx.getTags(ws))
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason) } catch { /* already closed */ }
    if (ref === null) return
    if (this.ctx.getTags(ws).includes(RT_TAG)) return this.dispatch(await this.getRt().disconnect(ref))
    this.dispatch(await this.hostAfterWake().disconnect(ref))
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, 'error')
  }

  async alarm(): Promise<void> {
    if (await this.isRealtime()) return this.dispatch(await this.getRt().alarm())
    this.dispatch(await this.hostAfterWake().alarm())
  }

  /** After hibernation the object is rebuilt: the host reloads the room from storage on first use. */
  private hostAfterWake(): RoomHost {
    return this.getHost()
  }
}
