/**
 * Storage-write budget (Workers Free: 100,000 rows written a day across the account). Two colluding people drive a
 * room as fast as the message limit lets them; this counts the rows the room writes. Row = one put or one alarm set.
 */
import { describe, expect, test } from 'bun:test'
import { CLOSE, LIMITS } from '../src/limits'
import { ADA, MemStore, SAM, connect, hostOf, rig, type Rig } from './helpers'

const rows = (s: MemStore) => s.puts + s.alarms
const say = (r: Rig, who: typeof ADA, o: unknown) => r.host.message(who.ref, JSON.stringify(o))

/** One identity's next action when it is its turn to be useful: move if it can, else vote a rematch. */
async function drive(r: Rig, simSeconds: number, mode: 'moves' | 'resign-loop'): Promise<{ at60: number; closed: number | null; ticks: number }> {
  let at60 = 0
  let closed: number | null = null
  const start = r.clock.t
  let ticks = 0
  while (r.clock.t - start < simSeconds * 1000 && closed === null) {
    r.clock.t += 200 // two messages per identity per tick = the 10 a second limit
    ticks++
    if (r.clock.t - start >= 60_000 && !at60) at60 = rows(r.store)
    const room = r.host.peek().room
    if (!room) { closed = -1; break }
    for (const who of [ADA, SAM]) {
      const seat = room.seats[0]?.ref === who.ref ? 0 : 1
      const v = (await say(r, who, { t: 'sync' })).find((o) => o.kind === 'send' && o.msg.t === 'view') as any
      const outs = [] as any[]
      if (v?.msg.status === 'over') outs.push(...(await say(r, who, { t: 'rematch' })))
      else if (mode === 'resign-loop' && who === ADA) outs.push(...(await say(r, who, { t: 'resign' })))
      else if (v?.msg.canAct) outs.push(...(await say(r, who, { t: 'act', a: v.msg.legal[0], n: v.msg.n })))
      for (const o of outs) if (o.kind === 'close' && closed === null) closed = o.code
      void seat
    }
  }
  return { at60: at60 || rows(r.store), closed, ticks }
}

describe('colluding players cannot drain the storage quota', () => {
  test('fast legal moves and rematches: at most about 3 rows a second, then the room closes calmly', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    const res = await drive(r, 600, 'moves')
    console.log(`[writes] fast moves: rows in first 60 s = ${res.at60}, closed with ${res.closed}, total rows ${rows(r.store)}`)
    expect(res.at60).toBeLessThan(400)
    expect(res.closed).toBe(CLOSE.roomLimit)
    expect(rows(r.store)).toBeLessThanOrEqual(LIMITS.hardRowsPerRoom + 5)
  })

  test('resign, rematch, rematch loop: ends at the games cap, and the stored series stays within it', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    const res = await drive(r, 600, 'resign-loop')
    console.log(`[writes] resign loop: rows in first 60 s = ${res.at60}, closed with ${res.closed}, total rows ${rows(r.store)}, ticks ${res.ticks}`)
    expect(res.closed).toBe(CLOSE.roomLimit)
    expect(rows(r.store)).toBeLessThan(250)
    expect(r.limiter.callers.get(ADA.ref)!.open).toEqual({}) // slot freed
  })

  test('the games cap holds: the 31st game is refused even when writes are cheap', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    let started = 1
    let closed: number | null = null
    for (let i = 0; i < 100 && closed === null; i++) {
      r.clock.t += 2000
      await say(r, r.host.peek().room!.status === 'over' ? ADA : ADA, { t: 'resign' })
      r.clock.t += 150
      await say(r, ADA, { t: 'rematch' })
      r.clock.t += 150
      const outs = await say(r, SAM, { t: 'rematch' })
      const c = outs.find((o) => o.kind === 'close')
      if (c && c.kind === 'close') closed = c.code
      else started++
      if (r.host.peek().room) expect(r.host.peek().room!.series.length).toBeLessThanOrEqual(LIMITS.maxGamesPerRoom)
    }
    expect(started).toBe(LIMITS.maxGamesPerRoom)
    expect(closed).toBe(CLOSE.roomLimit)
  })

  test('a room whose write budget is spent closes on its next write', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    r.clock.t += 5000
    const saved = (await r.store.get<any>('room'))!
    saved.meta.writes = LIMITS.hardRowsPerRoom
    await r.store.put('room', saved)
    r.wake()
    for (const who of [ADA, SAM]) r.live.add(who.ref)
    const v = (await say(r, ADA, { t: 'sync' })).find((o) => o.kind === 'send' && o.msg.t === 'view') as any
    const mover = v.msg.canAct ? ADA : SAM
    const mv = (await say(r, mover, { t: 'sync' })).find((o) => o.kind === 'send' && o.msg.t === 'view') as any
    r.clock.t += 150
    const outs = await say(r, mover, { t: 'act', a: mv.msg.legal[0], n: mv.msg.n })
    expect(outs.some((o) => o.kind === 'close' && o.code === CLOSE.roomLimit)).toBe(true)
    expect(r.store.data.size).toBe(0)
  })
})

