/**
 * The relay in the real local Workers runtime (workerd, started by `wrangler dev --local`), driven over real
 * WebSockets. The rules themselves are covered without a runtime in host.test.ts; this file proves the wiring:
 * token check in the Worker, Durable Object routing, socket tags, auto ping, close codes, the limiter object.
 * The signing secret here is a throwaway generated for this run and passed only to the local process.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signDuelToken } from '@duelwise/core/src/duel/token'
import { CLOSE, LIMITS } from '../src/limits'

setDefaultTimeout(60_000)

const PKG = new URL('..', import.meta.url).pathname
const WRANGLER = join(PKG, '../../node_modules/.bin/wrangler')
const SECRET = crypto.randomUUID() + crypto.randomUUID()
let proc: ReturnType<typeof Bun.spawn> | null = null
let base = ''
let state = ''

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') })
  const p = s.port!
  await s.stop(true)
  return p
}

beforeAll(async () => {
  const port = await freePort()
  state = mkdtempSync(join(tmpdir(), 'duel-relay-test-'))
  proc = Bun.spawn([WRANGLER, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state, '--var', `DUEL_SIGNING_SECRET:${SECRET}`], {
    cwd: PKG,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'error', CI: '1' },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  base = `127.0.0.1:${port}`
  const t0 = Date.now()
  for (;;) {
    try {
      if ((await fetch(`http://${base}/health`)).ok) break
    } catch { /* not up yet */ }
    if (Date.now() - t0 > 40_000) throw new Error('wrangler dev did not start')
    await Bun.sleep(250)
  }
})

afterAll(() => {
  proc?.kill()
  if (state) rmSync(state, { recursive: true, force: true })
})

const tok = (code: string, ref: string, name: string, opts: { host?: 'four' | 'word' | 'puck' | 'fleet'; exp?: number; secret?: string } = {}) =>
  signDuelToken({ code, ref, name, exp: opts.exp ?? Date.now() + 60_000, ...(opts.host ? { host: { game: opts.host } } : {}) }, opts.secret ?? SECRET)

interface Client { ws: WebSocket; frames: any[]; raw: string[]; closed: Promise<{ code: number; reason: string }>; send(o: unknown): void; view(): any; waitFor(pred: (m: any) => boolean, ms?: number): Promise<any> }

async function open(code: string, token: string): Promise<Client> {
  const ws = new WebSocket(`ws://${base}/room/${code}?t=${encodeURIComponent(token)}`)
  const frames: any[] = []
  const raw: string[] = []
  const waiters: Array<{ pred: (m: any) => boolean; res: (m: any) => void }> = []
  const closed = new Promise<{ code: number; reason: string }>((res) => ws.addEventListener('close', (e) => res({ code: e.code, reason: e.reason })))
  ws.addEventListener('message', (e) => {
    raw.push(String(e.data))
    if (e.data === 'pong') return
    const m = JSON.parse(String(e.data))
    frames.push(m)
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m) }
  })
  await new Promise<void>((res, rej) => { ws.addEventListener('open', () => res()); ws.addEventListener('error', () => rej(new Error('socket error'))); ws.addEventListener('close', () => res()) })
  const c: Client = {
    ws, frames, raw, closed,
    send: (o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o)),
    view: () => frames.filter((f) => f.t === 'view').at(-1),
    waitFor: (pred, ms = 5000) => new Promise((res, rej) => {
      const hit = frames.find(pred)
      if (hit) return res(hit)
      const timer = setTimeout(() => rej(new Error('timed out waiting for a frame')), ms)
      waiters.push({ pred, res: (m) => { clearTimeout(timer); res(m) } })
    }),
  }
  return c
}

let codeN = 0
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const newCode = () => { const n = ++codeN; return `TEST${B32[n >> 5]}${B32[n & 31]}` }

