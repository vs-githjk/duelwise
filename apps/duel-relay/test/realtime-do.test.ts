/**
 * S7 in the real local Workers runtime (workerd via `wrangler dev --local`, a throwaway secret, a free port): the wiring of the realtime
 * path: token check, routing a realtime code to the realtime host, the BudgetDO binding and its v2 migration, socket tags after the
 * first message, close codes. The rules themselves are in realtime.test.ts with a fake clock.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyDuelResult } from '@duelwise/core/src/duel/result-proof'
import { signDuelToken } from '@duelwise/core/src/duel/token'
import { NETPLAY_CORES } from '@duelwise/core/src/netplay/session'
import { NET_VECTORS, vectorCodes } from '@duelwise/core/src/netplay/vectors'
import { fromWire } from '@duelwise/core/src/netplay/wire'
import { CLOSE } from '../src/limits'

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
  state = mkdtempSync(join(tmpdir(), 'duel-relay-rt-test-'))
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

const PID_A = 'a'.repeat(32)
const PID_B = 'b'.repeat(32)
const tok = (code: string, ref: string, name: string, pid: string, host?: 'fighter' | 'arena' | 'puck') =>
  signDuelToken({ code, ref, name, pid, exp: Date.now() + 60_000, ...(host ? { host: { game: host } } : {}) }, SECRET)

interface Client { ws: WebSocket; frames: any[]; closed: Promise<{ code: number; reason: string }>; send(o: unknown): void; of(t: string): any[]; waitFor(pred: (m: any) => boolean, ms?: number): Promise<any> }

async function open(code: string, token: string, cv: string | null = 'puck-2'): Promise<Client> {
  const ws = new WebSocket(`ws://${base}/room/${code}?t=${encodeURIComponent(token)}${cv === null ? '' : `&cv=${cv}`}`)
  const frames: any[] = []
  const waiters: Array<{ pred: (m: any) => boolean; res: (m: any) => void }> = []
  const closed = new Promise<{ code: number; reason: string }>((res) => ws.addEventListener('close', (e) => res({ code: e.code, reason: e.reason })))
  ws.addEventListener('message', (e) => {
    if (e.data === 'pong') return
    const m = JSON.parse(String(e.data))
    frames.push(m)
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m) }
  })
  await new Promise<void>((res, rej) => { ws.addEventListener('open', () => res()); ws.addEventListener('error', () => rej(new Error('socket error'))); ws.addEventListener('close', () => res()) })
  return {
    ws, frames, closed,
    send: (o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o)),
    of: (t) => frames.filter((f) => f.t === t),
    waitFor: (pred, ms = 5000) => new Promise((res, rej) => {
      const hit = frames.find(pred)
      if (hit) return res(hit)
      const timer = setTimeout(() => rej(new Error('timed out waiting for a frame')), ms)
      waiters.push({ pred, res: (m) => { clearTimeout(timer); res(m) } })
    }),
  }
}

let codeN = 0
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const newCode = () => { const n = ++codeN; return `RTST${B32[n >> 5]}${B32[n & 31]}` }

async function pair(game: 'fighter' | 'arena' | 'puck' = 'fighter') {
  const code = newCode()
  // A caller may hold five open rooms, so every pair is its own pair of callers.
  const ref = `ref-ada-${code}`
  const ada = await open(code, await tok(code, ref, 'Ada', PID_A, game))
  const sam = await open(code, await tok(code, `ref-sam-${code}`, 'Sam', PID_B))
  await ada.waitFor((m) => m.t === 'lobby')
  ada.send({ t: 'ready' })
  sam.send({ t: 'ready' })
  const go = await ada.waitFor((m) => m.t === 'go')
  await sam.waitFor((m) => m.t === 'go')
  return { code, ada, sam, go, adaRef: ref }
}

describe('realtime room in workerd', () => {
  test('two sockets get a lobby, ready, and go; inputs cross in order; the relay\'s hash check sends a snapshot that rebuilds its state; a client `over` is ignored; resign gives a verifying signed result', async () => {
    const { ada, sam, go } = await pair('fighter')
    expect(go).toMatchObject({ game: 'fighter', at: 0 })
    expect([0, 1]).toContain(go.you)
    const v = NET_VECTORS.find((x) => x.id === 'fighter-mash')!
    const codes = vectorCodes(v, 400)
    const seatOf = (c: Client) => (c === ada ? go.you : 1 - go.you) as 0 | 1
    // 130 frames each, two per message, paced under the 40 a second cap
    for (let f = 2; f < 130; f += 2) {
      ada.send({ t: 'in', f, c: [codes[seatOf(ada)][f], codes[seatOf(ada)][f + 1]] })
      sam.send({ t: 'in', f, c: [codes[seatOf(sam)][f], codes[seatOf(sam)][f + 1]] })
      await Bun.sleep(40)
    }
    await sam.waitFor((m) => m.t === 'in' && m.f >= 126)
    const got = sam.of('in').flatMap((m) => m.c)
    expect(got).toEqual(codes[seatOf(ada)].slice(2, 2 + got.length))
    // a wrong hash at frame 60
    sam.send({ t: 'in', f: 130, c: [codes[seatOf(sam)][130]], hf: 60, h: '0123456789abcdef' })
    ada.send({ t: 'in', f: 130, c: [codes[seatOf(ada)][130]] })
    const snap = await sam.waitFor((m) => m.t === 'snap')
    expect(snap.f).toBe(60)
    const nc: any = NETPLAY_CORES.fighter
    const reference = nc.create(go.seed)
    for (let f = 0; f < 60; f++) {
      const c0 = f < 2 ? 0 : codes[0][f]!
      const c1 = f < 2 ? 0 : codes[1][f]!
      nc.stepCodes(reference, c0, c1)
    }
    const rebuilt = nc.create(0)
    fromWire(rebuilt, snap.state)
    expect(nc.core.hash(rebuilt)).toBe(nc.core.hash(reference))
    // forgery is ignored, resign ends it with a signed result
    sam.send({ t: 'over', result: { winner: seatOf(sam), score: [9, 0], reason: 'rounds' } })
    await Bun.sleep(100)
    expect(ada.of('over')).toHaveLength(0)
    sam.send({ t: 'resign' })
    const over = await ada.waitFor((m) => m.t === 'over')
    expect(over).toMatchObject({ void: null, result: { winner: go.you } })
    const proof = (await ada.waitFor((m) => m.t === 'result')).proof
    const rec = await verifyDuelResult(proof, SECRET)
    expect(rec).toMatchObject({ game: 'fighter', winner: go.you })
    expect(rec!.players.map((p) => p.pid).sort()).toEqual([PID_A, PID_B])
    ada.ws.close()
    sam.ws.close()
  })

  test('a third socket is refused, 41 messages in a second close with rate, and a message over 512 bytes closes with tooBig', async () => {
    const { code, ada, sam } = await pair('puck')
    const eve = await open(code, await tok(code, 'ref-eve', 'Eve', 'c'.repeat(32)))
    expect(await eve.closed).toMatchObject({ code: CLOSE.full })
    sam.ws.send('x'.repeat(513))
    expect(await sam.closed).toMatchObject({ code: CLOSE.tooBig })
    for (let i = 0; i < 45; i++) ada.send({ t: 'bogus' })
    expect(await ada.closed).toMatchObject({ code: CLOSE.rate })
  })

  test('the daily budget object answers through its binding: a match start goes through the BudgetDO binding (a failing binding would answer busy and never send go)', async () => {
    const { ada, sam, go } = await pair('arena')
    expect(go.game).toBe('arena')
    ada.ws.close()
    sam.ws.close()
  })

  test('a puck page with an old core version, or none, is closed through the real worker: a different version 4433, none 1009 (F2)', async () => {
    for (const [cv, want] of [['puck-1', CLOSE.outdated], [null, CLOSE.tooBig]] as const) {
      const code = newCode()
      const old = await open(code, await tok(code, `ref-old-${code}`, 'Old', PID_A, 'puck'), cv)
      expect(await old.closed).toMatchObject({ code: want })
    }
  })

  test('a ping is answered with pong by the runtime in a realtime room too', async () => {
    const { ada } = await pair('puck')
    const pong = new Promise<string>((res) => ada.ws.addEventListener('message', (e) => { if (e.data === 'pong') res('pong') }))
    ada.ws.send('ping')
    expect(await pong).toBe('pong')
    ada.ws.close()
  })

  for (const keepalive of [true, false]) {
    test(`a phone that drops for 12 seconds ${keepalive ? 'resumes the same match when the friend sent keepalives' : 'loses the match to a restart when nobody sent anything (why the keepalive exists)'}`, async () => {
      const { code, ada, sam, go, adaRef } = await pair('fighter')
      sam.send({ t: 'in', f: 2, c: [0, 0] })
      ada.ws.close()
      for (let i = 0; i < 4; i++) {
        await Bun.sleep(3000)
        if (keepalive) sam.send({ t: 'k' })
      }
      const back = await open(code, await tok(code, adaRef, 'Ada', PID_A))
      if (keepalive) {
        const again = await back.waitFor((m) => m.t === 'go')
        expect(again.seed).toBe(go.seed)
        expect(sam.of('over')).toHaveLength(0)
      } else {
        const m = await back.waitFor((x) => x.t === 'over' || x.t === 'go')
        expect(m.t === 'over' ? m.void : 'resumed').toBe('restart')
      }
      back.ws.close()
      sam.ws.close()
    })
  }
})
