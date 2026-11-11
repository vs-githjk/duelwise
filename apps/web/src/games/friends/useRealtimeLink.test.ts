import { describe, expect, test } from 'bun:test'
import { NO_INPUT, PUCK_CORE_VERSION } from '@duelwise/core/src/games/puck/constants'
import { DelayPipe, RealtimeClient, RT_VOID_MS, RT_WAIT_MS, parseNetShim, waitingForFriend, type RealtimeOptions } from './useRealtimeLink'
import { pingTone } from './PingChip'
import { RELAY_CLOSE, type Clock, type SocketLike } from './useRemoteDuel'

// S8: the realtime link with a fake socket and a fake clock.

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
  json() { return this.sent.filter((x) => x !== 'ping').map((x) => JSON.parse(x)) }
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

function rig(over: Partial<RealtimeOptions> = {}) {
  const sockets: FakeSocket[] = []
  const clock = new FakeClock()
  const client = new RealtimeClient({
    relayUrl: 'ws://relay.test/', code: 'ABCDEF', getToken: async () => 'seat.token', clock, now: () => clock.now,
    createSocket: (u) => { const s = new FakeSocket(u); sockets.push(s); return s },
    ...over,
  })
  return { client, sockets, clock }
}

const go = (over: Record<string, unknown> = {}) => ({ t: 'go', game: 'fighter', seed: 555, you: 0, names: ['Sam', 'Ada'], picks: [null, null], at: 0, have: 0, ...over })

async function inMatch(over: Partial<RealtimeOptions> = {}) {
  const r = rig(over)
  r.client.start()
  await flush()
  const s = r.sockets[0]!
  s.open()
  s.say({ t: 'lobby', you: 0, names: ['Sam', 'Ada'], ready: [false, false] })
  s.say(go())
  return { ...r, s }
}

describe('core version (F2)', () => {
  test('the socket url carries the puck core version, and the relay refusing it ends the link as outdated without retrying', async () => {
    const { client, sockets } = rig()
    client.start()
    await flush()
    expect(sockets[0]!.url).toBe(`ws://relay.test/room/ABCDEF?t=seat.token&cv=${PUCK_CORE_VERSION}`)
    expect(PUCK_CORE_VERSION).toBe('puck-2')
    sockets[0]!.drop(RELAY_CLOSE.outdated)
    expect(client.getState()).toMatchObject({ status: 'closed', closed: 'outdated' })
    expect(sockets).toHaveLength(1)
  })
})

describe('round trip', () => {
  test('a ping goes out on open, the pong time is the round trip, later samples are smoothed, and the interval is 2 s in the lobby and 1 s in play', async () => {
    const { client, sockets, clock } = rig()
    client.start()
    await flush()
    const s = sockets[0]!
    s.open()
    expect(s.sent).toEqual(['ping'])
    clock.advance(80)
    s.say('pong')
    expect(client.getState().rttMs).toBe(80)
    clock.advance(1920)
    expect(s.sent.filter((x) => x === 'ping')).toHaveLength(2) // 2 s later
    clock.advance(100)
    s.say('pong')
    expect(client.getState().rttMs).toBeCloseTo(80 * 0.8 + 100 * 0.2, 5)
    s.say({ t: 'lobby', you: 0, names: ['Sam', 'Ada'], ready: [true, true] })
    s.say(go())
    const before = s.sent.filter((x) => x === 'ping').length
    for (let i = 0; i < 3; i++) { clock.advance(1000); s.say('pong') } // answered, so the next one may go
    expect(s.sent.filter((x) => x === 'ping').length - before).toBe(3) // now every second
  })

  test('a pong nobody asked for is ignored', async () => {
    const { client, sockets } = rig()
    client.start()
    await flush()
    sockets[0]!.open()
    sockets[0]!.say('pong')
    sockets[0]!.say('pong')
    expect(client.getState().rttMs).toBeLessThan(5)
  })
})

