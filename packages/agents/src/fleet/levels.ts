import type { Level } from '@duelwise/core/src/product'

/**
 * The four Fleet levels are four different algorithms, not one dial (the simulation rejected deliberate misses).
 * `hunt` picks a cell while no hit is open; `target` says what to do once an unsunk ship has been hit.
 * Mean shots to sink all five ships against a random fleet, from the planning simulation (never measured against people):
 * Pip 71.5, Marlow 55.2, Vesper 48.8, Sable 44.6.
 */
export interface FleetLevel {
  name: string
  hunt: 'random' | 'checkerboard' | 'map'
  target: 'follow' | 'neighbours' | 'map'
  /** Chance of following up an open hit; 1 means always. */
  followRate: number
}

export const FLEET_LEVELS: Record<Level, FleetLevel> = {
  easy: { name: 'Pip', hunt: 'random', target: 'follow', followRate: 0.35 },
  medium: { name: 'Marlow', hunt: 'checkerboard', target: 'neighbours', followRate: 1 },
  hard: { name: 'Vesper', hunt: 'map', target: 'neighbours', followRate: 1 },
  champion: { name: 'Sable', hunt: 'map', target: 'map', followRate: 1 },
}
