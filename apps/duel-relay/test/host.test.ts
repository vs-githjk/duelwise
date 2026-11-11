import { describe, expect, test, beforeEach, setSystemTime } from 'bun:test'
import { getCore } from '@duelwise/core/src/games/index'
import type { Seat } from '@duelwise/core/src/types'
import { CLOSE, LIMITS } from '../src/limits'
import { ADA, SAM, MemLimiter, act, connect, hostOf, rig, sync, type Rig } from './helpers'

const lastView = (r: Rig, s: Seat) => r.last[s]

/** Plays a game to its end by always taking the first legal action, whoever may act. */
async function playOut(r: Rig, guard = 3000): Promise<void> {
  for (let i = 0; i < guard && lastView(r, 0)?.status !== 'over'; i++) {
    for (const s of [0, 1] as const) {
      await sync(r, s)
      const v = lastView(r, s)
      if (v.canAct) await act(r, s, v.legal[0], v.n)
    }
  }
}

describe('room host: a full game, both seats, one relay', () => {
  test('two seats play Four in a Row to a result and each sees its own seat', async () => {
    const r = rig({ hostSeat: 1 })
    const a = await connect(r, hostOf(ADA, 'four'))
    expect(a).toMatchObject({ ok: true, seat: 1 })
    const b = await connect(r, SAM)
    expect(b).toMatchObject({ ok: true, seat: 0 })
    expect(lastView(r, 0).status).toBe('playing')
    expect(lastView(r, 0).you).toBe(0)
    expect(lastView(r, 1).you).toBe(1)
    await playOut(r)
    for (const s of [0, 1] as const) {
      expect(lastView(r, s).status).toBe('over')
      expect(lastView(r, s).result).not.toBeNull()
    }
  })

  test('the seed is in no frame before the game is over and appears after', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    const seed = r.host.peek().room!.seed
    await sync(r, 0)
    await playOut(r)
    const frames = [...r.frames[0], ...r.frames[1]].map((f) => JSON.parse(f))
    const views = frames.filter((f) => f.t === 'view')
    const before = views.filter((v) => v.status !== 'over')
    expect(before.length).toBeGreaterThan(5)
    for (const v of before) expect(v.seed).toBeNull()
    for (const f of r.frames.flat().filter((x) => !x.includes('"status":"over"'))) expect(f.includes(`"seed":${seed}`)).toBe(false)
    expect(views.filter((v) => v.status === 'over').every((v) => v.seed === seed)).toBe(true)
  })
})

describe('hibernation: a new host over the same store carries on', () => {
  test('rebuilds seats, log and turn from storage and the game continues to a result', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    for (let i = 0; i < 6; i++) {
      for (const s of [0, 1] as const) {
        await sync(r, s)
        const v = lastView(r, s)
        if (v.canAct) await act(r, s, v.legal[0], v.n)
      }
    }
    const before = r.host.peek().room!
    const snapshotN = before.n
    const logCopy = JSON.stringify(before.log)
    const seed = before.seed
    r.wake() // the object was evicted; a new host reads the store
    expect(r.host.peek().room).toBeNull() // nothing loaded until the first event
    await sync(r, 0)
    const after = r.host.peek().room!
    expect(after.n).toBe(snapshotN)
    expect(JSON.stringify(after.log)).toBe(logCopy)
    expect(after.seed).toBe(seed)
    expect(lastView(r, 0).connected).toEqual([true, true])
    await playOut(r)
    expect(lastView(r, 1).status).toBe('over')
  })

  test('a reconnecting phone gets its seat and the current view back', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    const outs = await r.drop(0)
    expect(outs.some((o) => o.kind === 'send' && o.seat === 1 && o.msg.t === 'peer' && o.msg.connected === false)).toBe(true)
    r.wake()
    const again = await connect(r, hostOf(ADA, 'four'))
    expect(again).toMatchObject({ ok: true, seat: 0 })
    expect(lastView(r, 0).status).toBe('playing')
    expect(lastView(r, 0).connected).toEqual([true, true])
  })
})

