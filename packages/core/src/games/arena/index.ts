import type { GameCore } from '../../types'
import { arenaCore } from './core'
import type { ArenaInput } from './input'
import type { ArenaObs } from './encode'
import type { ArenaState } from './state'

// The real arena core (T9). packages/core/src/games/index.ts picks up `core` from here.
export const core: GameCore<ArenaState, ArenaInput, ArenaObs> = arenaCore

export { arenaCore, createState, stepInPlace, stepPacked, PITCH_LIMIT } from './core'
export type { ArenaOptions } from './core'
export { ARENA_FEATURES, N_RAYS, arenaEncoder, buildObs, encodeState, fillObs } from './encode'
export type { ArenaObs, OppView, SelfView } from './encode'
export { MOVE, N_ACTIONS, NEUTRAL_INPUT, packInput, unpackInput } from './input'
export type { ArenaInput } from './input'
export { EV, PHASE, cloneState, copyState } from './state'
export type { ArenaState, Player } from './state'
export { MAP_IDS, MAP_LIST, getMap, loadMap } from './map'
export type { MapData, MapJson } from './map'
export { WEAPONS, ZONE, damageFor } from './weapons'
export type { Weapon } from './weapons'
export { cosU, sinU } from './trig'
export { rayAabb, rayWorld, segmentBlocked } from './raycast'