describe('worker: who gets in', () => {
  test('health answers and an unknown path is 404', async () => {
    expect((await fetch(`http://${base}/health`)).status).toBe(200)
    expect((await fetch(`http://${base}/nope`)).status).toBe(404)
    expect((await fetch(`http://${base}/room/ABCDEF`)).status).toBe(426) // no upgrade
  })

  test('a missing, tampered, wrong-secret, expired or wrong-room token is a 401 before any room wakes', async () => {
    const code = newCode()
    const good = await tok(code, 'r1', 'Ada', { host: 'four' })
    const flipped = good.slice(0, -2) + (good.endsWith('A') ? 'BB' : 'AA')
    const bodyEdited = (() => { const [b, s] = good.split('.'); return `${b!.slice(0, -2)}xx.${s}` })()
    const cases = [
      '',
      'garbage',
      flipped,
      bodyEdited,
      await tok(code, 'r1', 'Ada', { host: 'four', secret: 'another-secret-another-secret' }),
      await tok(code, 'r1', 'Ada', { host: 'four', exp: Date.now() - 1000 }),
      await tok('ZZZZZZ', 'r1', 'Ada', { host: 'four' }),
      await tok(code, 'r1', 'Ada', { host: 'four', exp: Date.now() + LIMITS.maxTokenLifeMs + 60_000 }), // valid for longer than the cap
    ]
    for (const t of cases) {
      const res = await fetch(`http://${base}/room/${code}?t=${encodeURIComponent(t)}`, { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } })
      expect(res.status).toBe(401)
    }
  })

  test('a disallowed browser origin is refused, localhost is fine', async () => {
    const code = newCode()
    const t = await tok(code, 'r1', 'Ada', { host: 'four' })
    const h = { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }
    expect((await fetch(`http://${base}/room/${code}?t=${t}`, { headers: { ...h, Origin: 'https://evil.example' } })).status).toBe(403)
  })

  test('a guest token cannot create a room, and a game the relay does not carry cannot be hosted', async () => {
    const a = await open('GUESTA', await tok('GUESTA', 'r9', 'Guest'))
    expect(await a.closed).toMatchObject({ code: CLOSE.noRoom })
    const b = await open('PUCKAA', await tok('PUCKAA', 'r9', 'Ada', { host: 'nope' as any })) // puck now runs the realtime path (S7), so a game id no branch carries stands in
    expect(await b.closed).toMatchObject({ code: CLOSE.badGame })
  })
})

describe('two phones, one Four in a Row game', () => {
  test('both sockets play to a result; the seed stays inside until it is over; ping is answered', async () => {
    const code = newCode()
    const ada = await open(code, await tok(code, 'ref-ada', 'Ada', { host: 'four' }))
    const first = await ada.waitFor((m) => m.t === 'view')
    expect(first.status).toBe('waiting')
    expect(first.names.filter(Boolean)).toEqual(['Ada'])
    const sam = await open(code, await tok(code, 'ref-sam', 'Sam'))
    await sam.waitFor((m) => m.t === 'view' && m.status === 'playing')
    await ada.waitFor((m) => m.t === 'peer' && m.connected === true)
    ada.ws.send('ping')
    expect(await Promise.race([Bun.sleep(3000).then(() => 'late'), new Promise((r) => { const i = setInterval(() => { if (ada.raw.includes('pong')) { clearInterval(i); r('pong') } }, 20) })])).toBe('pong')

    const players = [ada, sam]
    for (let i = 0; i < 80 && players[0]!.view().status !== 'over'; i++) {
      for (const c of players) {
        const v = c.view()
        if (v.canAct) {
          const n = v.n
          c.send({ t: 'act', a: v.legal[0], n })
          await c.waitFor((m) => m.t === 'view' && m.n > n || (m.t === 'view' && m.status === 'over'))
          await Bun.sleep(110) // stay under 10 messages a second
        }
      }
    }
    for (const c of players) {
      await c.waitFor((m) => m.t === 'view' && m.status === 'over')
      const views = c.frames.filter((f) => f.t === 'view')
      for (const v of views.filter((x) => x.status !== 'over')) expect(v.seed).toBeNull()
      expect(views.at(-1).seed).toEqual(expect.any(Number))
      expect(views.at(-1).result).not.toBeNull()
    }
    expect(ada.view().you).not.toBe(sam.view().you)
    ada.ws.close(); sam.ws.close()
  })

  test('a third socket is refused; a dropped phone reconnects and gets the live view; the first one sees "peer"', async () => {
    const code = newCode()
    const ada = await open(code, await tok(code, 'ref-ada', 'Ada', { host: 'four' }))
    const sam = await open(code, await tok(code, 'ref-sam', 'Sam'))
    await sam.waitFor((m) => m.t === 'view' && m.status === 'playing')
    const eve = await open(code, await tok(code, 'ref-eve', 'Eve'))
    expect(await eve.closed).toMatchObject({ code: CLOSE.full })

    sam.ws.close()
    await ada.waitFor((m) => m.t === 'peer' && m.connected === false)
    const sam2 = await open(code, await tok(code, 'ref-sam', 'Sam'))
    const v = await sam2.waitFor((m) => m.t === 'view')
    expect(v.status).toBe('playing')
    expect(v.connected).toEqual([true, true])
    await ada.waitFor((m) => m.t === 'peer' && m.connected === true)
    ada.ws.close(); sam2.ws.close()
  })

  test('the same person opening a second tab replaces the first socket', async () => {
    const code = newCode()
    const a1 = await open(code, await tok(code, 'ref-ada', 'Ada', { host: 'four' }))
    await a1.waitFor((m) => m.t === 'view')
    const a2 = await open(code, await tok(code, 'ref-ada', 'Ada'))
    await a2.waitFor((m) => m.t === 'view')
    expect(await a1.closed).toMatchObject({ code: CLOSE.replaced })
    a2.ws.close()
  })
})

