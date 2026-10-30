import { describe, expect, test } from 'bun:test'
import { MOVE } from '@duelwise/core/src/games/arena/input'
import { ACTIONS, ArenaInputSampler, DEFAULT_KEYS, DEFAULT_SETTINGS, cmPer360, parseKeyMap, parseSettings, rebind } from './input'

const press = (s: ArenaInputSampler, ...codes: string[]) => codes.forEach((c) => s.down(c))

describe('arena keyboard and mouse', () => {
  test('WASD give the nine move directions and opposite keys cancel', () => {
    const s = new ArenaInputSampler()
    expect(s.sample().move).toBe(MOVE.N)
    press(s, 'KeyW')
    expect(s.sample().move).toBe(MOVE.F)
    press(s, 'KeyD')
    expect(s.sample().move).toBe(MOVE.FR)
    s.up('KeyW')
    expect(s.sample().move).toBe(MOVE.R)
    press(s, 'KeyS')
    expect(s.sample().move).toBe(MOVE.BR)
    press(s, 'KeyA')
    expect(s.sample().move).toBe(MOVE.B)
    s.blur()
    expect(s.sample().move).toBe(MOVE.N)
  })

  test('the arrow keys move as a second binding next to WASD', () => {
    const s = new ArenaInputSampler()
    press(s, 'ArrowUp')
    expect(s.sample().move).toBe(MOVE.F)
    press(s, 'ArrowRight')
    expect(s.sample().move).toBe(MOVE.FR)
    s.up('ArrowUp')
    press(s, 'ArrowDown')
    expect(s.sample().move).toBe(MOVE.BR)
    press(s, 'ArrowLeft')
    expect(s.sample().move).toBe(MOVE.B)
    // Mixed: W and the Down arrow are forward and back, so they cancel like any opposite pair.
    s.blur()
    press(s, 'KeyW', 'ArrowDown')
    expect(s.sample().move).toBe(MOVE.N)
  })

  test('F fires like the mouse button: held keeps firing, a short tap still fires once, release stops, same input shape', () => {
    const s = new ArenaInputSampler()
    s.down('KeyF'); s.up('KeyF')
    expect(s.sample().fire).toBe(1)
    expect(s.sample().fire).toBe(0)
    s.down('KeyF')
    expect(s.sample().fire).toBe(1)
    expect(s.sample().fire).toBe(1)
    s.up('KeyF')
    expect(s.sample().fire).toBe(0)
    // The sim input is the same object shape as before: the new binding adds no field and no action to the replay.
    const keys = Object.keys(s.sample()).sort()
    expect(keys).toEqual(Object.keys({ ...new ArenaInputSampler().sample() }).sort())
    expect(keys).toContain('fire')
    // F and the mouse button together are still one fire.
    s.mouseDown(0); s.down('KeyF')
    expect(s.sample().fire).toBe(1)
    s.mouseUp(0)
    expect(s.sample().fire).toBe(1)
    s.up('KeyF')
    expect(s.sample().fire).toBe(0)
  })

  test('fire can be rebound like the others, and no default key does two things', () => {
    const moved = rebind(DEFAULT_KEYS, 'fire', 'KeyG')
    expect(moved.fire).toEqual(['KeyG'])
    const s = new ArenaInputSampler(moved)
    s.down('KeyF')
    expect(s.sample().fire).toBe(0)
    s.down('KeyG')
    expect(s.sample().fire).toBe(1)
    // Binding fire to a key another action had takes it from that action.
    const taken = rebind(DEFAULT_KEYS, 'fire', 'Space')
    expect(taken.jump).toEqual([])
    const all = ACTIONS.flatMap((a) => DEFAULT_KEYS[a])
    expect(new Set(all).size).toBe(all.length)
    // The keys the page reads outside the map stay free: buy keys, Tab is scoreboard, Esc is pause.
    for (const reserved of ['Digit1', 'Digit2', 'Digit3', 'Numpad1', 'Numpad2', 'Numpad3']) expect(all).not.toContain(reserved)
    expect(DEFAULT_KEYS.fire).toEqual(['KeyF'])
    expect(DEFAULT_KEYS.back).toContain('KeyS')
  })

  test('a key map saved before Fire existed keeps its bindings and gets F for fire', () => {
    const { fire: _f, ...old } = DEFAULT_KEYS
    const saved = JSON.stringify({ ...old, forward: ['KeyI'] })
    const m = parseKeyMap(saved)
    expect(m.forward).toEqual(['KeyI'])
    expect(m.fire).toEqual(['KeyF'])
  })

  test('buttons: jump, crouch (two keys), walk, reload', () => {
    const s = new ArenaInputSampler()
    press(s, 'Space', 'ControlLeft', 'ShiftLeft', 'KeyR')
    const i = s.sample()
    expect([i.jump, i.crouch, i.walk, i.reload]).toEqual([1, 1, 1, 1])
  })

  test('a tap shorter than a step still fires once; a held button keeps firing', () => {
    const s = new ArenaInputSampler()
    s.mouseDown(0)
    s.mouseUp(0)
    expect(s.sample().fire).toBe(1)
    expect(s.sample().fire).toBe(0)
    s.mouseDown(0)
    expect(s.sample().fire).toBe(1)
    expect(s.sample().fire).toBe(1)
    s.mouseUp(0)
    expect(s.sample().fire).toBe(0)
    s.mouseDown(2)
    expect(s.sample().fire).toBe(0)
  })

  test('mouse right turns the sim yaw down, mouse up looks up, and the fraction is carried', () => {
    const s = new ArenaInputSampler(DEFAULT_KEYS, { ...DEFAULT_SETTINGS, sensitivity: 1 })
    // 0.022 deg per count at sensitivity 1: 100 counts is 2.2 degrees, 50.06 units.
    s.mouseMove(100, 0)
    const a = s.sample()
    expect(a.yaw).toBe(-50)
    s.mouseMove(0, -100)
    expect(s.sample().pitch).toBe(50)
    let total = 0
    for (let i = 0; i < 40; i++) {
      s.mouseMove(1, 0)
      total += s.sample().yaw
    }
    // 40 counts is 20.02 units: the carry means none of it is lost to rounding.
    expect(total).toBe(-20)
  })

  test('a 1,000 degree a second flick turns fully in one step, and nothing is ever thrown away', () => {
    // 16.67 degrees in one 60 Hz step at sensitivity 1 is 757.6 counts (759 gives 380 units whole).
    const s = new ArenaInputSampler(DEFAULT_KEYS, { ...DEFAULT_SETTINGS, sensitivity: 1 })
    s.mouseMove(-759, 0)
    expect(s.sample().yaw).toBe(380)
    // A 90 degree flick in 60 ms (4 steps) and a 180 degree one in 120 ms arrive whole.
    for (const [deg, steps] of [[90, 4], [180, 8]] as const) {
      const f = new ArenaInputSampler(DEFAULT_KEYS, { ...DEFAULT_SETTINGS, sensitivity: 1 })
      let total = 0
      for (let i = 0; i < steps; i++) {
        f.mouseMove(-(deg / 0.022) / steps, 0)
        total += f.sample().yaw
      }
      expect(Math.abs(total - (deg * 8192) / 360)).toBeLessThanOrEqual(1)
    }
    // A turn past the per-frame limit waits for the next steps and is not dropped.
    const h = new ArenaInputSampler(DEFAULT_KEYS, { ...DEFAULT_SETTINGS, sensitivity: 10 })
    h.mouseMove(-20000, 0) // 4400 degrees
    const per: number[] = []
    for (let i = 0; i < 120; i++) per.push(h.sample().yaw)
    expect(per.slice(0, 4)).toEqual([-1024, -1024, -1024, -1024].map((v) => -v))
    expect(per.reduce((a, b) => a + b, 0)).toBe(Math.round((20000 * 0.022 * 10 * 8192) / 360))
  })

  test('pending pitch never goes past the room the sim has left, so a swipe past the ceiling leaves no dead mouse', () => {
    const s = new ArenaInputSampler(DEFAULT_KEYS, { ...DEFAULT_SETTINGS, sensitivity: 2 })
    s.setPitch(1500)
    s.mouseMove(0, -10000) // a huge swipe up
    expect(s.pendingTurn().pitch).toBe(1900 - 1500)
    for (let i = 0; i < 4; i++) s.sample() // the sim takes it and sits at the ceiling
    s.setPitch(1900)
    s.mouseMove(0, 40) // dragging down at once
    expect(s.sample().pitch).toBeLessThan(0)
    s.setPitch(-1500)
    s.mouseMove(0, 10000)
    expect(s.pendingTurn().pitch).toBe(-1900 + 1500)
  })

  test('the camera can read the turn that has not reached the sim yet', () => {
    const s = new ArenaInputSampler(DEFAULT_KEYS, { ...DEFAULT_SETTINGS, sensitivity: 1 })
    s.mouseMove(100, -50)
    const p = s.pendingTurn()
    expect(p.yaw).toBeCloseTo(-50.06, 1)
    expect(p.pitch).toBeCloseTo(25.03, 1)
    const sent = s.sample()
    expect(sent.yaw).toBe(-50)
    expect(Math.abs(s.pendingTurn().yaw)).toBeLessThan(0.5)
    s.mouseMove(10, 0)
    s.blur()
    expect(s.pendingTurn()).toEqual({ yaw: 0, pitch: 0 })
  })

  test('a queued buy is read once', () => {
    const s = new ArenaInputSampler()
    s.queueBuy(2)
    expect(s.sample().buy).toBe(2)
    expect(s.sample().buy).toBe(0)
  })

  test('rebinding takes the key from the action that had it', () => {
    const m = rebind(DEFAULT_KEYS, 'jump', 'KeyW')
    expect(m.jump).toEqual(['KeyW'])
    // W moves off forward; forward keeps its second binding, so the key is never on two actions.
    expect(m.forward).toEqual(['ArrowUp'])
    expect(m.forward).not.toContain('KeyW')
  })

  test('malformed saved data gives the defaults', () => {
    expect(parseKeyMap('{"forward": 3}')).toBe(DEFAULT_KEYS)
    expect(parseKeyMap('nope')).toBe(DEFAULT_KEYS)
    expect(parseSettings('nope')).toBe(DEFAULT_SETTINGS)
    expect(parseSettings(JSON.stringify({ sensitivity: 99, crosshair: { color: 'red', size: -4 } }))).toMatchObject({ sensitivity: 10, crosshair: { color: '#9cff5a', size: 1 } })
  })

  test('cm per 360 follows sensitivity and DPI', () => {
    // 360 / (0.022 * 2) counts = 8181.8 counts; at 800 dpi that is 10.23 inches = 25.98 cm.
    expect(cmPer360({ sensitivity: 2, dpi: 800 })).toBeCloseTo(25.98, 1)
    expect(cmPer360({ sensitivity: 4, dpi: 800 })).toBeCloseTo(12.99, 1)
  })
})
