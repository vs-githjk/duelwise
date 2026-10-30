import type { GameCore } from '../../types'
import { fighterCore } from './core'
import type { FighterInput } from './input'
import type { FighterObs } from './encode'
import type { FighterState } from './state'

// The real fighter core (T6). packages/core/src/games/index.ts picks up `core` from here.
export const core: GameCore<FighterState, FighterInput, FighterObs> = fighterCore

export { fighterCore, stepInPlace, stepPacked } from './core'
export { fighterEncoder, encodeState, fillObs, buildObs, FIGHTER_FEATURES } from './encode'
export type { FighterObs, FighterView } from './encode'
export { BTN, DIR, N_ACTIONS, packInput, unpackInput, mirrorInput, NEUTRAL_INPUT } from './input'
export type { FighterInput } from './input'
export { EV, PHASE, createState, cloneState, copyState } from './state'
export type { Fighter, FighterState } from './state'
export { M, MOVES } from './moves'