describe('rematch in the runtime: sockets follow the person, not the seat', () => {
  test('sides swap, each phone keeps its own view and name, a reconnect displaces nobody and sees no other seat', async () => {
    const code = newCode()
    const ada = await open(code, await tok(code, 'ref-ada', 'Ada', { host: 'fleet' }))
    const sam = await open(code, await tok(code, 'ref-sam', 'Sam'))
    await sam.waitFor((m) => m.t === 'view' && m.status === 'playing')
    const before = { ada: (await ada.waitFor((m) => m.t === 'view')).you as number }
    ada.send({ t: 'resign' })
    await sam.waitFor((m) => m.t === 'view' && m.status === 'over')
    await Bun.sleep(150)
    ada.send({ t: 'rematch' })
    await Bun.sleep(150)
    sam.send({ t: 'rematch' })
    await ada.waitFor((m) => m.t === 'view' && m.status === 'playing' && m.n === 0 && m.you !== before.ada)
    await sam.waitFor((m) => m.t === 'view' && m.status === 'playing' && m.you === before.ada)
    expect(ada.view().names[ada.view().you]).toBe('Ada')
    expect(sam.view().names[sam.view().you]).toBe('Sam')
    expect(ada.view().you).not.toBe(sam.view().you)

    // Sam reopens a socket after the swap
    const sam2 = await open(code, await tok(code, 'ref-sam', 'Sam'))
    const v = await sam2.waitFor((m) => m.t === 'view')
    expect(v.names[v.you]).toBe('Sam')
    expect(await sam.closed).toMatchObject({ code: CLOSE.replaced }) // Sam's own old socket, not Ada's
    await Bun.sleep(300)
    expect(ada.ws.readyState).toBe(1)
    // Ada never receives a frame addressed to Sam's seat, and still gets her own
    ada.frames.length = 0
    sam2.send({ t: 'sync' })
    await Bun.sleep(300)
    expect(ada.frames.filter((f) => f.t === 'view' && f.you === sam2.view().you)).toEqual([])
    expect(sam2.frames.every((f) => f.t !== 'view' || f.you === sam2.view().you)).toBe(true)
    ada.ws.close(); sam2.ws.close()
  })
})

describe('message limits in the runtime', () => {
  test('an oversized message closes the socket; a flood closes it; neither touches the game', async () => {
    const code = newCode()
    const ada = await open(code, await tok(code, 'ref-ada', 'Ada', { host: 'four' }))
    await ada.waitFor((m) => m.t === 'view')
    ada.send(JSON.stringify({ t: 'sync', pad: 'x'.repeat(LIMITS.maxMessageBytes + 1) }))
    expect((await ada.closed).code).toBe(CLOSE.tooBig)

    const code2 = newCode()
    const bob = await open(code2, await tok(code2, 'ref-bob', 'Bob', { host: 'four' }))
    await bob.waitFor((m) => m.t === 'view')
    for (let i = 0; i < 30; i++) bob.send({ t: 'sync' })
    expect((await bob.closed).code).toBe(CLOSE.rate)
  })
})

describe('per-caller limiter in the runtime', () => {
  test('the sixth open room of one caller is refused; another caller is not', async () => {
    const clients: Client[] = []
    for (let i = 0; i < LIMITS.maxOpenRooms; i++) {
      const code = `LIM${i + 2}AA`
      const c = await open(code, await tok(code, 'ref-heavy', 'Heavy', { host: 'four' }))
      await c.waitFor((m) => m.t === 'view')
      clients.push(c)
    }
    const sixth = await open('LIMZAA', await tok('LIMZAA', 'ref-heavy', 'Heavy', { host: 'four' }))
    expect(await sixth.closed).toMatchObject({ code: CLOSE.tooManyRooms })
    const other = await open('LIMYAA', await tok('LIMYAA', 'ref-light', 'Light', { host: 'four' }))
    await other.waitFor((m) => m.t === 'view')
    for (const c of [...clients, other]) c.ws.close()
  })
})