describe('who may connect', () => {
  test('a guest before the host has made the room is refused', async () => {
    const r = rig()
    expect(await connect(r, SAM)).toMatchObject({ ok: false, code: CLOSE.noRoom })
  })

  test('a third person is refused, and so is a stranger after the game ended', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    expect(await connect(r, { ref: 'ref-eve', name: 'Eve', host: null })).toMatchObject({ ok: false, code: CLOSE.full })
    r.take(await r.msg(0, JSON.stringify({ t: 'resign' })))
    expect(await connect(r, { ref: 'ref-eve', name: 'Eve', host: null })).toMatchObject({ ok: false, code: CLOSE.over })
    expect(await connect(r, SAM)).toMatchObject({ ok: true }) // a seated player still reconnects after the end
  })

  test('only the six friend games can be created', async () => {
    const r = rig()
    expect(await connect(r, hostOf(ADA, 'puck'))).toMatchObject({ ok: false, code: CLOSE.badGame })
    expect(await connect(r, hostOf(ADA, 'nonsense'))).toMatchObject({ ok: false, code: CLOSE.badGame })
  })
})

describe('message limits', () => {
  let r: Rig
  beforeEach(async () => {
    r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
  })

  test('an oversized message closes the socket', async () => {
    const big = JSON.stringify({ t: 'act', a: 1, n: 0, pad: 'x'.repeat(LIMITS.maxMessageBytes) })
    const outs = await r.msg(0, big)
    expect(outs).toEqual([{ kind: 'close', seat: 0, ref: ADA.ref, code: CLOSE.tooBig, reason: 'too-big' }])
  })

  test('the size limit counts UTF-8 bytes, not characters', async () => {
    const wide = JSON.stringify({ t: 'sync', pad: 'é'.repeat(LIMITS.maxMessageBytes / 2) })
    expect(wide.length).toBeLessThanOrEqual(LIMITS.maxMessageBytes + 20)
    const outs = await r.msg(0, wide)
    expect(outs[0]).toMatchObject({ kind: 'close', code: CLOSE.tooBig })
  })

  test('more than ten messages in a second closes the socket; a second later it is fine again for a new connection', async () => {
    let closed = false
    for (let i = 0; i < 12; i++) {
      const outs = await r.msg(0, JSON.stringify({ t: 'sync' }))
      if (outs.some((o) => o.kind === 'close' && o.code === CLOSE.rate)) { closed = true; expect(i).toBe(LIMITS.maxMessagesPerSecond); break }
    }
    expect(closed).toBe(true)
    // time passes: the window is a rolling second
    r.clock.t += 1100
    const outs = await r.msg(1, JSON.stringify({ t: 'sync' }))
    expect(outs.some((o) => o.kind === 'send')).toBe(true)
  })

  test('garbage, unknown types and binary frames do not touch the game', async () => {
    const n = r.host.peek().room!.n
    for (const bad of ['not json', '[]', 'null', '{"t":5}', '{"t":"zap"}', '{"t":"act","a":"1","n":0}']) {
      r.clock.t += 200
      const outs = await r.msg(0, bad)
      expect(outs).toEqual([{ kind: 'send', seat: 0, ref: ADA.ref, msg: { t: 'error', error: 'bad-message' } }])
    }
    expect((await r.msg(0, new ArrayBuffer(4)))[0]).toMatchObject({ kind: 'close' })
    expect(r.host.peek().room!.n).toBe(n)
  })

  test('only legal actions, only on your turn, only for the current step', async () => {
    const turn: Seat = lastView(r, 0).canAct ? 0 : 1
    const idle = (1 - turn) as Seat
    const v = lastView(r, turn)
    r.clock.t += 200
    const err = async (s: Seat, a: number, n: number) => (await r.msg(s, JSON.stringify({ t: 'act', a, n })))[0]
    expect(await err(idle, 0, v.n)).toMatchObject({ msg: { t: 'error', error: 'not-your-turn' } })
    expect(await err(turn, 99999, v.n)).toMatchObject({ msg: { t: 'error', error: 'illegal' } })
    expect(await err(turn, v.legal[0], v.n + 5)).toMatchObject({ msg: { t: 'error', error: 'stale' } })
    expect(r.host.peek().room!.n).toBe(0)
  })
})

