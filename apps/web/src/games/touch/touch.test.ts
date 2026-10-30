import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { BTN, DIR } from '@duelwise/core/src/games/fighter/input'
import { MOVE } from '@duelwise/core/src/games/arena/input'
import { KeyboardInput } from '../fighter/input'
import { ArenaInputSampler } from '../arena/input'
import { stickDirections } from './TouchControls'

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

describe('touch layout rules', () => {
  const css = readFileSync(new URL('./touch.css', import.meta.url), 'utf8')
  test('controls respect every safe-area inset and keep 48 px targets', () => {
    for (const side of ['left', 'right', 'bottom', 'top']) expect(css).toContain(`env(safe-area-inset-${side})`)
    expect(css).toContain('min-height: 48px')
    expect(css).toContain('min-width: 48px')
  })
})
