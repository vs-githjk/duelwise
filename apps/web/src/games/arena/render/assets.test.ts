import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// The arena asset manifest: every shipped third-party file, its licence and its size budget (T35b).
// A file not listed here, or listed but missing, or over budget, fails.

const ROOT = join(import.meta.dir, '..', '..', '..', '..', 'public', 'assets', 'arena')
const CREDITS = join(import.meta.dir, '..', '..', '..', '..', '..', '..', 'docs', 'third-party', 'arena-assets.md')
const TOTAL_BUDGET = 20 * 1024 * 1024

interface Entry {
  dir: string
  files: Record<string, number>
  licence: 'CC0'
  source: string
}

const pbr = (id: string, budgets: [number, number, number]): Entry => ({
  dir: `polyhaven/${id}`,
  files: { [`${id}_diff_1k.webp`]: budgets[0], [`${id}_nor_gl_1k.webp`]: budgets[1], [`${id}_rough_1k.webp`]: budgets[2] },
  licence: 'CC0',
  source: `https://polyhaven.com/a/${id}`,
})

const prop = (id: string, files: string[]): Entry => ({
  dir: `polyhaven/${id}`,
  files: Object.fromEntries(files.map((f) => [f, 900_000])),
  licence: 'CC0',
  source: `https://polyhaven.com/a/${id}`,
})

export const NEW_ENTRIES: Entry[] = [
  // JC2 set dressing: glTF, bin and 512 px WebP textures (textures/ is checked by props.test.ts).
  prop('worn_metal_rack', ['worn_metal_rack.gltf', 'worn_metal_rack.bin']),
  prop('plastic_crate_01', ['plastic_crate_01.gltf', 'plastic_crate_01.bin']),
  prop('barrel_03', ['barrel_03.gltf', 'barrel_03.bin']),
  prop('rollershutter_door', ['rollershutter_door.gltf', 'rollershutter_door.bin']),
  prop('mounted_fluorescent_lights', ['mounted_fluorescent_lights.gltf', 'mounted_fluorescent_lights.bin']),
  { dir: 'polyhaven/bolt_action_rifle_7_62', files: { 'bolt_action_rifle_7_62_1k.gltf': 30_000, 'bolt_action_rifle_7_62.bin': 800_000, 'textures/bolt_action_rifle_7_62_diff_1k.webp': 300_000, 'textures/bolt_action_rifle_7_62_nor_gl_1k.webp': 200_000, 'textures/bolt_action_rifle_7_62_arm_1k.webp': 300_000, 'textures/bolt_action_rifle_7_62_accesories_diff_1k.webp': 300_000, 'textures/bolt_action_rifle_7_62_accesories_nor_gl_1k.webp': 300_000, 'textures/bolt_action_rifle_7_62_accesories_arm_1k.webp': 300_000 }, licence: 'CC0', source: 'https://polyhaven.com/a/bolt_action_rifle_7_62' },
  { dir: 'oga-rifle', files: { 'rifle.glb': 80_000 }, licence: 'CC0', source: 'https://opengameart.org/content/low-poly-fps-rifle-and-hands' },
  pbr('blue_metal_plate', [300_000, 40_000, 80_000]),
  pbr('rubberized_track', [700_000, 480_000, 20_000]),
  pbr('fabric_leather_02', [650_000, 200_000, 480_000]),
]

function dirBytes(dir: string): number {
  let sum = 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    sum += statSync(p).isDirectory() ? dirBytes(p) : statSync(p).size
  }
  return sum
}

describe('arena asset manifest (rifle and PBR sets)', () => {
  for (const e of NEW_ENTRIES) {
    test(`${e.dir}: files exist within budget, licence file says ${e.licence}, credited in docs`, () => {
      for (const [name, budget] of Object.entries(e.files)) {
        const p = join(ROOT, e.dir, name)
        expect(existsSync(p), p).toBe(true)
        expect(statSync(p).size, `${name} size`).toBeLessThan(budget)
      }
      const lic = readFileSync(join(ROOT, e.dir, 'LICENSE.txt'), 'utf8')
      expect(lic).toContain('CC0')
      expect(lic).toContain(e.source.replace('https://', ''))
      expect(readFileSync(CREDITS, 'utf8')).toContain(e.source)
    })
  }

  test('the whole arena asset folder stays under the 20 MB budget', () => {
    expect(dirBytes(ROOT)).toBeLessThan(TOTAL_BUDGET)
  })
})