describe('coalesced storage still replays correctly', () => {
  test('a crash loses at most the unflushed second; the rebuilt room is a prefix of the live one and play continues', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    const movers = async (count: number, gap: number) => {
      for (let i = 0; i < count; i++) {
        r.clock.t += gap
        const room = r.host.peek().room!
        for (const who of [ADA, SAM]) {
          const v = (await say(r, who, { t: 'sync' })).find((o) => o.kind === 'send' && o.msg.t === 'view') as any
          if (v?.msg.canAct) { r.clock.t += 120; await say(r, who, { t: 'act', a: v.msg.legal[0], n: v.msg.n }); break }
        }
        void room
      }
    }
    await movers(4, 1500) // slow: every move flushes
    await movers(3, 150) // fast: the first flushes, the rest wait for the alarm
    const live = r.host.peek().room!
    const liveLog = JSON.stringify(live.log)
    const flushedN = (await r.store.get<any>('room'))!.snap.n
    expect(flushedN).toBeLessThan(live.n)
    expect(live.n - flushedN).toBeLessThanOrEqual(3)
    expect(r.store.alarm).not.toBeNull() // a flush is armed
    // crash: nothing runs the alarm. A new host rebuilds from the last flush.
    r.wake()
    for (const who of [ADA, SAM]) r.live.add(who.ref)
    const room = (await (async () => { await say(r, ADA, { t: 'sync' }); return r.host.peek().room! })())
    expect(room.n).toBe(flushedN)
    expect(liveLog.startsWith(JSON.stringify(room.log).slice(0, -1))).toBe(true)
    // a client that still holds the lost step is told it is stale and gets the real view back
    r.clock.t += 200
    const turn = (await say(r, ADA, { t: 'sync' })).find((o) => o.kind === 'send' && o.msg.t === 'view') as any
    const mover = turn.msg.canAct ? ADA : SAM
    const mv = (await say(r, mover, { t: 'sync' })).find((o) => o.kind === 'send' && o.msg.t === 'view') as any
    r.clock.t += 150
    const outs = await say(r, mover, { t: 'act', a: mv.msg.legal[0], n: live.n })
    expect(outs[0]).toMatchObject({ msg: { t: 'error', error: 'stale' } })
    expect(outs.some((o) => o.kind === 'send' && o.msg.t === 'view' && o.msg.n === flushedN)).toBe(true)
    // and the game plays on to a result
    for (let i = 0; i < 200; i++) {
      r.clock.t += 150
      for (const who of [ADA, SAM]) {
        const v = (await say(r, who, { t: 'sync' })).find((o) => o.kind === 'send' && o.msg.t === 'view') as any
        if (v?.msg.canAct) { r.clock.t += 120; await say(r, who, { t: 'act', a: v.msg.legal[0], n: v.msg.n }) }
      }
      if (r.host.peek().room!.status === 'over') break
    }
    expect(r.host.peek().room!.status).toBe('over')
  })

  test('the alarm flushes a pending change and re-arms the expiry deadline', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    r.clock.t += 5000
    const first = (await say(r, ADA, { t: 'sync' })).find((o) => o.kind === 'send' && o.msg.t === 'view') as any
    const mover = first.msg.canAct ? ADA : SAM
    const mv = (await say(r, mover, { t: 'sync' })).find((o) => o.kind === 'send' && o.msg.t === 'view') as any
    r.clock.t += 150
    await say(r, mover, { t: 'act', a: mv.msg.legal[0], n: 0 }) // flushes (quiet second before it)
    const other = mover === ADA ? SAM : ADA
    const ov = (await say(r, other, { t: 'sync' })).find((o) => o.kind === 'send' && o.msg.t === 'view') as any
    r.clock.t += 150
    await say(r, other, { t: 'act', a: ov.msg.legal[0], n: 1 }) // inside the same second: waits
    expect((await r.store.get<any>('room'))!.snap.n).toBe(1)
    r.clock.t += 1000
    await r.host.alarm()
    expect((await r.store.get<any>('room'))!.snap.n).toBe(2)
    expect(r.store.alarm).toBe(r.host.deadline())
  })
})