describe('inputs out', () => {
  test('a change goes out every 2 frames, a held input every 4 (keepalive), no code is lost, and never more than 30 messages a second', async () => {
    const { client, s } = await inMatch()
    const pushed: number[] = []
    let f = 2
    for (; f < 2 + 120; f++) { const c = f < 62 ? f % 7 : 3; pushed.push(c); client.pushInput(f, c) }
    const msgs = s.json().filter((m) => m.t === 'in')
    // contiguous and complete
    let next = 2
    const got: number[] = []
    for (const m of msgs) { expect(m.f).toBe(next); next += m.c.length; got.push(...m.c) }
    expect(got).toEqual(pushed.slice(0, got.length))
    expect(pushed.length - got.length).toBeLessThan(4)
    const changing = msgs.filter((m) => m.f < 62)
    expect(changing.every((m) => m.c.length === 2)).toBe(true)
    const held = msgs.filter((m) => m.f >= 62)
    expect(held.length).toBeGreaterThan(5)
    expect(held.slice(1).every((m) => m.c.length === 4)).toBe(true)
    expect(msgs.length / 2).toBeLessThanOrEqual(30) // 120 frames is 2 seconds
  })

  test('puck matches idle on NO_INPUT, so a held idle is a keepalive and a first move is a change', async () => {
    const { client, s } = await inMatch()
    s.say(go({ game: 'puck', seed: 9 }))
    expect(s.json().filter((m) => m.t === 'in')).toHaveLength(0)
    for (let f = 2; f < 6; f++) client.pushInput(f, NO_INPUT)
    expect(s.json().filter((m) => m.t === 'in')).toHaveLength(1) // 4 held frames: one keepalive
  })

  test('the hash of a confirmed frame rides on the next message, once', async () => {
    const { client, s } = await inMatch()
    client.reportHash(60, '0123456789abcdef')
    client.pushInput(2, 1)
    client.pushInput(3, 2)
    client.pushInput(4, 3)
    client.pushInput(5, 4)
    const msgs = s.json().filter((m) => m.t === 'in')
    expect(msgs[0]).toMatchObject({ f: 2, hf: 60, h: '0123456789abcdef' })
    expect(msgs[1].h).toBeUndefined()
  })

  test('inputs pushed outside a match go nowhere', async () => {
    const r = rig()
    r.client.start()
    await flush()
    r.sockets[0]!.open()
    r.client.pushInput(2, 1)
    r.client.pushInput(3, 1)
    expect(r.sockets[0]!.json()).toEqual([])
  })
})

describe('inputs in, snapshots, the result', () => {
  test('the friend\'s inputs reach the session in order; a snapshot reaches resync; the signed result is kept and a void match has none', async () => {
    const { client, s } = await inMatch()
    const link = client.link()
    const got: Array<[number, number[]]> = []
    const snaps: Array<[number, unknown]> = []
    link.onRemote((f, c) => got.push([f, c]))
    link.onSnap((f, st) => snaps.push([f, st]))
    s.say({ t: 'in', s: 1, f: 2, c: [1, 2] })
    s.say({ t: 'in', s: 1, f: 4, c: [3] })
    s.say({ t: 'snap', f: 60, state: { frame: 60 } })
    expect(got).toEqual([[2, [1, 2]], [4, [3]]])
    expect(snaps).toEqual([[60, { frame: 60 }]])
    s.say({ t: 'over', result: { winner: 0, score: [2, 0], reason: 'rounds' }, void: null })
    s.say({ t: 'result', proof: 'body.sig' })
    expect(client.getState()).toMatchObject({ phase: 'over', proof: 'body.sig', over: { void: null, result: { winner: 0 } } })
    // next match: proof cleared, counted once more
    s.say(go({ seed: 556 }))
    expect(client.getState()).toMatchObject({ phase: 'playing', proof: null, over: null, matchNo: 2 })
    s.say({ t: 'over', result: null, void: 'lost' })
    expect(client.getState().over).toEqual({ result: null, void: 'lost' })
    expect(client.getState().proof).toBeNull()
  })

  test('a new match clears the old ready votes and takes the new seat, so a rematch page does not read stale ones', async () => {
    const { client, s } = await inMatch()
    s.say({ t: 'lobby', you: 0, names: ['Sam', 'Ada'], ready: [true, false] })
    s.say({ t: 'over', result: { winner: 0, score: [7, 1], reason: 'First to 7' }, void: null })
    s.say({ t: 'lobby', you: 0, names: ['Sam', 'Ada'], ready: [false, true] })
    expect(client.getState().lobby?.ready).toEqual([false, true])
    s.say(go({ seed: 777, you: 1 }))
    expect(client.getState().lobby).toEqual({ you: 1, names: ['Sam', 'Ada'], ready: [false, false] })
  })

  test('junk is ignored: a bad go, an in without codes, a proof that is too long, text that is not JSON', async () => {
    const { client, s } = await inMatch()
    const n = client.getState().matchNo
    s.say({ t: 'go', game: 'chess', seed: 1, you: 0, names: ['a', 'b'], at: 0, have: 0 })
    s.say({ t: 'in', f: 2, c: [] })
    s.say({ t: 'result', proof: 'x'.repeat(3000) })
    s.say('{not json')
    expect(client.getState().matchNo).toBe(n)
    expect(client.getState().proof).toBeNull()
  })
})

