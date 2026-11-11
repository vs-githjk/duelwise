import { describe, expect, test } from 'bun:test'
import { InputBatcher } from './batch'
import { NetSim, PROFILES } from './netsim'
import { NETPLAY_CORES, RollbackSession, TICK_MS } from './session'
import { REALTIME_TUNING } from './tuning'
import { NET_VECTORS, vectorCodes } from './vectors'

// S7: the numbers in REALTIME_TUNING are the measured choice. On the poor link the S5 defaults froze about a quarter of the ticks.
function frozenShare(window: number, keepalive: number, game: 'fighter' | 'arena' | 'puck'): number {
  const v = NET_VECTORS.filter((x) => x.game === game)[1]!
  const nc = NETPLAY_CORES[game] as any
  const frames = 3000
  const codes = vectorCodes(v, frames + 64)
  const sess = [0, 1].map((s) => new RollbackSession<any>(nc, v.seed, s as 0 | 1, { ...REALTIME_TUNING.session, window })) as RollbackSession<any>[]
  const net = new NetSim<any>(77, PROFILES.poor!)
  const bat = [0, 1].map(() => new InputBatcher(nc.idle, REALTIME_TUNING.every, keepalive))
  let waits = 0
  let ticks = 0
  for (let t = 0; t < frames * 4; t++) {
    const now = t * TICK_MS
    for (const seat of [0, 1] as const) {
      const s = sess[seat]!
      for (const m of net.receive(seat, now)) s.addRemote(m.f, m.c)
      s.setRoundTrip(230)
      const f = s.nextInputFrame
      if (f >= 0) {
        s.addLocal(codes[seat][f]!)
        const m = bat[seat]!.push(f, codes[seat][f]!)
        if (m) net.send(seat, now, m)
      }
      const r = s.advance()
      if (seat === 0) { ticks++; if (r.wait) waits++ }
    }
    if (sess[0]!.confirmedFrame >= frames && sess[1]!.confirmedFrame >= frames) break
  }
  return waits / ticks
}

describe('realtime tuning', () => {
  test('window 12 with a 4 frame keepalive freezes under 5% of ticks on the poor link; the S5 defaults froze over 15%', () => {
    for (const game of ['fighter', 'arena', 'puck'] as const) {
      expect(frozenShare(REALTIME_TUNING.session.window, REALTIME_TUNING.keepalive, game)).toBeLessThan(0.05)
    }
    expect(frozenShare(8, 6, 'puck')).toBeGreaterThan(0.15)
  })
  test('the numbers are the ones the comment claims', () => {
    expect(REALTIME_TUNING).toEqual({ session: { delay: 2, window: 12 }, every: 2, keepalive: 4 })
  })
})
