import { describe, expect, test } from 'bun:test'
import { BTN, DIR } from '@duelwise/core/src/games/fighter/input'
import { KeyboardInput } from './input'
import { PadReader, padSeats, readPad, type PadLike } from './gamepad'

// A fake pad in the standard layout: 16 buttons, 4 axes.
function pad(index: number, over: { axes?: number[]; down?: number[]; connected?: boolean } = {}): PadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: (over.down ?? []).includes(i), value: (over.down ?? []).includes(i) ? 1 : 0 }))
  return { index, connected: over.connected ?? true, mapping: 'standard', axes: over.axes ?? [0, 0, 0, 0], buttons }
}
const NONE = { up: false, down: false, left: false, right: false }

describe('a gamepad as a fighter controller', () => {
  test('the d-pad and the left stick give the nine directions', () => {
    expect(readPad(pad(0, { down: [12] }), NONE).dirs).toEqual({ up: true, down: false, left: false, right: false })
    expect(readPad(pad(0, { down: [13, 15] }), NONE).dirs).toEqual({ up: false, down: true, left: false, right: true })
    expect(readPad(pad(0, { axes: [-0.9, 0, 0, 0] }), NONE).dirs).toEqual({ up: false, down: false, left: true, right: false })
    expect(readPad(pad(0, { axes: [0.8, -0.9, 0, 0] }), NONE).dirs).toEqual({ up: true, down: false, left: false, right: true })
    // Inside the dead zone nothing moves.
    expect(readPad(pad(0, { axes: [0.1, 0.1, 0, 0] }), NONE).dirs).toEqual(NONE)
  })
  test('the stick keeps the existing hysteresis: a thumb drifting off level keeps walking', () => {
    const walking = { up: false, down: false, left: false, right: true }
    expect(readPad(pad(0, { axes: [0.8, -0.3, 0, 0] }), walking).dirs.up).toBe(false)
    expect(readPad(pad(0, { axes: [0.8, -0.3, 0, 0] }), walking).dirs.right).toBe(true)
  })
  test('the face buttons give light, medium, heavy, special, surge and throw', () => {
    const pressed = (b: number) => [...readPad(pad(0, { down: [b] }), NONE).buttons]
    expect(pressed(2)).toEqual(['light'])
    expect(pressed(3)).toEqual(['medium'])
    expect(pressed(5)).toEqual(['heavy'])
    expect(pressed(0)).toEqual(['special'])
    expect(pressed(1)).toEqual(['surge'])
    expect(pressed(7)).toEqual(['throw'])
    expect(pressed(9)).toEqual(['pause'])
  })
  test('a missing or disconnected pad gives neutral', () => {
    expect(readPad(null, NONE)).toEqual({ dirs: NONE, buttons: new Set() })
    expect(readPad(pad(0, { connected: false, down: [2, 15] }), NONE)).toEqual({ dirs: NONE, buttons: new Set() })
  })
  test('two pads map to two seats in index order, and a null slot is skipped', () => {
    const list = [null, pad(3, { down: [2] }), pad(1), null]
    const seats = padSeats(list)
    expect(seats[0]!.index).toBe(1)
    expect(seats[1]!.index).toBe(3)
    expect(padSeats([pad(0), pad(1), pad(2)]).length).toBe(2)
    expect(padSeats([])).toEqual([null, null])
  })
  test('a PadReader drives a KeyboardInput: hold, tap, release, and a pad that vanishes lets go of everything', () => {
    let pads: Array<PadLike | null> = [pad(0, { down: [15, 2] }), null]
    const kb = [new KeyboardInput(), new KeyboardInput()]
    const reader = new PadReader(() => pads)
    reader.poll(kb)
    expect(kb[0]!.sample()).toEqual({ dir: DIR.R, btn: BTN.LIGHT })
    expect(kb[1]!.sample()).toEqual({ dir: DIR.N, btn: BTN.NONE })
    // The button is still held: it stays pressed on the next sample.
    reader.poll(kb)
    expect(kb[0]!.sample()).toEqual({ dir: DIR.R, btn: BTN.LIGHT })
    pads = [pad(0, { down: [15] }), null]
    reader.poll(kb)
    expect(kb[0]!.sample()).toEqual({ dir: DIR.R, btn: BTN.NONE })
    pads = [null, null]
    reader.poll(kb)
    expect(kb[0]!.sample()).toEqual({ dir: DIR.N, btn: BTN.NONE })
  })
  test('pause is reported once per press', () => {
    let pads: Array<PadLike | null> = [pad(0, { down: [9] }), null]
    const kb = [new KeyboardInput(), new KeyboardInput()]
    const reader = new PadReader(() => pads)
    expect(reader.poll(kb)).toBe(true)
    expect(reader.poll(kb)).toBe(false)
    pads = [pad(0), null]
    reader.poll(kb)
    pads = [pad(0, { down: [9] }), null]
    expect(reader.poll(kb)).toBe(true)
  })
  test('pausing resets the held keys but a Start that is still down does not count as a new press', () => {
    const pads: Array<PadLike | null> = [pad(0, { down: [9, 15] }), null]
    const kb = [new KeyboardInput(), new KeyboardInput()]
    const reader = new PadReader(() => pads)
    expect(reader.poll(kb)).toBe(true)
    reader.reset(kb)
    // The page is paused and the thumb is still on Start: no second toggle, and the held d-pad is pressed afresh once play resumes.
    expect(reader.poll(kb)).toBe(false)
    expect(reader.poll(kb)).toBe(false)
  })
})
