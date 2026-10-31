import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { BTN, DIR } from '@duelwise/core/src/games/fighter/input'
import { MOVE } from '@duelwise/core/src/games/arena/input'
import { KeyboardInput } from '../fighter/input'
import { ArenaInputSampler } from '../arena/input'
import { fighterStickDirections, stickDirections } from './TouchControls'

describe('touch input', () => {
  test('stick has a dead zone and maps angles to directions', () => {
    expect(stickDirections(0.1, 0.1)).toEqual({ up: false, down: false, left: false, right: false })
    expect(stickDirections(-0.8, -0.8)).toEqual({ up: true, down: false, left: true, right: false })
    expect(stickDirections(1, 0.1)).toEqual({ up: false, down: false, left: false, right: true })
  })
  test('fighter touch buttons and movement use the keyboard sampler and latch taps', () => {
    const k = new KeyboardInput()
    k.down('touch:right'); k.down('touch:light'); k.up('touch:light')
    expect(k.sample()).toEqual({ dir: DIR.R, btn: BTN.LIGHT })
    expect(k.sample()).toEqual({ dir: DIR.R, btn: BTN.NONE })
  })
  test('the window losing focus releases keys and leaves a finger down', () => {
    const k = new KeyboardInput()
    k.down('touch:right'); k.down('touch:heavy'); k.down('KeyW'); k.down('KeyJ')
    k.blurKeys()
    expect(k.sample()).toEqual({ dir: DIR.R, btn: BTN.HEAVY })
    k.up('touch:right')
    expect(k.sample().dir).toBe(DIR.N)
  })
  test('a key tap waiting for its sim step is dropped when the window loses focus', () => {
    const k = new KeyboardInput()
    k.down('KeyJ')
    k.blurKeys()
    expect(k.sample().btn).toBe(BTN.NONE)
  })
  test('on a touch screen the window losing focus leaves an arena thumb down', () => {
    const a = new ArenaInputSampler()
    a.down('touch:forward'); a.down('KeyW'); a.mouseDown(0)
    a.blurKeys()
    a.up('KeyW')
    const s = a.sample()
    expect(s.fire).toBe(1)
    a.up('touch:forward')
    expect(a.sample().fire).toBe(1)
  })
  test('arena touch actions and drag use the same sampler as keys and mouse', () => {
    const touch = new ArenaInputSampler(); const desktop = new ArenaInputSampler()
    touch.down('touch:forward'); touch.down('touch:jump'); touch.mouseDown(0); touch.mouseMove(80, -40)
    desktop.down('KeyW'); desktop.down('Space'); desktop.mouseDown(0); desktop.mouseMove(80, -40)
    const result = touch.sample()
    expect(result).toEqual(desktop.sample())
    expect(result.move).toBe(MOVE.F); expect(result.fire).toBe(1); expect(result.jump).toBe(1)
    expect(result.yaw).toBeLessThan(0); expect(result.pitch).toBeGreaterThan(0)
    touch.mouseUp(0); touch.down('touch:reload'); touch.up('touch:reload')
    const next = touch.sample(); expect(next.fire).toBe(0); expect(next.reload).toBe(1)
  })
})

describe('fighter stick', () => {
  const none = { up: false, down: false, left: false, right: false }
  const right = { ...none, right: true }
  test('a thumb drifting off level keeps walking: no crouch, no jump', () => {
    expect(fighterStickDirections(0.9, 0.45)).toEqual(right)
    expect(fighterStickDirections(0.9, -0.45)).toEqual(right)
  })
  test('a clear push still jumps, jumps forward and crouches', () => {
    expect(fighterStickDirections(0, -1)).toEqual({ ...none, up: true })
    expect(fighterStickDirections(0.7, -0.7)).toEqual({ ...none, up: true, right: true })
    expect(fighterStickDirections(0, 1)).toEqual({ ...none, down: true })
    expect(fighterStickDirections(-0.5, 0.85)).toEqual({ ...none, down: true, left: true })
  })
  test('a thumb trembling at the edge of the dead zone never flickers, so it cannot read as a double tap and dash', () => {
    let prev = fighterStickDirections(0.5, 0)
    for (const x of [0.2, 0.25, 0.18, 0.24, 0.2]) {
      prev = fighterStickDirections(x, 0, prev)
      expect(prev).toEqual(right)
    }
  })
  test('a real return to centre releases, so a deliberate double flick still dashes', () => {
    expect(fighterStickDirections(0.05, 0, right)).toEqual(none)
  })
})

describe('touch layout rules', () => {
  const css = readFileSync(new URL('./touch.css', import.meta.url), 'utf8')
  test('controls respect every safe-area inset and keep 48 px targets', () => {
    for (const side of ['left', 'right', 'bottom', 'top']) expect(css).toContain(`env(safe-area-inset-${side})`)
    expect(css).toContain('min-height: 48px')
    expect(css).toContain('min-width: 48px')
  })
})
