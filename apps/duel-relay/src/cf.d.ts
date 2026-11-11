// The few Cloudflare Workers runtime types this package uses. The full @cloudflare/workers-types package is not
// installed (not an approved install), so this file declares just these; it is checked against the real runtime by
// test/room-do.test.ts, which runs workerd through wrangler.
declare module 'cloudflare:workers' {
  export class DurableObject<E = unknown> {
    constructor(ctx: DurableObjectState, env: E)
    protected ctx: DurableObjectState
    protected env: E
  }
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  deleteAll(): Promise<void>
  setAlarm(at: number): Promise<void>
  deleteAlarm(): Promise<void>
}

interface DurableObjectState {
  storage: DurableObjectStorage
  acceptWebSocket(ws: WebSocket, tags?: string[]): void
  getWebSockets(tag?: string): WebSocket[]
  getTags(ws: WebSocket): string[]
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>
}

declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string)
}

declare class WebSocketPair {
  0: WebSocket
  1: WebSocket
}

interface DurableObjectId {}
interface DurableObjectStub {
  fetch(req: Request): Promise<Response>
}
interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub & T
}

interface ResponseInit {
  webSocket?: WebSocket | null
}
