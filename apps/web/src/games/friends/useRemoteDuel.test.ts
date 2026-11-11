import { describe, expect, test } from 'bun:test'
import { RemoteDuelClient, waitingFor, RELAY_CLOSE, type Clock, type SocketLike } from './useRemoteDuel'
import { relayUrl } from './session'

class FakeSocket implements SocketLike {
  sent: string[] = []
  closedWith: number | undefined
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  constructor(readonly url: string) {}
  send(d: string) { this.sent.push(d) }
  close(code?: number) { this.closedWith = code }
  open() { this.onopen?.({}) }
  say(m: unknown) { this.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) }) }
  drop(code = 1006) { this.onclose?.({ code }) }
}

class FakeClock implements Clock {
  now = 0
  private id = 0
  timers = new Map<number, { at: number; fn: () => void; every?: number }>()
  setTimeout(fn: () => void, ms: number) { this.timers.set(++this.id, { at: this.now + ms, fn }); return this.id }
  clearTimeout(id: unknown) { this.timers.delete(id as number) }
  setInterval(fn: () => void, ms: number) { this.timers.set(++this.id, { at: this.now + ms, fn, every: ms }); return this.id }
  clearInterval(id: unknown) { this.timers.delete(id as number) }
  advance(ms: number) {
    const end = this.now + ms
    for (;;) {
      const next = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      const [id, t] = next
      this.now = t.at
      if (t.every) t.at += t.every
      else this.timers.delete(id)
      t.fn()
    }
    this.now = end
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

const view = (over: Record<string, unknown> = {}) => ({
  t: 'view', game: 'chess', obs: {}, legal: [], canAct: false, opponentReady: false, n: 3, status: 'playing', result: null, you: 0,
  names: ['Sam', 'Ada'], connected: [true, true], seed: null, rematch: [false, false], tally: { you: 0, them: 0, draws: 0 }, ...over,
})

function rig(over: { getToken?: () => Promise<string>; onTokenRefused?: () => void; maxAttempts?: number } = {}) {
  const sockets: FakeSocket[] = []
  const clock = new FakeClock()
  const client = new RemoteDuelClient({
    relayUrl: 'ws://relay.test/',
    code: 'ABCDEF',
    getToken: over.getToken ?? (async () => 'seat.token'),
    onTokenRefused: over.onTokenRefused,
    maxAttempts: over.maxAttempts,
    clock,
    createSocket: (u) => {
      const s = new FakeSocket(u)
      sockets.push(s)
      return s
    },
  })
  return { client, sockets, clock }
}

describe('the signed result', () => {
  test('keeps the relay proof once the game is over, drops it when a new game starts, and ignores junk', async () => {
    const { client, sockets } = rig()
    client.start()
    await flush()
    sockets[0]!.open()
    sockets[0]!.say(view({ status: 'over', result: { winner: 0, score: [1, 0], reason: 'checkmate' }, seed: 5 }))
    expect(client.getState().proof).toBeNull()
    sockets[0]!.say({ t: 'result', proof: 'body.sig' })
    expect(client.getState().proof).toBe('body.sig')
    // a repeat of the same final view (a reconnect, a rematch vote) keeps it
    sockets[0]!.say(view({ status: 'over', rematch: [true, false] }))
    expect(client.getState().proof).toBe('body.sig')
    sockets[0]!.say({ t: 'result', proof: 42 })
    sockets[0]!.say({ t: 'result', proof: 'x'.repeat(3000) })
    expect(client.getState().proof).toBe('body.sig')
    // the rematch started: the old game's proof must not be offered for the new game
    sockets[0]!.say(view({ status: 'playing' }))
    expect(client.getState().proof).toBeNull()
  })
})

describe('RemoteDuelClient', () => {
  test('opens wss://relay/room/CODE?t=token, goes live, and holds the relay view', async () => {
    const { client, sockets } = rig()
    client.start()
    await flush()
    expect(sockets[0]!.url).toBe('ws://relay.test/room/ABCDEF?t=seat.token')
    sockets[0]!.open()
    sockets[0]!.say(view())
    expect(client.getState().status).toBe('live')
    expect(client.getState().view?.names).toEqual(['Sam', 'Ada'])
    expect(client.getState().peerConnected).toBe(true)
  })

  test('reconnect resends the same seat token and redraws from the relay view', async () => {
    const { client, sockets, clock } = rig()
    client.start()
    await flush()
    sockets[0]!.open()
    sockets[0]!.say(view({ n: 3 }))
    sockets[0]!.drop(1006)
    expect(client.getState().status).toBe('reconnecting')
    expect(client.getState().view?.n).toBe(3) // the board does not blank while we reconnect
    clock.advance(500)
    await flush()
    expect(sockets).toHaveLength(2)
    expect(sockets[1]!.url).toBe(sockets[0]!.url)
    sockets[1]!.open()
    sockets[1]!.say(view({ n: 5 }))
    expect(client.getState().status).toBe('live')
    expect(client.getState().view?.n).toBe(5)
    expect(client.getState().attempts).toBe(0)
  })

  test('a dropped peer shows "Waiting for Ada" and clears when she is back', async () => {
    const { client, sockets } = rig()
    client.start()
    await flush()
    sockets[0]!.open()
    sockets[0]!.say(view())
    expect(waitingFor(client.getState())).toBeNull()
    sockets[0]!.say({ t: 'peer', connected: false })
    expect(waitingFor(client.getState())).toBe('Waiting for Ada')
    sockets[0]!.say({ t: 'peer', connected: true })
    expect(waitingFor(client.getState())).toBeNull()
  })

  test('a waiting room says nothing about a missing friend (that is the share screen)', async () => {
    const { client, sockets } = rig()
    client.start()
    await flush()
    sockets[0]!.open()
    sockets[0]!.say(view({ status: 'waiting', names: ['Sam', ''], connected: [true, false] }))
    expect(waitingFor(client.getState())).toBeNull()
  })

  test('moves are refused while the socket is down and sent once it is up', async () => {
    const { client, sockets } = rig()
    client.start()
    await flush()
    expect(client.send({ t: 'act', a: 4, n: 3 })).toBe(false)
    sockets[0]!.open()
    expect(client.send({ t: 'act', a: 4, n: 3 })).toBe(true)
    expect(sockets[0]!.sent).toEqual(['{"t":"act","a":4,"n":3}'])
    sockets[0]!.drop(1006)
    expect(client.send({ t: 'act', a: 5, n: 3 })).toBe(false)
  })

  test('terminal close codes end the link with a reason and never retry', async () => {
    for (const [code, reason] of [[RELAY_CLOSE.noRoom, 'no-room'], [RELAY_CLOSE.full, 'full'], [RELAY_CLOSE.expired, 'expired'], [RELAY_CLOSE.replaced, 'replaced'], [RELAY_CLOSE.dailyLimit, 'daily-limit'], [RELAY_CLOSE.tooManyRooms, 'too-many-rooms'], [RELAY_CLOSE.roomLimit, 'used-up'], [4499, 'used-up']] as const) {
      const { client, sockets, clock } = rig()
      client.start()
      await flush()
      sockets[0]!.open()
      sockets[0]!.drop(code)
      expect(client.getState()).toMatchObject({ status: 'closed', closed: reason })
      clock.advance(60_000)
      await flush()
      expect(sockets).toHaveLength(1)
    }
  })

  test('a refused upgrade (never opened) drops the stored token and gives up after the attempt cap', async () => {
    let refused = 0
    const { client, sockets, clock } = rig({ onTokenRefused: () => refused++, maxAttempts: 2 })
    client.start()
    for (let i = 0; i < 6; i++) {
      await flush()
      sockets.at(-1)?.drop(1006)
      clock.advance(10_000)
    }
    await flush()
    expect(client.getState()).toMatchObject({ status: 'closed', closed: 'refused' })
    expect(refused).toBe(3)
    expect(sockets).toHaveLength(3)
  })

  test('keeps the socket alive with ping every 25 s and asks for a view when the phone wakes', async () => {
    const { client, sockets, clock } = rig()
    client.start()
    await flush()
    sockets[0]!.open()
    clock.advance(26_000)
    expect(sockets[0]!.sent).toContain('ping')
    sockets[0]!.say('pong')
    client.nudge()
    expect(sockets[0]!.sent.at(-1)).toBe('{"t":"sync"}')
  })

  test('a nudge while waiting to retry reconnects at once', async () => {
    const { client, sockets } = rig()
    client.start()
    await flush()
    sockets[0]!.open()
    sockets[0]!.drop(1006)
    client.nudge()
    await flush()
    expect(sockets).toHaveLength(2)
  })

  test('cancelling a waiting room tells the relay to delete it, then closes', async () => {
    const { client, sockets } = rig()
    client.start()
    await flush()
    sockets[0]!.open()
    sockets[0]!.say(view({ status: 'waiting', names: ['Sam', ''], connected: [true, false] }))
    client.cancel()
    expect(sockets[0]!.sent).toContain('{"t":"resign"}')
    expect(sockets[0]!.closedWith).toBe(1000)
    expect(client.getState().status).toBe('closed')
  })

  test('suspend then start (React strict mode) opens a fresh socket; close stays closed', async () => {
    const { client, sockets } = rig()
    client.start()
    await flush()
    client.suspend()
    client.start()
    await flush()
    expect(sockets).toHaveLength(2)
    client.close()
    client.start()
    await flush()
    expect(sockets).toHaveLength(2)
  })

  test('the DuelLink port replays the current view and peer state and forwards sends', async () => {
    const { client, sockets } = rig()
    client.start()
    await flush()
    sockets[0]!.open()
    sockets[0]!.say(view())
    const link = client.link()
    const seen: number[] = []
    const peers: boolean[] = []
    link.onView((v) => seen.push(v.n))
    link.onPeer((c) => peers.push(c))
    expect(seen).toEqual([3])
    expect(peers).toEqual([true])
    link.send({ t: 'rematch' })
    expect(sockets[0]!.sent.at(-1)).toBe('{"t":"rematch"}')
  })
})

describe('relayUrl', () => {
  test('comes from VITE_DUEL_RELAY_URL, falls back to wrangler dev only in dev, and is null in a build without it', () => {
    expect(relayUrl({ VITE_DUEL_RELAY_URL: 'wss://duel.example.workers.dev/' })).toBe('wss://duel.example.workers.dev')
    expect(relayUrl({ DEV: true })).toBe('ws://127.0.0.1:8787')
    expect(relayUrl({ DEV: false })).toBeNull()
  })
})
