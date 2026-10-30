import { M } from '@duelwise/core/src/games/fighter/moves'
import type { Action } from './input'

// How each listed move is asked for, mirroring selectAttack() in the core: a direction requirement and one button.
// "forward" is relative to the fighter's facing, so it is drawn as a right arrow, not as a key.

export type DirReq = 'none' | 'forward' | 'down' | 'up' | 'air'

export interface MoveInput {
  dir: DirReq
  button: Action
}

export const MOVE_INPUT: Record<number, MoveInput> = {
  [M.STAND_L]: { dir: 'none', button: 'light' },
  [M.STAND_M]: { dir: 'none', button: 'medium' },
  [M.STAND_H]: { dir: 'none', button: 'heavy' },
  [M.FORWARD_H]: { dir: 'forward', button: 'heavy' },
  [M.CROUCH_L]: { dir: 'down', button: 'light' },
  [M.CROUCH_M]: { dir: 'down', button: 'medium' },
  [M.CROUCH_H]: { dir: 'down', button: 'heavy' },
  [M.AIR_L]: { dir: 'air', button: 'light' },
  [M.AIR_M]: { dir: 'air', button: 'medium' },
  [M.AIR_H]: { dir: 'air', button: 'heavy' },
  [M.THROW]: { dir: 'none', button: 'throw' },
  [M.SPARK]: { dir: 'none', button: 'special' },
  [M.RISER]: { dir: 'up', button: 'special' },
  [M.EMBER]: { dir: 'down', button: 'special' },
  [M.DEFLECT]: { dir: 'none', button: 'surge' },
  [M.RUSH]: { dir: 'forward', button: 'surge' },
  [M.BREAKER]: { dir: 'down', button: 'surge' },
}

export const DIR_GLYPH: Record<DirReq, string> = { none: '·', forward: '→', down: '↓', up: '↑', air: '↑' }
export const DIR_NAME: Record<DirReq, string> = { none: 'neutral', forward: 'forward', down: 'down', up: 'up', air: 'in the air' }

/** The key that sets a direction requirement, or null when it is not one key (forward follows facing). */
export function dirAction(d: DirReq): Action | null {
  return d === 'down' ? 'down' : d === 'up' || d === 'air' ? 'up' : null
}
