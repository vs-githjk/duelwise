import { describe, expect, test } from 'bun:test'
import { BTN, DIR } from '@duelwise/core/src/games/fighter/input'
import { DEFAULT_KEYS, KeyboardInput, parseKeyMap, rebind } from './input'

describe('KeyboardInput', () => {
  test('arrow keys match WASD and leave attack keys available', () => {
    const k = new KeyboardInput()
    for (const [key, dir] of [['ArrowLeft', DIR.L], ['ArrowRight', DIR.R], ['ArrowUp', DIR.U], ['ArrowDown', DIR.D]] as const) {
      k.down(key)
      expect(k.sample().dir).toBe(dir)
      k.up(key)
    }
    k.down('ArrowRight')
    k.down('KeyJ')
    expect(k.sample()).toEqual({ dir: DIR.R, btn: BTN.LIGHT })
  })
  test('maps WASD to the nine directions', () => {
    const k = new KeyboardInput()
    expect(k.sample()).toEqual({ dir: DIR.N, btn: BTN.NONE })
    k.down('KeyD')
    expect(k.sample().dir).toBe(DIR.R)
    k.down('KeyW')
    expect(k.sample().dir).toBe(DIR.UR)
    k.up('KeyD')
    k.down('KeyA')
    expect(k.sample().dir).toBe(DIR.UL)
    k.up('KeyW')
    k.down('KeyS')
    expect(k.sample().dir).toBe(DIR.DL)
  })

  test('opposite directions cancel left and right; up beats down', () => {
    const k = new KeyboardInput()
    k.down('KeyA')
    k.down('KeyD')
    expect(k.sample().dir).toBe(DIR.N)
    k.up('KeyA')
    k.up('KeyD')
    k.down('KeyW')
    k.down('KeyS')
    expect(k.sample().dir).toBe(DIR.U)
  })

  test('the newest button wins while several are held', () => {
    const k = new KeyboardInput()
    k.down('KeyJ')
    k.down('KeyK')
    expect(k.sample().btn).toBe(BTN.MEDIUM)
    k.up('KeyK')
    expect(k.sample().btn).toBe(BTN.LIGHT)
  })

  test('a tap shorter than one sample still registers once', () => {
    const k = new KeyboardInput()
    k.down('KeyL')
    k.up('KeyL')
    expect(k.sample().btn).toBe(BTN.HEAVY)
    expect(k.sample().btn).toBe(BTN.NONE)
  })

  test('every button key maps to its own button', () => {
    const k = new KeyboardInput()
    const want: Array<[string, number]> = [['KeyJ', BTN.LIGHT], ['KeyK', BTN.MEDIUM], ['KeyL', BTN.HEAVY], ['KeyU', BTN.SPECIAL], ['KeyI', BTN.SURGE], ['Space', BTN.THROW]]
    for (const [code, btn] of want) {
      k.down(code)
      expect(k.sample().btn).toBe(btn)
      k.up(code)
      k.sample()
    }
  })

  test('blur releases everything and ignores auto-repeat', () => {
    const k = new KeyboardInput()
    k.down('KeyD')
    k.down('KeyD')
    k.up('KeyD')
    expect(k.sample().dir).toBe(DIR.N)
    k.down('KeyD')
    k.down('KeyJ')
    k.blur()
    expect(k.sample()).toEqual({ dir: DIR.N, btn: BTN.NONE })
  })

  test('reports pause and unknown keys', () => {
    const k = new KeyboardInput()
    expect(k.actionFor('Escape')).toBe('pause')
    expect(k.actionFor('KeyZ')).toBeNull()
  })
})

describe('key map', () => {
  test('rebinding moves a key and takes it from the action that had it', () => {
    const m = rebind(DEFAULT_KEYS, 'light', 'KeyF')
    expect(m.light).toEqual(['KeyF'])
    const stolen = rebind(m, 'heavy', 'KeyF')
    expect(stolen.heavy).toEqual(['KeyF'])
    expect(stolen.light).toEqual([])
  })

  test('parseKeyMap falls back to the defaults on bad data', () => {
    expect(parseKeyMap('not json')).toEqual(DEFAULT_KEYS)
    expect(parseKeyMap(JSON.stringify({ light: 5 }))).toEqual(DEFAULT_KEYS)
    expect(parseKeyMap(JSON.stringify({ ...DEFAULT_KEYS, light: ['KeyF'] })).light).toEqual(['KeyF'])
  })

  test('upgrades old default movement keys without stealing a custom arrow binding', () => {
    const old = { ...DEFAULT_KEYS, up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], light: ['ArrowLeft'] }
    const map = parseKeyMap(JSON.stringify(old))
    expect(map.up).toEqual(['KeyW', 'ArrowUp'])
    expect(map.left).toEqual(['KeyA'])
    expect(map.light).toEqual(['ArrowLeft'])
  })

  test('a custom map drives the sampler', () => {
    const k = new KeyboardInput(rebind(DEFAULT_KEYS, 'light', 'KeyF'))
    k.down('KeyF')
    expect(k.sample().btn).toBe(BTN.LIGHT)
    k.up('KeyF')
    k.sample()
    k.down('KeyJ')
    expect(k.sample().btn).toBe(BTN.NONE)
  })
})
