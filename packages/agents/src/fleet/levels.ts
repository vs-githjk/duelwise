import type { Level } from '@duelwise/core/src/product'

/**
 * The four Fleet levels are four different algorithms, not one dial (the simulation rejected deliberate misses).
 * `hunt` picks a cell while no hit is open; `target` says what to do once an unsunk ship has been hit.
 * Mean shots to sink all five ships against a random fleet alone (300 solo games after the A9 retune, never against people):
 * Pip 58.6, Marlow 52.1, Vesper 49.3, Sable 44.1. A9 moved Pip and Marlow by their hunt and follow-up rate so each lands in its band against the test players.
 */
export interface FleetLevel {
  name: string
  hunt: 'random' | 'checkerboard' | 'map'
  target: 'follow' | 'neighbours' | 'map'
  /** Chance of following up an open hit; 1 means always. */
  followRate: number
}

export const FLEET_LEVELS: Record<Level, FleetLevel> = {
  easy: { name: 'Pip', hunt: 'checkerboard', target: 'follow', followRate: 0.6 },
  medium: { name: 'Marlow', hunt: 'map', target: 'neighbours', followRate: 0.5 },
  hard: { name: 'Vesper', hunt: 'map', target: 'neighbours', followRate: 1 },
  champion: { name: 'Sable', hunt: 'map', target: 'map', followRate: 1 },
}