describe('time limits (a room expires)', () => {
  test('a room nobody joins closes after 30 minutes; storage is wiped and the caller slot is freed', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    expect(r.store.alarm).toBe(r.clock.t + LIMITS.waitMs)
    r.clock.t += LIMITS.waitMs - 1
    expect(await r.host.alarm()).toEqual([])
    expect(r.store.alarm).toBe(r.clock.t + 1)
    r.clock.t += 1
    const outs = r.take(await r.host.alarm())
    expect(outs.length).toBe(1) // only the host's seat is occupied
    expect(outs[0]).toMatchObject({ kind: 'close', code: CLOSE.expired, reason: 'expired' })
    expect(r.store.data.size).toBe(0)
    expect(r.limiter.callers.get(ADA.ref)!.open).toEqual({})
    expect(await connect(r, SAM)).toMatchObject({ ok: false, code: CLOSE.noRoom })
  })

  test('a started room closes after 20 idle minutes, and a move resets the idle clock', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    r.clock.t += LIMITS.idleMs - 1000
    await sync(r, 0)
    const turn: Seat = lastView(r, 0).canAct ? 0 : 1
    await act(r, turn, lastView(r, turn).legal[0], 0)
    r.clock.t += LIMITS.idleMs - 1000
    expect(await r.host.alarm()).toEqual([])
    r.clock.t += 1000
    const outs = await r.host.alarm()
    expect(outs.map((o) => o.kind === 'close' && o.code)).toEqual([CLOSE.expired, CLOSE.expired])
    expect(r.store.data.size).toBe(0)
  })

  test('a room never lives past three hours even if players keep moving', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    const start = r.clock.t
    for (let i = 0; i < 10; i++) {
      r.clock.t += LIMITS.idleMs - 60_000
      await sync(r, 0)
      const v = lastView(r, 0)
      const s: Seat = v.canAct ? 0 : 1
      await sync(r, s)
      if (lastView(r, s).canAct) await act(r, s, lastView(r, s).legal[0], lastView(r, s).n)
      if (r.clock.t - start >= LIMITS.lifeMs) break
    }
    expect(r.clock.t - start).toBeGreaterThanOrEqual(LIMITS.lifeMs)
    const outs = await r.host.alarm()
    expect(outs.some((o) => o.kind === 'close' && o.code === CLOSE.expired)).toBe(true)
  })

  test('resigning while waiting cancels the room and frees the slot', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    const outs = await r.msg(0, JSON.stringify({ t: 'resign' }))
    expect(outs[0]).toMatchObject({ kind: 'close', code: CLOSE.bye })
    expect(r.limiter.callers.get(ADA.ref)!.open).toEqual({})
  })
})

