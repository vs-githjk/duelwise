// Raw move tables. Timing follows the public frame data of a modern 2D fighting game
// (see docs/game-design/fighter.md for each number and its source; REPORTED unless noted).
// Names, boxes and the character are original.
//
// Convention: `startup` is the number of the first active frame (so a startup of 4 means the
// move can connect on its 4th frame), `active` is the count of active frames, `recovery` is
// the count of frames after the last active frame, `onHit` and `onBlock` are frame advantages
// when the move connects on its first active frame.

export type HitLevel = 'mid' | 'low' | 'high'

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export interface RawMove {
  name: string
  startup: number
  active: number
  recovery: number
  damage: number
  /** Frame advantage on hit/block. Omitted for air normals and projectiles, which give hitstun directly. */
  onHit?: number
  onBlock?: number
  hitstun?: number
  blockstun?: number
  hitstop: number
  level: HitLevel
  hit: Rect
  meterHit: number
  pushHit: number
  pushBlock: number
  knockdown: boolean
  /** Surge gauge drained from a defender who blocks. */
  drainBlock: number
  /** Blocked chip damage = damage / chipDiv (0 means none). */
  chipDiv: number
  /**
   * Frames after the last active frame in which the extended limb stays a hurtbox (the recovery
   * hurtbox: a whiffed poke can be punished by reaching the limb). Omitted means none.
   */
  limbExtra?: number
}

const r = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0, y0, x1, y1 })

export const RAW: Record<string, RawMove> = {
  standLight: { name: 'Quick', startup: 4, active: 2, recovery: 6, damage: 300, onHit: 4, onBlock: 1, hitstop: 8, level: 'mid', hit: r(20, 90, 100, 140), meterHit: 250, pushHit: 14, pushBlock: 18, knockdown: false, drainBlock: 1000, chipDiv: 0, limbExtra: 3 },
  standMedium: { name: 'Drive', startup: 6, active: 3, recovery: 12, damage: 600, onHit: 5, onBlock: 0, hitstop: 10, level: 'mid', hit: r(20, 80, 125, 140), meterHit: 350, pushHit: 16, pushBlock: 20, knockdown: false, drainBlock: 1500, chipDiv: 0, limbExtra: 5 },
  standHeavy: { name: 'Smash', startup: 10, active: 3, recovery: 18, damage: 900, onHit: 3, onBlock: -2, hitstop: 12, level: 'mid', hit: r(20, 60, 150, 130), meterHit: 500, pushHit: 20, pushBlock: 24, knockdown: false, drainBlock: 2000, chipDiv: 0, limbExtra: 8 },
  forwardHeavy: { name: 'Axe', startup: 24, active: 3, recovery: 14, damage: 700, onHit: 4, onBlock: -4, hitstop: 11, level: 'high', hit: r(10, 60, 110, 178), meterHit: 400, pushHit: 14, pushBlock: 18, knockdown: false, drainBlock: 1800, chipDiv: 0, limbExtra: 6 },
  crouchLight: { name: 'Low Quick', startup: 4, active: 2, recovery: 7, damage: 250, onHit: 4, onBlock: 1, hitstop: 8, level: 'low', hit: r(20, 10, 95, 45), meterHit: 200, pushHit: 12, pushBlock: 16, knockdown: false, drainBlock: 1000, chipDiv: 0, limbExtra: 3 },
  crouchMedium: { name: 'Low Drive', startup: 7, active: 3, recovery: 13, damage: 500, onHit: 4, onBlock: -1, hitstop: 10, level: 'low', hit: r(20, 0, 130, 45), meterHit: 300, pushHit: 16, pushBlock: 20, knockdown: false, drainBlock: 1500, chipDiv: 0, limbExtra: 5 },
  crouchHeavy: { name: 'Sweep', startup: 9, active: 3, recovery: 22, damage: 800, onHit: 0, onBlock: -12, hitstop: 12, level: 'low', hit: r(20, 0, 170, 35), meterHit: 450, pushHit: 10, pushBlock: 22, knockdown: true, drainBlock: 2000, chipDiv: 0, limbExtra: 10 },
  airLight: { name: 'Air Quick', startup: 5, active: 8, recovery: 0, damage: 400, hitstun: 17, blockstun: 11, hitstop: 8, level: 'high', hit: r(10, 40, 80, 110), meterHit: 200, pushHit: 10, pushBlock: 14, knockdown: false, drainBlock: 1000, chipDiv: 0 },
  airMedium: { name: 'Air Drive', startup: 7, active: 6, recovery: 0, damage: 700, hitstun: 20, blockstun: 14, hitstop: 10, level: 'high', hit: r(10, 30, 100, 110), meterHit: 300, pushHit: 12, pushBlock: 16, knockdown: false, drainBlock: 1500, chipDiv: 0 },
  airHeavy: { name: 'Air Smash', startup: 9, active: 5, recovery: 0, damage: 900, hitstun: 22, blockstun: 16, hitstop: 12, level: 'high', hit: r(0, 10, 110, 120), meterHit: 450, pushHit: 14, pushBlock: 18, knockdown: false, drainBlock: 2000, chipDiv: 0 },
  // Throw: damage and range are applied by the throw rules, `hit` is unused.
  throw: { name: 'Grab', startup: 5, active: 2, recovery: 22, damage: 1200, hitstop: 0, level: 'mid', hit: r(0, 0, 0, 0), meterHit: 800, pushHit: 0, pushBlock: 0, knockdown: true, drainBlock: 0, chipDiv: 0 },
  // Projectile spawns on its startup frame; hit rect is the projectile box around its centre.
  spark: { name: 'Spark', startup: 13, active: 1, recovery: 39, damage: 600, hitstun: 22, blockstun: 16, hitstop: 8, level: 'mid', hit: r(-22, -18, 22, 18), meterHit: 400, pushHit: 8, pushBlock: 12, knockdown: false, drainBlock: 2500, chipDiv: 8 },
  riser: { name: 'Riser', startup: 3, active: 6, recovery: 30, damage: 1100, onBlock: -30, hitstop: 12, level: 'mid', hit: r(8, 0, 75, 210), meterHit: 500, pushHit: 10, pushBlock: 12, knockdown: true, drainBlock: 2500, chipDiv: 8 },
  ember: { name: 'Ember Wave', startup: 8, active: 1, recovery: 36, damage: 2100, hitstun: 40, blockstun: 22, hitstop: 14, level: 'mid', hit: r(-30, -28, 30, 28), meterHit: 0, pushHit: 6, pushBlock: 14, knockdown: true, drainBlock: 3500, chipDiv: 6 },
  deflect: { name: 'Deflect', startup: 2, active: 12, recovery: 14, damage: 0, hitstop: 0, level: 'mid', hit: r(0, 0, 0, 0), meterHit: 0, pushHit: 0, pushBlock: 0, knockdown: false, drainBlock: 0, chipDiv: 0 },
  rush: { name: 'Rush', startup: 1, active: 1, recovery: 14, damage: 0, hitstop: 0, level: 'mid', hit: r(0, 0, 0, 0), meterHit: 0, pushHit: 0, pushBlock: 0, knockdown: false, drainBlock: 0, chipDiv: 0 },
  breaker: { name: 'Breaker', startup: 26, active: 3, recovery: 24, damage: 800, hitstun: 36, blockstun: 18, hitstop: 14, level: 'mid', hit: r(20, 30, 130, 150), meterHit: 400, pushHit: 20, pushBlock: 30, knockdown: false, drainBlock: 3500, chipDiv: 8 },
}

export const PROJECTILE_SPEED = { spark: 6, ember: 9 } as const
