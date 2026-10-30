import { expect, test } from 'bun:test'
import { CHARACTERS, outfitRegion } from './characters.ts'

test('outfit regions leave no underwear look: torso, hips and legs are all clothed', () => {
  const P = 0.9
  const H = 1.7
  expect(outfitRegion('spine_03', 1.3, P, H)).toBe('jacket')
  expect(outfitRegion('upperarm_l', 1.3, P, H)).toBe('jacket')
  expect(outfitRegion('spine_01', P + 0.02, P, H)).toBe('belt')
  expect(outfitRegion('pelvis', P - 0.05, P, H)).toBe('trousers')
  expect(outfitRegion('thigh_r', 0.7, P, H)).toBe('trousers')
  expect(outfitRegion('calf_l', 0.3, P, H)).toBe('trousers')
  expect(outfitRegion('foot_l', 0.05, P, H)).toBe('shoes')
  expect(outfitRegion('head', 1.65, P, H)).toBe('skin')
  expect(outfitRegion('hand_r', 1.0, P, H)).toBe('wrap')
})

test('the default seats contrast', () => {
  expect(CHARACTERS[0]!.colorways[0]!.name).toBe('Ember')
  expect(CHARACTERS[1]!.colorways[1]!.name).toBe('Navy')
  expect(CHARACTERS[0]!.colorways[0]!.jacket).not.toBe(CHARACTERS[1]!.colorways[1]!.jacket)
})

// KC1: the rigs get real parts (hair, headband, gauntlets, pauldrons, knee guards) on top of the painted costume.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Box3, Object3D } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { addOutfitParts } from './characters.ts'

async function loadModel(asset: string): Promise<Object3D> {
  const buf = readFileSync(join(import.meta.dir, `../../../../public/assets/fighter/quaternius/universal-base-characters/${asset}.glb`))
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  const g = await new Promise<{ scene: Object3D }>((res, rej) => new GLTFLoader().parse(ab, '', res as never, rej))
  return g.scene
}

test('both rigs get hair, a headband, gauntlets, cuffs, pauldrons and knee guards; only the ponytail differs', async () => {
  const names: Record<string, string[]> = {}
  for (const def of CHARACTERS) {
    const model = await loadModel(def.asset)
    const own: Array<{ dispose(): void }> = []
    names[def.id] = addOutfitParts(model, def, def.colorways[0]!, own)
    expect(own.length).toBeGreaterThan(10)
  }
  const common = ['hair', 'headband', 'pauldron_l', 'pauldron_r', 'gauntlet_l', 'gauntlet_r', 'cuff_l', 'cuff_r', 'kneeguard_l', 'kneeguard_r'].map((n) => `outfit:${n}`)
  for (const id of ['a', 'b']) for (const n of common) expect(names[id]).toContain(n)
  expect(names.a).toContain('outfit:ponytail')
  expect(names.b).not.toContain('outfit:ponytail')
})

test('parts sit where they belong on the body after attaching to bones (head parts at head height, gauntlets on the forearm, knee guards at the knee)', async () => {
  const def = CHARACTERS[1]!
  const model = await loadModel(def.asset)
  addOutfitParts(model, def, def.colorways[0]!, [])
  model.updateMatrixWorld(true)
  const box = (n: string): Box3 => new Box3().setFromObject(model.getObjectByName(`outfit:${n}`)!)
  const h = box('hair')
  expect(h.min.y).toBeGreaterThan(1.62)
  expect(h.max.y).toBeLessThan(1.9)
  expect(Math.abs((h.min.x + h.max.x) / 2)).toBeLessThan(0.01)
  const g = box('gauntlet_l')
  expect(g.min.x).toBeGreaterThan(0.45)
  expect(g.max.x).toBeLessThan(0.72)
  expect(Math.abs((g.min.y + g.max.y) / 2 - 1.455)).toBeLessThan(0.05)
  const k = box('kneeguard_r')
  expect(Math.abs((k.min.y + k.max.y) / 2 - 0.56)).toBeLessThan(0.05)
  expect(k.max.x).toBeLessThan(0)
  const p = box('pauldron_l')
  expect(p.min.x).toBeGreaterThan(0.1)
  expect(p.max.y).toBeGreaterThan(1.46)
})