describe('caller limits', () => {
  test('a sixth open room is refused; closing one frees a slot', async () => {
    const limiter = new MemLimiter()
    const rigs: Rig[] = []
    for (let i = 0; i < 5; i++) {
      const r = rig({ limiter })
      expect(await connect(r, hostOf(ADA, 'four'), `ROOM${i + 2}A`)).toMatchObject({ ok: true })
      rigs.push(r)
    }
    const sixth = rig({ limiter })
    expect(await connect(sixth, hostOf(ADA, 'four'), 'FFFFFF')).toMatchObject({ ok: false, code: CLOSE.tooManyRooms })
    await rigs[0]!.msg(0, JSON.stringify({ t: 'resign' }))
    expect(await connect(sixth, hostOf(ADA, 'four'), 'FFFFFF')).toMatchObject({ ok: true })
  })

  test('the forty-first create in a day is refused, and another caller is unaffected', async () => {
    const limiter = new MemLimiter()
    const clock = { t: 1_700_000_000_000 }
    for (let i = 0; i < LIMITS.maxCreatesPerDay; i++) {
      const r = rig({ limiter, clock })
      expect(await connect(r, hostOf(ADA, 'four'), 'AAAAAA')).toMatchObject({ ok: true })
      await r.msg(0, JSON.stringify({ t: 'resign' }))
    }
    const r = rig({ limiter, clock })
    expect(await connect(r, hostOf(ADA, 'four'), 'AAAAAA')).toMatchObject({ ok: false, code: CLOSE.dailyLimit })
    expect(await connect(rig({ limiter, clock }), hostOf(SAM, 'four'), 'AAAAAA')).toMatchObject({ ok: true })
    clock.t += 24 * 60 * 60_000 + 1
    expect(await connect(rig({ limiter, clock }), hostOf(ADA, 'four'), 'AAAAAA')).toMatchObject({ ok: true })
  })
})

describe('rematch and resign', () => {
  test('both votes start a new game with sides swapped and a fresh seed', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    const seed1 = r.host.peek().room!.seed
    await r.msg(0, JSON.stringify({ t: 'resign' }))
    r.take(await r.msg(0, JSON.stringify({ t: 'rematch' })))
    expect(lastView(r, 0).status).toBe('over')
    r.clock.t += 200
    r.take(await r.msg(1, JSON.stringify({ t: 'rematch' })))
    const v = lastView(r, 0)
    expect(v.status).toBe('playing')
    expect(r.host.peek().room!.seed).not.toBe(seed1)
    expect(v.names).toEqual(['Sam', 'Ada'])
    expect(v.seed).toBeNull()
  })
})

describe('hidden information survives the relay', () => {
  test('Word Duel: the answer and the other seat\'s guesses are in no frame before the game ends', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'word'))
    await connect(r, SAM)
    const room = r.host.peek().room as any
    const answer: string = room.state.answer
    const core = getCore('word')
    // each seat guesses a different allowed word that is not the answer
    const words = [['crane', 'slate', 'pound'], ['light', 'frame', 'quick']].map((w) => w.filter((x) => x !== answer))
    for (let round = 0; round < 3; round++) {
      for (const s of [0, 1] as const) {
        await sync(r, s)
        const v = lastView(r, s)
        if (!v.canAct) continue
        const code = v.legal.find((c: number) => core.decodeAction(c) === words[s]![round])
        expect(code).toBeDefined()
        r.clock.t += 200
        await act(r, s, code!, v.n)
      }
    }
    expect(lastView(r, 0).obs.guesses.length).toBe(3)
    for (const s of [0, 1] as const) {
      const other = (1 - s) as Seat
      for (const frame of r.frames[s]) {
        expect(frame.includes(answer)).toBe(false)
        for (const w of words[other]!) expect(frame.includes(w)).toBe(false)
      }
    }
    expect(lastView(r, 0).obs.opponent.length).toBe(3)
  })

  test('every frame to a seat is exactly viewFor for that seat, with no extra fields (all six games)', async () => {
    const { viewFor } = await import('@duelwise/core/src/duel/room')
    for (const game of ['chess', 'four', 'slack', 'penalty', 'fleet', 'word'] as const) {
      const r = rig()
      await connect(r, hostOf(ADA, game))
      await connect(r, SAM)
      for (let i = 0; i < 6; i++) {
        for (const s of [0, 1] as const) {
          r.clock.t += 120
          await sync(r, s)
          const v = lastView(r, s)
          if (v.canAct) await act(r, s, v.legal[v.legal.length >> 1], v.n)
        }
      }
      const room = r.host.peek().room!
      for (const s of [0, 1] as const) {
        const expected = { t: 'view', ...viewFor(room, s, getCore(game)) }
        expect(JSON.parse(r.frames[s].at(-1)!)).toEqual(JSON.parse(JSON.stringify(expected)))
        for (const f of r.frames[s]) {
          const m = JSON.parse(f)
          if (m.t !== 'view') continue
          expect(Object.keys(m).sort()).toEqual(Object.keys(expected).sort())
          if (m.status !== 'over') expect(m.seed).toBeNull()
        }
      }
    }
  })
})