describe('D7: a quiet friend, a gone friend', () => {
  test('3 seconds without a word from the friend shows "Waiting for Ada", a word clears it, 20 seconds sends `lost` once and the relay\'s void ends the match', async () => {
    const { client, s, clock } = await inMatch()
    s.say({ t: 'in', s: 1, f: 2, c: [0] })
    clock.advance(RT_WAIT_MS - 600)
    expect(waitingForFriend(client.getState())).toBeNull()
    clock.advance(1100)
    expect(waitingForFriend(client.getState())).toBe('Waiting for Ada')
    s.say({ t: 'in', s: 1, f: 3, c: [0] })
    expect(waitingForFriend(client.getState())).toBeNull()
    clock.advance(RT_VOID_MS + 600)
    expect(s.json().filter((m) => m.t === 'lost')).toHaveLength(1)
    clock.advance(5000)
    expect(s.json().filter((m) => m.t === 'lost')).toHaveLength(1)
    s.say({ t: 'over', result: null, void: 'lost' })
    expect(client.getState()).toMatchObject({ phase: 'over', waiting: false, over: { void: 'lost' } })
  })

  test('while playing, a keepalive {t:"k"} goes out every 3 seconds that no input did, and not while inputs flow or outside a match', async () => {
    const { client, s, clock } = await inMatch()
    const ks = () => s.json().filter((m) => m.t === 'k').length
    clock.advance(2900)
    expect(ks()).toBe(0)
    clock.advance(600)
    expect(ks()).toBe(1)
    clock.advance(3000)
    expect(ks()).toBe(2)
    // inputs going out count as life
    for (let f = 2; f < 40; f += 2) { clock.advance(1000); client.pushInput(f, 1); client.pushInput(f + 1, 2) }
    expect(ks()).toBe(2)
    s.say({ t: 'over', result: null, void: 'lost' })
    clock.advance(10_000)
    expect(ks()).toBe(2)
  })

  test('a peer notice of a gone friend shows the wait at once, and their return clears it', async () => {
    const { client, s, clock } = await inMatch()
    s.say({ t: 'peer', connected: false })
    clock.advance(600)
    expect(waitingForFriend(client.getState())).toBe('Waiting for Ada')
    s.say({ t: 'peer', connected: true })
    expect(waitingForFriend(client.getState())).toBeNull()
  })

  test('while this phone\'s own socket is down the wait timers are stopped, so it does not blame the friend', async () => {
    const { client, s, sockets, clock } = await inMatch()
    s.drop(1006)
    expect(client.getState().status).toBe('reconnecting')
    clock.advance(1000)
    await flush()
    expect(sockets.length).toBeGreaterThan(1) // it is trying again
    clock.advance(60_000)
    expect(client.getState().waiting).toBe(false)
  })

  test('reconnect into the same match: the friend\'s inputs are asked for from where this side stopped and ours are resent from where the relay stopped; the match is not restarted', async () => {
    const { client, s, sockets, clock } = await inMatch()
    for (let f = 2; f < 22; f++) client.pushInput(f, f % 5)
    s.say({ t: 'in', s: 1, f: 2, c: Array(10).fill(1) })
    s.drop(1006)
    clock.advance(400)
    await flush()
    const s2 = sockets[1]!
    s2.open()
    // the relay got our frames up to 12 only
    s2.say(go({ at: 12, have: 12 }))
    const sent = s2.json()
    expect(sent[0]).toEqual({ t: 'need', f: 12 })
    const resent = sent.filter((m) => m.t === 'in')
    expect(resent[0].f).toBe(12)
    expect(resent.flatMap((m) => m.c)).toEqual(Array.from({ length: 10 }, (_, i) => (12 + i) % 5))
    expect(client.getState()).toMatchObject({ phase: 'playing', matchNo: 1, status: 'live' })
  })

  test('a relay that has none of our frames gets them from the first one pushed, never from frame 0 (frames before it stay idle there)', async () => {
    const { client, s, sockets, clock } = await inMatch()
    for (let f = 2; f < 8; f++) client.pushInput(f, 9)
    s.drop(1006)
    clock.advance(400)
    await flush()
    sockets[1]!.open()
    sockets[1]!.say(go({ at: 0, have: 0 }))
    const resent = sockets[1]!.json().filter((m) => m.t === 'in')
    expect(resent[0].f).toBe(2)
    expect(resent.flatMap((m) => m.c)).toEqual([9, 9, 9, 9, 9, 9])
  })

  test('a lobby arriving in the middle of a match means the relay ended it while this phone was away: void, no proof', async () => {
    const { client, s, sockets, clock } = await inMatch()
    s.drop(1006)
    clock.advance(400)
    await flush()
    sockets[1]!.open()
    sockets[1]!.say({ t: 'lobby', you: 0, names: ['Sam', 'Ada'], ready: [false, false] })
    expect(client.getState()).toMatchObject({ phase: 'over', over: { result: null, void: 'lost' }, proof: null })
  })
})

