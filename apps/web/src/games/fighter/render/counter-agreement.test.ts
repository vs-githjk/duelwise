import { expect, test } from 'bun:test'
import { makeRng } from '@duelwise/core/src/rng.ts'
import { stepPacked } from '@duelwise/core/src/games/fighter/core.ts'
import { COMBO_SCALE, COUNTER_PERCENT, PUNISH_PERCENT } from '@duelwise/core/src/games/fighter/constants.ts'
import { M, MOVES } from '@duelwise/core/src/games/fighter/moves.ts'
import { cloneState, createState, EV, type FighterState } from '@duelwise/core/src/games/fighter/state.ts'
import { counterKindFor } from './FighterRenderer.ts'

type Kind = 'counter' | 'punish' | null

/** What the sim did, read from the damage a clean strike dealt (the percentage applyStrike picked). */
function simKind(prev: FighterState, next: FighterState, defender: 0 | 1): Kind | 'none' {
  const dn = next.fighters[defender]!
  if ((dn.events & EV.HIT_TAKEN) === 0 || (dn.events & (EV.THROWN | EV.BLOCKED | EV.ARMOR | EV.DEFLECTED)) !== 0) return 'none'
  const dp = prev.fighters[defender]!
  const m = MOVES[prev.fighters[1 - defender]!.moveId]!
  const dealt = dp.health - dn.health
  // A defender who lands (becomeIdle) has the combo count reset before the strike is scored.
  const landed = (dn.events & EV.LAND) !== 0 || (dp.comboCount > 0 && dn.comboCount === 1)
  const scale = COMBO_SCALE[Math.min(landed ? 0 : dp.comboCount, COMBO_SCALE.length - 1)]!
  const dmgAt = (pct: number): number => Math.max(1, Math.floor(Math.floor((m.damage * pct) / 100) * scale / 100))
  if (dealt === dmgAt(100)) return null
  if (dealt === dmgAt(COUNTER_PERCENT)) return 'counter'
  if (dealt === dmgAt(PUNISH_PERCENT)) return 'punish'
  throw new Error(`unexpected damage ${dealt} atk ${prev.fighters[1 - defender]!.moveId} def ${dp.moveId} fr ${dp.moveFrame} combo ${dp.comboCount}`)
}

function base(): FighterState {
  const s = createState(5, { introFrames: 0 })
  s.fighters[0].pos.x = -50
  s.fighters[1].pos.x = 50
  return s
}

test('a defender who lands from an air move and goes idle that frame takes an ordinary hit, in the sim and the renderer', () => {
  for (const air of [M.AIR_L, M.AIR_M, M.AIR_H]) {
    for (const dx of [20, 40, 60, 80]) {
      const prev = base()
      prev.fighters[0].pos.x = -dx / 2
      prev.fighters[1].pos.x = dx / 2
      prev.fighters[0].moveId = M.STAND_L
      prev.fighters[0].moveFrame = MOVES[M.STAND_L]!.startup - 1
      prev.fighters[1].moveId = air
      prev.fighters[1].moveFrame = 2
      prev.fighters[1].pos.y = 1
      prev.fighters[1].vel.y = -3
      const next = cloneState(prev)
      stepPacked(next, 0, 0)
      expect(simKind(prev, next, 1)).toBeNull()
      expect(counterKindFor(prev, next, 1)).toBeNull()
    }
  }
})

test('counterKindFor agrees with the sim over many seeded states, landing frames included', () => {
  const rng = makeRng(2026)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng.float() * xs.length)]!
  const attacks = [M.STAND_L, M.STAND_M, M.STAND_H, M.CROUCH_L, M.CROUCH_M]
  const defenders = [M.IDLE, M.STAND_L, M.STAND_M, M.STAND_H, M.CROUCH_L, M.CROUCH_M, M.AIR_L, M.AIR_M, M.AIR_H]
  let hits = 0
  let landing = 0
  let counters = 0
  let punishes = 0
  for (let i = 0; i < 4000; i++) {
    const prev = base()
    const dx = 20 + Math.floor(rng.float() * 61)
    prev.fighters[0].pos.x = -dx / 2
    prev.fighters[1].pos.x = dx / 2
    const am = pick(attacks)
    prev.fighters[0].moveId = am
    prev.fighters[0].moveFrame = MOVES[am]!.startup - 1
    const dm = pick(defenders)
    const d = prev.fighters[1]
    d.moveId = dm
    const dd = MOVES[dm]!
    d.moveFrame = dd.total > 0 ? Math.floor(rng.float() * (dd.total + 1)) : 0
    const air = dm === M.AIR_L || dm === M.AIR_M || dm === M.AIR_H
    if (air) {
      d.pos.y = 1 + Math.floor(rng.float() * 3)
      d.vel.y = -(1 + Math.floor(rng.float() * 4))
      d.moveFrame = 1 + Math.floor(rng.float() * 5)
    }
    d.hitstop = rng.float() < 0.25 ? 1 + Math.floor(rng.float() * 3) : 0
    d.comboCount = Math.floor(rng.float() * 4)
    const next = cloneState(prev)
    stepPacked(next, 0, 0)
    const truth = simKind(prev, next, 1)
    if (truth === 'none') continue
    hits++
    if (air && (next.fighters[1].events & EV.LAND) !== 0) landing++
    if (truth === 'counter') counters++
    if (truth === 'punish') punishes++
    expect(counterKindFor(prev, next, 1)).toBe(truth)
  }
  expect(hits).toBeGreaterThan(300)
  expect(landing).toBeGreaterThan(20)
  expect(counters).toBeGreaterThan(20)
  expect(punishes).toBeGreaterThan(5)
})
