import { expect, test } from 'bun:test'
import { cloneState, createState, EV, type FighterState } from '@duelwise/core/src/games/fighter/state.ts'
import { M, MOVES } from '@duelwise/core/src/games/fighter/moves.ts'
import { buildFixture } from './fixture.ts'
import { FighterRenderer, hitKindFor, type HudSnapshot } from './FighterRenderer.ts'

/** Feeds onStep every `every` steps; every = 1 is what the play loop does, 2 is the old render-only path. */
function countHits(states: FighterState[], every: number): number {
  const r = new FighterRenderer()
  for (let i = every; i < states.length; i += every) r.onStep(states[i - every]!, states[i]!)
  return (r as unknown as { vfx: { spawned: number } }).vfx.spawned
}

test('effects are derived per sim step: 2 steps per render spawns the same as 1', () => {
  const states = buildFixture()
  let expected = 0
  for (const s of states) for (const f of s.fighters) {
    if (f.events & (EV.HIT_TAKEN | EV.BLOCKED | EV.KO | EV.DEFLECTED | EV.THROWN)) expected++
  }
  expect(expected).toBeGreaterThan(10)
  const perStep = countHits(states, 1)
  expect(perStep).toBeGreaterThanOrEqual(expected)
  // The play loop calls onStep for every step even when a render spans 2 or 6, so the count is the per-step count.
  const r = new FighterRenderer()
  for (let i = 1; i < states.length; i++) r.onStep(states[i - 1]!, states[i]!)
  expect((r as unknown as { vfx: { spawned: number } }).vfx.spawned).toBe(perStep)
  // Deriving only on every 2nd step (the old behaviour) really does lose effects.
  expect(countHits(states, 2)).toBeLessThan(perStep)
})

function pair(): [FighterState, FighterState] {
  const a = createState(1)
  return [cloneState(a), cloneState(a)]
}

test('a light trade is classified by the previous attack, not the hitstun both fighters are in', () => {
  const [prev, next] = pair()
  prev.fighters[0].moveId = M.STAND_L
  prev.fighters[1].moveId = M.STAND_L
  next.fighters[0].moveId = M.HITSTUN
  next.fighters[1].moveId = M.HITSTUN
  next.fighters[0].events = EV.HIT_TAKEN | EV.COUNTER_HIT
  next.fighters[1].events = EV.HIT_TAKEN | EV.COUNTER_HIT
  expect(hitKindFor(prev, next, 1)).toBe('light')
  expect(hitKindFor(prev, next, 0)).toBe('light')
  const hits: HudSnapshot['hits'] = []
  const r = new FighterRenderer({ onHud: (h) => hits.push(...h.hits) })
  r.onStep(prev, next)
  expect(hits).toEqual(['counter', 'counter']) // both were mid-attack, so the sim scores each as a counter
})

test('a projectile that lands after the thrower recovered is a medium spark', () => {
  const [prev, next] = pair()
  prev.fighters[0].moveId = M.IDLE
  prev.fighters[0].projectile.on = 1
  prev.fighters[0].projectile.move = M.SPARK
  next.fighters[0].moveId = M.IDLE
  next.fighters[1].moveId = M.HITSTUN
  next.fighters[1].events = EV.HIT_TAKEN
  expect(hitKindFor(prev, next, 0)).toBe('medium')
})

test('a throw spawns only the throw effect, a deflect only the green ring', () => {
  const [prev, next] = pair()
  next.fighters[0].moveId = M.THROW
  next.fighters[1].moveId = M.THROWN
  next.fighters[1].events = EV.THROWN | EV.HIT_TAKEN
  const hits: HudSnapshot['hits'] = []
  const r = new FighterRenderer({ onHud: (h) => hits.push(...h.hits) })
  r.onStep(prev, next)
  expect(hits).toEqual(['throw'])

  const [p2, n2] = pair()
  n2.frame = 5
  n2.fighters[0].events = EV.BLOCKED
  n2.fighters[1].events = EV.DEFLECTED
  hits.length = 0
  r.onStep(p2, n2)
  expect(hits).toEqual(['deflect'])
})

function hitOn1(defMove: number, extra: number): HudSnapshot['hits'] {
  const [prev, next] = pair()
  prev.fighters[0].moveId = M.STAND_L
  prev.fighters[1].moveId = defMove
  next.fighters[0].moveId = M.STAND_L
  next.fighters[0].events = EV.HIT_DEALT
  next.fighters[1].moveId = M.HITSTUN
  next.fighters[1].events = EV.HIT_TAKEN | extra
  const hits: HudSnapshot['hits'] = []
  new FighterRenderer({ onHud: (h) => hits.push(...h.hits) }).onStep(prev, next)
  return hits
}

test('the counter and punish sparks follow the sim event, not the defender previous move', () => {
  expect(hitOn1(M.STAND_M, EV.COUNTER_HIT)).toEqual(['counter'])
  expect(hitOn1(M.STAND_M, EV.PUNISH_HIT)).toEqual(['punish'])
  expect(hitOn1(M.IDLE, 0)).toEqual(['light'])
  // Mid-attack in the previous step but the sim scored an ordinary hit (it landed from an air move): the level spark.
  expect(hitOn1(M.AIR_M, 0)).toEqual(['light'])
})

test('a projectile that lands while the thrower is in STAND_L is the projectile medium, not a light', () => {
  const [prev, next] = pair()
  prev.fighters[0].moveId = M.STAND_L
  prev.fighters[0].projectile.on = 1
  prev.fighters[0].projectile.move = M.SPARK
  next.fighters[0].moveId = M.STAND_L
  next.fighters[1].moveId = M.HITSTUN
  next.fighters[1].events = EV.HIT_TAKEN
  expect(hitKindFor(prev, next, 0)).toBe('medium')
  // A strike by the same thrower sets HIT_DEALT and keeps the normal's kind.
  next.fighters[0].events = EV.HIT_DEALT
  expect(hitKindFor(prev, next, 0)).toBe('light')
})
