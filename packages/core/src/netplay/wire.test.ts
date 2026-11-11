import { describe, expect, test } from 'bun:test'
import { NETPLAY_CORES } from './session'
import { fromWire, toWire } from './wire'
import { NET_VECTORS, vectorCodes, type NetGame } from './vectors'

// S7: the relay's snapshot must rebuild a state with the same hash (typed arrays included), and the sim must carry on identically from it.
describe('state on the wire', () => {
  for (const game of ['fighter', 'arena', 'puck'] as NetGame[]) {
    test(`${game}: JSON round trip keeps the hash and the sim continues the same`, () => {
      const nc = NETPLAY_CORES[game] as any
      const v = NET_VECTORS.find((x) => x.game === game)!
      const codes = vectorCodes(v, 1500)
      const a = nc.create(v.seed)
      for (let f = 0; f < 900; f++) nc.stepCodes(a, codes[0][f]!, codes[1][f]!)
      const wire = JSON.parse(JSON.stringify(toWire(a)))
      const b = nc.create(v.seed)
      fromWire(b, wire)
      expect(nc.core.hash(b)).toBe(nc.core.hash(a))
      for (let f = 900; f < 1500; f++) {
        nc.stepCodes(a, codes[0][f]!, codes[1][f]!)
        nc.stepCodes(b, codes[0][f]!, codes[1][f]!)
      }
      expect(nc.core.hash(b)).toBe(nc.core.hash(a))
    })
  }
})
