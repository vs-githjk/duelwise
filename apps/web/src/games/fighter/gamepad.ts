import { fighterStickDirections, type StickDirs } from '../touch/TouchControls'
import type { Action, KeyboardInput } from './input'

// Gamepads for the fighter (the Gamepad API, standard layout). A pad is read once per sim step and fed into the same KeyboardInput
// sampler the keys and the touch buttons use (as `touch:<action>` codes), so a pad gets the same latching, button priority and
// double-tap dash as the keyboard. Two pads become the two seats in the order the browser numbers them.

/** The part of a Gamepad this file reads, so a test can hand in a plain object. */
export interface PadLike {
  index: number
  connected: boolean
  mapping?: string
  axes: ReadonlyArray<number>
  buttons: ReadonlyArray<{ pressed: boolean; value?: number }>
}

export type PadAction = Action

const NO_DIRS: StickDirs = { up: false, down: false, left: false, right: false }

// Standard mapping: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 9 Start, 12 to 15 the d-pad.
const BUTTON_ACTION: ReadonlyArray<readonly [number, PadAction]> = [
  [2, 'light'],
  [3, 'medium'],
  [5, 'heavy'],
  [0, 'special'],
  [1, 'surge'],
  [7, 'throw'],
  [9, 'pause'],
]

export interface PadState {
  dirs: StickDirs
  buttons: Set<PadAction>
}

const down = (p: PadLike, i: number): boolean => {
  const b = p.buttons[i]
  return b !== undefined && (b.pressed || (b.value ?? 0) > 0.6)
}

/** One pad's directions (d-pad or left stick, with the fighter stick's hysteresis) and held buttons. A missing or disconnected pad is neutral. */
export function readPad(pad: PadLike | null, prev: StickDirs): PadState {
  if (!pad || !pad.connected) return { dirs: NO_DIRS, buttons: new Set() }
  const stick = fighterStickDirections(pad.axes[0] ?? 0, pad.axes[1] ?? 0, prev)
  const dirs: StickDirs = {
    up: stick.up || down(pad, 12),
    down: stick.down || down(pad, 13),
    left: stick.left || down(pad, 14),
    right: stick.right || down(pad, 15),
  }
  const buttons = new Set<PadAction>()
  for (const [i, a] of BUTTON_ACTION) if (down(pad, i)) buttons.add(a)
  return { dirs, buttons }
}

/** The pads for seat 0 and seat 1: connected pads in index order, the first two. */
export function padSeats(list: ReadonlyArray<PadLike | null>): [PadLike | null, PadLike | null] {
  const live = list.filter((p): p is PadLike => p !== null && p !== undefined && p.connected).sort((a, b) => a.index - b.index)
  return [live[0] ?? null, live[1] ?? null]
}

const DIR_ACTIONS = ['up', 'down', 'left', 'right'] as const

/** Polls the pads and presses and releases `touch:<action>` on each seat's sampler. `poll` returns true when a pad's Start was newly pressed. */
export class PadReader {
  private dirs: [StickDirs, StickDirs] = [NO_DIRS, NO_DIRS]
  private held: [Set<PadAction>, Set<PadAction>] = [new Set(), new Set()]

  constructor(private getPads: () => ReadonlyArray<PadLike | null> = () => (typeof navigator !== 'undefined' && navigator.getGamepads ? Array.from(navigator.getGamepads()) : [])) {}

  poll(kb: ReadonlyArray<KeyboardInput>): boolean {
    const seats = padSeats(this.getPads())
    let pause = false
    for (const i of [0, 1] as const) {
      const now = readPad(seats[i], this.dirs[i])
      const input = kb[i]
      if (input) {
        for (const a of DIR_ACTIONS) {
          if (now.dirs[a] !== this.dirs[i][a]) now.dirs[a] ? input.down(`touch:${a}`) : input.up(`touch:${a}`)
        }
        for (const a of now.buttons) if (a !== 'pause' && !this.held[i].has(a)) input.down(`touch:${a}`)
        for (const a of this.held[i]) if (a !== 'pause' && !now.buttons.has(a)) input.up(`touch:${a}`)
      }
      if (now.buttons.has('pause') && !this.held[i].has('pause')) pause = true
      this.dirs[i] = now.dirs
      this.held[i] = now.buttons
    }
    return pause
  }

  /** Forget what was held (a pause or a lost window): the next poll presses whatever is still down again. */
  reset(kb: ReadonlyArray<KeyboardInput>): void {
    for (const i of [0, 1] as const) {
      const input = kb[i]
      if (input) {
        for (const a of DIR_ACTIONS) if (this.dirs[i][a]) input.up(`touch:${a}`)
        for (const a of this.held[i]) if (a !== 'pause') input.up(`touch:${a}`)
      }
      this.dirs[i] = NO_DIRS
      // A Start that is still down stays remembered, so holding it through a pause does not toggle the pause again.
      this.held[i] = new Set(this.held[i].has('pause') ? ['pause' as const] : [])
    }
  }
}
