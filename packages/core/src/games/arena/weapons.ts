// Original weapons modelled on the public numbers of three weapon classes. See docs/game-design/arena.md.

export interface Weapon {
  id: number
  name: string
  price: number
  damage: number
  armorPen: number
  rangeMod: number
  /** Frames between shots. */
  cycle: number
  magazine: number
  reloadFrames: number
  maxSpeed: number
  /** 1 holds fire, 0 needs a fresh press per shot. */
  auto: number
  killReward: number
  /** Spread (tangent space) at full run speed once above the accurate speed. */
  moveSpread: number
  /** Extra spread per shot already fired in the spray (up to 10). */
  fireSpread: number
  /** Frames without firing before the shot index resets. */
  recoilReset: number
  /** Punch added by shot k, in angle units (8192 per turn). */
  recoilPitch: readonly number[]
  recoilYaw: readonly number[]
}

export const WEAPONS: readonly Weapon[] = [
  {
    id: 0, name: 'Dart', price: 0, damage: 35, armorPen: 0.505, rangeMod: 0.79, cycle: 9, magazine: 12, reloadFrames: 132,
    maxSpeed: 240, auto: 0, killReward: 300, moveSpread: 0.05, fireSpread: 0.002, recoilReset: 12,
    recoilPitch: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1, 1],
    recoilYaw: [0, 0, 1, -1, 1, -1, 2, -2, 1, -1, 1, -1],
  },
  {
    id: 1, name: 'Ridgeline', price: 2700, damage: 36, armorPen: 0.775, rangeMod: 0.98, cycle: 6, magazine: 30, reloadFrames: 150,
    maxSpeed: 215, auto: 1, killReward: 300, moveSpread: 0.07, fireSpread: 0.0012, recoilReset: 20,
    recoilPitch: [13, 12, 11, 10, 9, 8, 7, 6, 5, 3, 3, 2, 2, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    recoilYaw: [0, 0, 0, 0, 0, 0, 0, 0, 0, -10, -9, -8, -6, -4, -3, 8, 9, 10, 10, 9, 8, 6, 4, -9, -10, -9, -8, -6, -4, -2],
  },
  {
    id: 2, name: 'Carbine', price: 3100, damage: 33, armorPen: 0.7, rangeMod: 0.97, cycle: 5, magazine: 30, reloadFrames: 186,
    maxSpeed: 225, auto: 1, killReward: 300, moveSpread: 0.065, fireSpread: 0.001, recoilReset: 20,
    recoilPitch: [11, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 2, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    recoilYaw: [0, 0, 0, 0, 0, 0, 0, 0, -6, -8, -9, -7, -5, -3, 5, 7, 9, 9, 8, 6, 4, 2, -4, -7, -9, -8, -6, -4, -2, 3],
  },
]

export const ZONE = { HEAD: 0, CHEST: 1, STOMACH: 2, LEGS: 3 } as const
export type ZoneName = 'head' | 'chest' | 'stomach' | 'legs'
const ZONE_BY_NAME: Record<ZoneName, number> = { head: 0, chest: 1, stomach: 2, legs: 3 }
export const ZONE_MULT: readonly number[] = [4, 1, 1.25, 0.75]
/** Hit zone boundaries as a fraction of the hull height. */
export const HEAD_FROM = 0.86
export const CHEST_FROM = 0.57
export const STOMACH_FROM = 0.36
export const ARMOR_BONUS = 0.5
export const MAX_RANGE = 8192

/** Armor lost by the last `calcDamage` call (read right after). */
export const lastHit = { armorLoss: 0 }

/** `rangeMod ^ (distance / 500)` with no pow call: whole steps by multiplication, the rest blended linearly. */
export function falloff(rangeMod: number, dist: number): number {
  let t = dist / 500
  let r = 1
  while (t >= 1) {
    r *= rangeMod
    t -= 1
  }
  return r * (1 - t * (1 - rangeMod))
}

/** Health damage of one bullet (integer); sets `lastHit.armorLoss`. Legs are never protected. */
export function calcDamage(w: Weapon, zone: number, dist: number, armor: number): number {
  const dmg = w.damage * falloff(w.rangeMod, dist) * ZONE_MULT[zone]!
  if (armor > 0 && zone !== ZONE.LEGS) {
    let toHealth = dmg * w.armorPen
    const loss = (dmg - toHealth) * ARMOR_BONUS
    if (loss > armor) {
      toHealth = dmg - armor / ARMOR_BONUS
      lastHit.armorLoss = armor
    } else lastHit.armorLoss = Math.floor(loss + 0.5)
    return Math.floor(toHealth + 0.5)
  }
  lastHit.armorLoss = 0
  return Math.floor(dmg + 0.5)
}

/** Readable wrapper for tests and tooling. */
export function damageFor(w: Weapon, zone: ZoneName, dist: number, armor: number): { health: number; armor: number } {
  const health = calcDamage(w, ZONE_BY_NAME[zone], dist, armor)
  return { health, armor: lastHit.armorLoss }
}

export const ARMOR_PRICE = 1000
export const ARMOR_MAX = 100
export const AIR_SPREAD = 0.12
/** The first shot is exact while speed is at most this fraction of the weapon's max speed (plus 0.5 u/s of float margin). */
export const ACCURATE_FRACTION = 0.34
export const PUNCH_DECAY = 0.9