describe('closing and the lobby', () => {
  test('ready, rematch and resign are the relay\'s own messages; the rate limit close is final', async () => {
    const { client, s } = await inMatch()
    client.ready(3)
    client.rematch()
    client.resign()
    expect(s.json().slice(-3)).toEqual([{ t: 'ready', pick: 3 }, { t: 'rematch' }, { t: 'resign' }])
    s.drop(RELAY_CLOSE.rate)
    expect(client.getState()).toMatchObject({ status: 'closed', closed: 'rate' })
  })

  test('a host backing out of an empty room resigns it; a close with a friend present does not', async () => {
    const r = rig()
    r.client.start()
    await flush()
    const s = r.sockets[0]!
    s.open()
    s.say({ t: 'lobby', you: 0, names: ['Sam', null], ready: [false, false] })
    r.client.cancel()
    expect(s.json()).toEqual([{ t: 'resign' }])
    const r2 = rig()
    r2.client.start()
    await flush()
    r2.sockets[0]!.open()
    r2.sockets[0]!.say({ t: 'lobby', you: 0, names: ['Sam', 'Ada'], ready: [false, false] })
    r2.client.cancel()
    expect(r2.sockets[0]!.json()).toEqual([])
  })

  test('the relay\'s refusals reach the page as lastError', async () => {
    const { client, s } = await inMatch()
    s.say({ t: 'error', error: 'busy' })
    expect(client.getState().lastError).toBe('busy')
  })
})

describe('the latency shim keeps order', () => {
  test('messages leave in the order they came in even when the timers for one instant fire the other way round', () => {
    // A clock whose timers due at the same moment fire newest first (a browser may do this for timers set a millisecond apart).
    let now = 0
    const timers: Array<{ at: number; id: number; fn: () => void }> = []
    let ids = 0
    const clock = {
      setTimeout: (fn: () => void, ms: number) => { timers.push({ at: now + ms, id: ++ids, fn }); return ids },
      clearTimeout: (id: unknown) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) },
      setInterval: () => 0,
      clearInterval: () => undefined,
    } as unknown as Clock
    const pipe = new DelayPipe(clock, () => now)
    const out: number[] = []
    pipe.push(100, () => out.push(1))
    now = 1
    pipe.push(99, () => out.push(2))
    now = 2
    pipe.push(98, () => out.push(3))
    // the pipe holds one timer for the head; fire due timers, newest first
    for (let t = 0; t <= 110; t++) {
      now = t
      for (;;) {
        const due = timers.filter((x) => x.at <= now).sort((a, b) => b.id - a.id)[0]
        if (!due) break
        timers.splice(timers.indexOf(due), 1)
        due.fn()
      }
    }
    expect(out).toEqual([1, 2, 3])
  })
})

describe('the latency shim', () => {
  test('inert without ?net=, in a production build, and for nonsense', () => {
    expect(parseNetShim('', true)).toBeNull()
    expect(parseNetShim('?x=1', true)).toBeNull()
    expect(parseNetShim('?net=60,20', false)).toBeNull()
    expect(parseNetShim('?net=abc', true)).toBeNull()
    expect(parseNetShim('?net=99999', true)).toBeNull()
    expect(parseNetShim('?net=-5', true)).toBeNull()
    expect(parseNetShim('?net=60,20', true)).toEqual({ delayMs: 60, jitterMs: 20 })
    expect(parseNetShim('?net=40', true)).toEqual({ delayMs: 40, jitterMs: 0 })
  })

  test('without a shim a message arrives and leaves at once; with one, both ways wait, in order', async () => {
    const plain = await inMatch()
    plain.client.pushInput(2, 1)
    plain.client.pushInput(3, 1)
    expect(plain.s.json().filter((m) => m.t === 'in')).toHaveLength(1)

    const r = rig({ shim: { delayMs: 60, jitterMs: 20 }, random: () => 0.5 })
    r.client.start()
    await flush()
    const s = r.sockets[0]!
    s.open()
    r.clock.advance(100)
    s.say({ t: 'lobby', you: 0, names: ['Sam', 'Ada'], ready: [false, false] })
    expect(r.client.getState().lobby).toBeNull() // not yet: 70 ms in flight
    r.clock.advance(69)
    expect(r.client.getState().lobby).toBeNull()
    r.clock.advance(2)
    expect(r.client.getState().lobby).not.toBeNull()
    s.say(go())
    r.clock.advance(80)
    const before = s.json().length
    r.client.pushInput(2, 1)
    r.client.pushInput(3, 1)
    expect(s.json().length).toBe(before) // held back
    r.clock.advance(71)
    expect(s.json().length).toBe(before + 1)
  })
})

describe('the ping chip', () => {
  test('green under 60 ms, amber up to 120, red above', () => {
    expect([pingTone(1), pingTone(59.9), pingTone(60), pingTone(120), pingTone(120.1), pingTone(400)]).toEqual(['good', 'good', 'warn', 'warn', 'bad', 'bad'])
  })
})
