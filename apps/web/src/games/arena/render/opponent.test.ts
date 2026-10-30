import { describe, expect, test } from 'bun:test'
import { makePlayer } from '@duelwise/core/src/games/arena/state.ts'
import { WEAPONS } from '@duelwise/core/src/games/arena/weapons.ts'
import { AnimationClip, Vector3 } from 'three'
import { aimDirection, loadOpponentAssets, opponentBase, PAID_CLIPS_PATH, type BaseClip } from './opponent'
import { paidAssetUrl } from '../../../lib/paid-assets'
import { toScene } from './camera'

describe('opponent stance', () => {
  test('standing still holds the pistol stance, crouching still crouches', () => {
    const p = makePlayer()
    expect(opponentBase(p)).toBe('Pistol_Aim_Neutral')
    p.crouch = 1
    expect(opponentBase(p)).toBe('Crouch_Idle_Loop')
  })

  test('movement picks the clip from velocity relative to facing', () => {
    const p = makePlayer()
    p.weapon = 1
    const top = WEAPONS[1]!.maxSpeed
    p.yaw = 0
    p.vx = top
    expect(opponentBase(p)).toBe('Jog_Fwd_Loop')
    p.vx = -top
    expect(opponentBase(p)).toBe('Jog_Bwd_Loop')
    p.vx = 0
    p.vy = -top // facing +x, moving -y is to the right
    expect(opponentBase(p)).toBe('Jog_Right_Loop')
    p.vy = top
    expect(opponentBase(p)).toBe('Jog_Left_Loop')
    p.yaw = 2048 // facing +y: moving +y is forward
    expect(opponentBase(p)).toBe('Jog_Fwd_Loop')
  })

  test('slow forward movement walks, crouched movement uses the crouch set', () => {
    const p = makePlayer()
    p.weapon = 1
    p.vx = WEAPONS[1]!.maxSpeed * 0.4
    expect(opponentBase(p)).toBe('Walk_Loop')
    p.crouch = 1
    expect(opponentBase(p)).toBe('Crouch_Fwd_Loop')
  })

  test('airborne and dead override everything, a headshot picks the other death', () => {
    const p = makePlayer()
    p.onGround = 0
    expect(opponentBase(p)).toBe('Jump_Loop')
    p.alive = 0
    expect(opponentBase(p)).toBe('Death01')
    expect(opponentBase(p, true)).toBe('Death02')
  })
})

describe('opponent aim direction', () => {
  const from = new Vector3(0, 1.4, 0)
  test('faces the eye: points at it', () => {
    // Yaw 0 looks along sim +x, scene +x.
    const eye = new Vector3(3.5, 1.6, 0)
    const r = aimDirection(from, eye, 0, 0)
    expect(r.w).toBe(1)
    expect(r.dir.angleTo(eye.clone().sub(from))).toBeLessThan(1e-6)
  })
  test('back to the camera: the gun points more than 90 degrees away from the eye', () => {
    const [x, y, z] = toScene(-3.5 / 0.0254, 0, 0)
    const eye = new Vector3(x, 1.6 + y, z)
    const r = aimDirection(from, eye, 0, 0)
    expect(r.w).toBe(0)
    expect(r.dir.angleTo(eye.clone().sub(from))).toBeGreaterThan(Math.PI / 2)
  })
  test('side on stays on the sim aim and follows pitch', () => {
    const eye = new Vector3(0, 1.6, -3.5)
    const r = aimDirection(from, eye, 0, 1024)
    expect(r.w).toBe(0)
    expect(r.dir.y).toBeGreaterThan(0.6)
  })
  test('sweeping yaw one unit at a time across the band never pops the direction', () => {
    // Eye fixed 4 m ahead of yaw 0; the body turns away from it through the whole cone edge band.
    const eye = new Vector3(4, 1.4, 0)
    let prev = aimDirection(from, eye, 1300, 0)
    let worst = 0
    let sawBlend = false
    for (let y = 1301; y <= 1800; y++) {
      const r = aimDirection(from, eye, y, 0)
      worst = Math.max(worst, r.dir.angleTo(prev.dir))
      if (r.w > 0.05 && r.w < 0.95) sawBlend = true
      prev = r
    }
    expect(sawBlend).toBe(true)
    expect(worst).toBeLessThan((2 * Math.PI) / 180)
  })
})

describe('opponent clips with the paid file missing', () => {
  const clip = (name: string): AnimationClip => new AnimationClip(name, 1, [])
  const free = ['Idle_Loop', 'Walk_Loop', 'Sprint_Loop', 'Crouch_Idle_Loop', 'Crouch_Fwd_Loop', 'Death01', 'Jump_Loop', 'Hit_Chest', 'Hit_Head'].map(clip)
  const character = { scene: {} }

  test('uses the paid clips when they load, with the URL from the paid base', async () => {
    const urls: string[] = []
    const load = async (url: string) => {
      urls.push(url)
      return url.includes('ual1-shooter') ? { scene: {}, animations: [clip('Pistol_Aim_Neutral'), clip('Death02')] } : character
    }
    const a = await loadOpponentAssets(load as never, 'https://assets.example')
    expect([...a.clips.keys()].sort()).toEqual(['Death02', 'Pistol_Aim_Neutral'])
    expect(urls).toContain(paidAssetUrl(PAID_CLIPS_PATH, 'https://assets.example'))
  })

  test('falls back to the free clips when the paid fetch fails, and every base clip still resolves', async () => {
    const load = async (url: string) => {
      if (url.includes('ual1-shooter')) throw new Error('404')
      if (url.includes('ual1-combat')) return { scene: {}, animations: free }
      return character
    }
    const a = await loadOpponentAssets(load as never)
    const names: BaseClip[] = [
      'Pistol_Aim_Neutral', 'Walk_Loop', 'Jog_Fwd_Loop', 'Jog_Bwd_Loop', 'Jog_Left_Loop', 'Jog_Right_Loop', 'Crouch_Idle_Loop', 'Crouch_Fwd_Loop',
      'Crouch_Bwd_Loop', 'Crouch_Left_Loop', 'Crouch_Right_Loop', 'Jump_Loop', 'Death01', 'Death02',
    ]
    for (const n of names) expect(a.clips.get(n), n).toBeDefined()
    expect(a.clips.has('Pistol_Shoot')).toBe(false)
    expect(a.clips.get('Jog_Fwd_Loop')).not.toBe(a.clips.get('Jog_Left_Loop'))
  })
})

test('does not request paid clips without a configured base', async () => {
  const urls: string[] = []
  await loadOpponentAssets((async (url: string) => { urls.push(url); return { scene: {}, animations: [] } }) as never, '')
  expect(urls.some((url) => url.includes('ual1-shooter'))).toBe(false)
})