describe('sockets belong to a person, not a seat (rematch swaps seats)', () => {
  test('after a rematch each person still gets their own view and a reconnect displaces nobody', async () => {
    const r = rig({ hostSeat: 0 })
    await connect(r, hostOf(ADA, 'fleet'))
    await connect(r, SAM)
    await r.msg(0, JSON.stringify({ t: 'resign' }))
    await sync(r, 0)
    await r.msg(0, JSON.stringify({ t: 'rematch' }))
    r.clock.t += 200
    r.take(await r.host.message(SAM.ref, JSON.stringify({ t: 'rematch' })))
    r.take(await r.host.message(ADA.ref, JSON.stringify({ t: 'sync' })))
    r.take(await r.host.message(SAM.ref, JSON.stringify({ t: 'sync' })))
    const room = r.host.peek().room!
    expect(room.seats.map((s) => s!.ref)).toEqual([SAM.ref, ADA.ref]) // sides really swapped
    // views addressed by ref: Ada is seat 1 now, and her view says so with her own name
    const outs = await r.host.message(ADA.ref, JSON.stringify({ t: 'sync' }))
    expect(outs).toHaveLength(1)
    expect(outs[0]).toMatchObject({ kind: 'send', ref: ADA.ref, seat: 1, msg: { t: 'view', you: 1, names: ['Sam', 'Ada'] } })
    // Sam reconnects: Sam's views go to Sam's ref only
    const again = await r.host.connect(SAM, 'ABCDEF')
    expect(again).toMatchObject({ ok: true, seat: 0 })
    if (again.ok) for (const o of again.out) if (o.kind === 'send' && o.msg.t === 'view') expect(o.msg.you).toBe(o.ref === SAM.ref ? 0 : 1)
  })
})

describe('storage writes (free plan: 100,000 rows written a day)', () => {
  test('a reconnect and a repeated rematch vote write nothing; a first vote writes', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    await r.msg(0, JSON.stringify({ t: 'resign' }))
    const mark = () => r.store.puts + r.store.alarms
    const a = mark()
    for (let i = 0; i < 5; i++) { r.clock.t += 7000; await connect(r, SAM) } // reconnects
    expect(mark()).toBe(a)
    r.clock.t += 7000
    await r.msg(0, JSON.stringify({ t: 'rematch' }))
    const b = mark()
    expect(b).toBeGreaterThan(a)
    for (let i = 0; i < 5; i++) { r.clock.t += 200; await r.msg(0, JSON.stringify({ t: 'rematch' })) } // same vote again
    expect(mark()).toBe(b)
  })

  test('more than ten socket opens a minute by one person are refused, and the message window is not reset by reconnecting', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    let refused: any = null
    for (let i = 0; i < 12 && !refused; i++) {
      r.clock.t += 1000
      const c = await connect(r, SAM)
      if (!c.ok) refused = c
    }
    expect(refused).toMatchObject({ ok: false, code: CLOSE.rate, reason: 'connect-rate' })
    // message window survives a reconnect
    const r2 = rig()
    await connect(r2, hostOf(ADA, 'four'))
    await connect(r2, SAM)
    for (let i = 0; i < LIMITS.maxMessagesPerSecond; i++) await r2.host.message(SAM.ref, JSON.stringify({ t: 'sync' }))
    await connect(r2, SAM)
    const outs = await r2.host.message(SAM.ref, JSON.stringify({ t: 'sync' }))
    expect(outs[0]).toMatchObject({ kind: 'close', code: CLOSE.rate })
  })
})
