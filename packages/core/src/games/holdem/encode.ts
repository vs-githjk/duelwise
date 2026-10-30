import type { FeatureEncoder } from '../../types'
import type { HoldemObservation } from './core'
import { BIG_BLIND, MATCH_HANDS, STACK } from './match'

/**
 * Flat vector: 52 own hole cards, 52 board cards, 4 street one-hot, then
 * [pot, to call, own stack, opponent stack, is button, hand progress, net chips, min raise-to] each scaled to about [-1, 1].
 */
export const HOLDEM_FEATURES = 52 + 52 + 4 + 8

export const holdemEncoder: FeatureEncoder<HoldemObservation> = {
  shape: [HOLDEM_FEATURES],
  encode(o, out, offset) {
    for (let i = 0; i < HOLDEM_FEATURES; i++) out[offset + i] = 0
    for (const c of o.hole) out[offset + c] = 1
    for (const c of o.board) out[offset + 52 + c] = 1
    out[offset + 104 + o.street] = 1
    const opp = (1 - o.seat) as 0 | 1
    const mine = o.bet[o.seat]
    const theirs = o.bet[opp]
    const base = offset + 108
    out[base] = (o.total[0] + o.total[1]) / (2 * STACK)
    out[base + 1] = Math.max(0, theirs - mine) / STACK
    out[base + 2] = (STACK - o.total[o.seat]) / STACK
    out[base + 3] = (STACK - o.total[opp]) / STACK
    out[base + 4] = o.isButton ? 1 : 0
    out[base + 5] = o.hand / MATCH_HANDS
    out[base + 6] = o.net[o.seat] / (STACK * 4)
    out[base + 7] = o.minRaiseTo > 0 ? o.minRaiseTo / (BIG_BLIND * 50) : 0
  },
}
