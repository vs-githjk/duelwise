import { describe, expect, test } from 'bun:test'
import { GRID, NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { unitToCell } from '@duelwise/core/src/games/puck/input'
import { createBot } from '@duelwise/core/src/games/puck/bots'
import { observe } from '@duelwise/core/src/games/puck/core'
import { toWire } from '@duelwise/core/src/netplay/wire'
import type { RealtimeLink } from './opponent'
import { PuckNetRun, puckTallyOf, viewToScreen } from './remote-puck'
import { fitLocalLayout } from '../puck/two-hands'

// S9: the engine of a two-device Glasscut page, driven by two runs joined through an in-memory link.

class Wire {
  private remote = new Set<(f: number, c: number[]) => void>()
  private snaps = new Set<(f: number, s: unknown) => void>()
  hashes: Array<[number, string]> = []
  sent: Array<[number, number]> = []
  peer: Wire | null = null
  /** Messages queued for the peer, delivered `lag` ticks later. */
  out: Array<{ at: number; f: number; c: number[] }> = []
  link: RealtimeLink = {
    pushInput: (f, c) => { this.sent.push([f, c]); this.out.push({ at: this.now + this.lag, f, c: [c] }) },
    onRemote: (cb) => { this.remote.add(cb); return () => this.remote.delete(cb) },
    onSnap: (cb) => { this.snaps.add(cb); return () => this.snaps.delete(cb) },
    reportHash: (f, h) => { this.hashes.push([f, h]) },
    rtt: () => 0,
    ready() {}, rematch() {}, resign() {}, close() {},
  }
  now = 0
  constructor(public lag: number) {}
  deliver(): void {
    if (!this.peer) return
    const due = this.out.filter((m) => m.at <= this.now)
    this.out = this.out.filter((m) => m.at > this.now)
    for (const m of due) for (const cb of [...this.peer.remote]) cb(m.f, m.c)
  }
  snap(f: number, state: unknown): void { for (const cb of [...this.snaps]) cb(f, state) }
}

function botCode(bot: ReturnType<typeof createBot>, run: PuckNetRun, me: 0 | 1, tick: number): number {
  if (tick % 2 !== 0) return NO_INPUT
  const t = bot.act(observe(run.state, me))
  return unitToCell(t[0]) + GRID * unitToCell(t[1])
}

function pair(lag: number, seed = 5) {
  const wa = new Wire(lag)
  const wb = new Wire(lag)
  wa.peer = wb
  wb.peer = wa
  const a = new PuckNetRun(wa.link, seed, 0)
  const b = new PuckNetRun(wb.link, seed, 1)
  const ba = createBot('mouse', 11)
  const bb = createBot('random', 12)
  const tick = (t: number) => {
    wa.now = wb.now = t
    wa.deliver()
    wb.deliver()
    a.step(botCode(ba, a, 0, t))
    b.step(botCode(bb, b, 1, t))
  }
  return { a, b, wa, wb, tick }
}

describe('PuckNetRun', () => {
  test('two runs over a lagging link agree on every confirmed hash and finish the same match', () => {
    const { a, b, wa, wb, tick } = pair(3)
    for (let t = 0; t < 6000 && !(a.over && b.over); t++) tick(t)
    expect(a.over && b.over).toBe(true)
    expect(a.state.score).toEqual(b.state.score)
    expect(wa.hashes.length).toBeGreaterThan(5)
    const bm = new Map(wb.hashes)
    let shared = 0
    for (const [f, h] of wa.hashes) {
      if (bm.has(f)) { shared++; expect(bm.get(f)).toBe(h) }
    }
    expect(shared).toBeGreaterThan(5)
  })

  test('a local input is sent for consecutive frames and the frame is the session delay ahead', () => {
    const { wa, a } = pair(0)
    for (let t = 0; t < 10; t++) a.step(NO_INPUT)
    expect(wa.sent.map(([f]) => f)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].slice(0, wa.sent.length))
    expect(wa.sent.length).toBeGreaterThan(0)
  })

  test('with no word from the friend the run waits instead of running away', () => {
    const { a } = pair(0)
    let waits = 0
    for (let t = 0; t < 60; t++) if (a.step(NO_INPUT).wait) waits++
    expect(waits).toBeGreaterThan(30)
    expect(a.frame).toBeLessThanOrEqual(14)
  })

  test('a held input is not lost while the session is stalled', () => {
    const { a, wa } = pair(0)
    // fill the window so addLocal refuses, then send one distinct target
    for (let t = 0; t < 40; t++) a.step(NO_INPUT)
    const mark = wa.sent.length
    a.step(777)
    a.step(NO_INPUT)
    a.step(NO_INPUT)
    // still stalled: the code must still be queued, not dropped
    expect(a.held).toBe(777)
    expect(wa.sent.length).toBe(mark)
  })

  test('a snapshot from the relay is poured in and the run converges again', () => {
    const { a, b, wa, wb, tick } = pair(2, 9)
    for (let t = 0; t < 400; t++) tick(t)
    // Corrupt b's confirmed past, as a desync would, then let the relay's (a's) state arrive.
    const f = a.confirmedFrame
    expect(f).toBeGreaterThan(60)
    const truth = a.confirmedSnapshot()
    wb.snap(truth.frame, toWire(truth.state))
    for (let t = 400; t < 600; t++) tick(t)
    const bm = new Map(wb.hashes)
    for (const [fr, h] of wa.hashes) if (fr > f && bm.has(fr)) expect(bm.get(fr)).toBe(h)
  })

  test('dispose stops listening', () => {
    const { a, wb, wa } = pair(0)
    a.dispose()
    wb.out.push({ at: 0, f: 0, c: [NO_INPUT] })
    wb.now = 1
    wb.deliver()
    expect(wa.sent.length).toBe(0)
    expect(a.remoteFrame).toBeLessThanOrEqual(2)
  })
})

describe('view mapping', () => {
  const l = fitLocalLayout(390, 844)
  test('seat 0 sees its own goal at the bottom, seat 1 sees the table turned', () => {
    const [x0, y0] = viewToScreen(l, 0, 0.5, 0)
    expect(Math.round(y0)).toBe(Math.round(l.y + 2 * l.scale))
    expect(Math.round(x0)).toBe(Math.round(l.x + l.scale / 2))
    const [x1, y1] = viewToScreen(l, 1, 0.5, 2)
    expect(Math.round(y1)).toBe(Math.round(l.y + 2 * l.scale))
    expect(Math.round(x1)).toBe(Math.round(l.x + l.scale / 2))
    const [xa] = viewToScreen(l, 1, 0.1, 1)
    expect(xa).toBeGreaterThan(l.x + l.scale / 2)
  })
})

describe('tally', () => {
  test('counts wins by person across swapped seats, and draws', () => {
    const t = puckTallyOf([
      { winner: 0, me: 0 },
      { winner: 0, me: 1 },
      { winner: 1, me: 1 },
      { winner: null, me: 0 },
    ])
    expect(t).toEqual({ one: 2, two: 1, draws: 1 })
  })
})
