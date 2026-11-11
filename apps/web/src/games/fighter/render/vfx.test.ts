import { expect, test } from 'bun:test'
import { HIT_SPECS, Vfx, maxCoreRadius, maxRingRadius, type HitKind } from './vfx.ts'

const FIGHTER_HEIGHT = 1.7
const TORSO = 0.6

test('hit rings stay fist to head sized against a 1.7 tall fighter', () => {
  for (const kind of Object.keys(HIT_SPECS) as HitKind[]) {
    expect(maxRingRadius(kind)).toBeLessThanOrEqual(kind === 'ko' ? TORSO : 0.5)
    expect(maxRingRadius(kind) * 2).toBeLessThan(FIGHTER_HEIGHT * 0.7)
  }
  expect(maxRingRadius('ko')).toBeLessThanOrEqual(TORSO)
  const heavy = maxRingRadius('heavy')
  expect(heavy).toBeGreaterThanOrEqual(0.35)
  expect(heavy).toBeLessThanOrEqual(0.45)
})

test('effect size scales with the move level', () => {
  expect(HIT_SPECS.light.size).toBeLessThan(HIT_SPECS.medium.size)
  expect(HIT_SPECS.medium.size).toBeLessThan(HIT_SPECS.heavy.size)
  expect(maxRingRadius('medium')).toBeLessThan(maxRingRadius('heavy'))
})

test('hits get a filled core flash, biggest for heavy, counter and punish; blocks and deflects stay rings (R30)', () => {
  for (const kind of ['light', 'medium', 'heavy', 'counter', 'punish', 'throw', 'ko'] as const) expect(HIT_SPECS[kind].core).toBeGreaterThan(0)
  for (const kind of ['block', 'deflect'] as const) expect(HIT_SPECS[kind].core).toBe(0)
  expect(maxCoreRadius('light')).toBeLessThan(maxCoreRadius('medium'))
  expect(maxCoreRadius('medium')).toBeLessThan(maxCoreRadius('heavy'))
  expect(maxCoreRadius('heavy')).toBeLessThan(maxCoreRadius('counter'))
  expect(maxCoreRadius('counter')).toBeLessThan(maxCoreRadius('punish'))
  // Still no bigger than a torso against a 1.7 tall fighter.
  for (const kind of Object.keys(HIT_SPECS) as HitKind[]) expect(maxCoreRadius(kind)).toBeLessThanOrEqual(TORSO)
})

test('a spawned hit shows its core, fades it out, and is hidden afterwards', () => {
  const vfx = new Vfx()
  vfx.spawn('punish', 0, 1, 1)
  const fx = vfx.group.children.find((g) => g.visible)!
  const core = fx.children.find((c) => (c as { geometry?: { parameters?: { segments?: number } } }).geometry?.parameters?.segments === 28)!
  expect(core.visible).toBe(true)
  vfx.update(1 / 60)
  const early = (core as unknown as { material: { opacity: number } }).material.opacity
  vfx.update(8 / 60)
  const late = (core as unknown as { material: { opacity: number } }).material.opacity
  expect(early).toBeGreaterThan(late)
  vfx.update(1)
  expect(vfx.activeCount()).toBe(0)
})

// KC1 (tinderbox-r2): the sparks were still read as "large thin rings". The filled flash now leads and the ring is only its shock edge.
test('a hit is a filled burst: the core is at least 70 percent of the ring, a white-hot centre shows first, and the ring is faint', () => {
  for (const kind of ['medium', 'heavy', 'counter', 'punish', 'throw', 'ko'] as const) {
    expect(maxCoreRadius(kind)).toBeGreaterThanOrEqual(0.7 * maxRingRadius(kind))
  }
  const vfx = new Vfx()
  vfx.spawn('heavy', 0, 1, 1)
  const fx = vfx.group.children.find((g) => g.visible)!
  type M = { material: { opacity: number }; geometry: { type: string; parameters?: { segments?: number } } }
  const kids = fx.children.filter((c) => c.visible) as unknown as M[]
  const [core, hot] = kids.filter((c) => c.geometry.parameters?.segments === 28)
  const ring = kids.find((c) => c.geometry.type === 'RingGeometry')!
  vfx.update(1 / 60)
  expect(hot!.material.opacity).toBeGreaterThan(0.8)
  expect(core!.material.opacity).toBeGreaterThan(0.8)
  expect(ring!.material.opacity).toBeLessThanOrEqual(0.3)
  vfx.update(10 / 60)
  expect(hot!.material.opacity).toBe(0)
})

test('a deflect keeps its bold ring and has no flash', () => {
  const vfx = new Vfx()
  vfx.spawn('deflect', 0, 1, 1)
  const fx = vfx.group.children.find((g) => g.visible)!
  const ring = fx.children.find((c) => c.visible && (c as { geometry?: { type?: string } }).geometry?.type === 'RingGeometry') as unknown as { material: { opacity: number } }
  vfx.update(1 / 60)
  expect(ring.material.opacity).toBeGreaterThan(0.7)
})

test('cancelling an event fades the spark it made within two frames and leaves others alone (S6)', () => {
  const vfx = new Vfx()
  vfx.spawn('heavy', 0, 1, 1, 77)
  vfx.spawn('heavy', 1, 1, 1, 78)
  vfx.update(1 / 60)
  vfx.cancel(77)
  vfx.update(3 / 60)
  expect(vfx.activeCount()).toBe(1)
  vfx.cancel(999)
  vfx.update(1 / 60)
  expect(vfx.activeCount()).toBe(1)
})