describe('honest play is never cut off mid-game', () => {
  test('human-pace chess with rematches: the room closes only at a rematch, never while a game is playing', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'chess'))
    await connect(r, SAM)
    let closed: { code: number; reason: string; status: string } | null = null
    let games = 1
    let moves = 0
    for (let step = 0; step < 20000 && !closed; step++) {
      r.clock.t += 1500
      const room = r.host.peek().room
      if (!room) break
      const status = room.status
      for (const who of [ADA, SAM]) {
        const outs = await say(r, who, { t: 'sync' })
        const v = (outs.find((o) => o.kind === 'send' && o.msg.t === 'view') as any)?.msg
        let acted: any[] = []
        if (v.status === 'over') acted = await say(r, who, { t: 'rematch' })
        else if (v.canAct) {
          r.clock.t += 400
          // a human game ends: after 120 moves of first-legal play, someone resigns
          acted = ++moves % 120 === 0 ? await say(r, who, { t: 'resign' }) : await say(r, who, { t: 'act', a: v.legal[0], n: v.n })
        }
        const c = acted.find((o) => o.kind === 'close') as any
        if (c) { closed = { code: c.code, reason: c.reason, status }; break }
        if (r.host.peek().room?.status === 'playing' && v.status === 'over') games++
      }
    }
    console.log(`[writes] chess pace: closed ${JSON.stringify(closed)} after ${games} games, rows ${rows(r.store)}`)
    expect(closed).not.toBeNull()
    expect(closed!.code).toBe(CLOSE.roomLimit)
    expect(closed!.reason).toBe('game-limit')
    expect(closed!.status).toBe('over') // the room was between games, not in one
    expect(rows(r.store)).toBeLessThanOrEqual(LIMITS.maxRowsPerRoom)
  })
})

describe('a resolved simultaneous step is flushed at once', () => {
  test('Twelve Yards: wake() right after both picks resolve keeps the resolved round', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'penalty'))
    await connect(r, SAM)
    r.clock.t += 5000
    const pick = async (who: typeof ADA) => {
      const v = (await say(r, who, { t: 'sync' })).find((o) => o.kind === 'send' && o.msg.t === 'view') as any
      r.clock.t += 150
      return say(r, who, { t: 'act', a: v.msg.legal[0], n: v.msg.n })
    }
    await pick(ADA) // first pick: held, may wait for the alarm
    await pick(SAM) // second pick resolves the round, inside the same second
    expect(r.host.peek().room!.n).toBe(1)
    r.wake() // evicted or crashed immediately
    for (const who of [ADA, SAM]) r.live.add(who.ref)
    await say(r, ADA, { t: 'sync' })
    expect(r.host.peek().room!.n).toBe(1)
  })
})

describe('the soft budget stops rematches, not the game in progress', () => {
  test('past budget minus the reserve a running game finishes, and the rematch closes the room calmly', async () => {
    const r = rig()
    await connect(r, hostOf(ADA, 'four'))
    await connect(r, SAM)
    r.clock.t += 5000
    const saved = (await r.store.get<any>('room'))!
    saved.meta.writes = LIMITS.maxRowsPerRoom - LIMITS.reserveRows + 10
    await r.store.put('room', saved)
    r.wake()
    for (const who of [ADA, SAM]) r.live.add(who.ref)
    for (let i = 0; i < 100 && r.host.peek().room?.status !== 'over'; i++) {
      r.clock.t += 1200
      for (const who of [ADA, SAM]) {
        const v = (await say(r, who, { t: 'sync' })).find((o) => o.kind === 'send' && o.msg.t === 'view') as any
        if (v?.msg.canAct) {
          const outs = await say(r, who, { t: 'act', a: v.msg.legal[0], n: v.msg.n })
          expect(outs.some((o) => o.kind === 'close')).toBe(false) // never cut off mid-game
        }
      }
    }
    expect(r.host.peek().room!.status).toBe('over')
    r.clock.t += 200
    await say(r, ADA, { t: 'rematch' })
    r.clock.t += 200
    const outs = await say(r, SAM, { t: 'rematch' })
    expect(outs.find((o) => o.kind === 'close')).toMatchObject({ code: CLOSE.roomLimit, reason: 'game-limit' })
  })
})
