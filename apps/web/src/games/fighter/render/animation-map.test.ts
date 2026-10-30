import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MOVES, MOVE_COUNT, isAttackId } from '@duelwise/core/src/games/fighter/moves.ts'
import { ANIMATION_MAP, CLIPS, clipTime, requiredClips, unmappedMoves } from './animation-map.ts'

const ROOT = join(import.meta.dir, '..', '..', '..', '..', 'public', 'assets', 'fighter', 'quaternius')
const PACKS = { ual1: 'universal-animation-library/ual1-combat.glb', ual2: 'universal-animation-library-2/ual2-combat.glb' } as const

async function loadDurations(file: string): Promise<Map<string, number>> {
  const buf = readFileSync(join(ROOT, file))
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  const gltf = await new Promise<{ animations: Array<{ name: string; duration: number }> }>((res, rej) => new GLTFLoader().parse(ab, '', res as never, rej))
  return new Map(gltf.animations.map((a) => [a.name, a.duration]))
}

describe('animation map', () => {
  test('every move id has a mapping', () => {
    expect(MOVES.length).toBe(MOVE_COUNT)
    expect(unmappedMoves()).toEqual([])
  })

  test('every mapped clip exists in its pack with the recorded duration', async () => {
    const found = { ual1: await loadDurations(PACKS.ual1), ual2: await loadDurations(PACKS.ual2) }
    for (const name of requiredClips()) {
      const c = CLIPS[name]!
      const d = found[c.pack].get(name)
      expect(d, `${name} in ${c.pack}`).toBeDefined()
      expect(Math.abs(d! - c.duration)).toBeLessThan(0.01)
    }
  })

  test('strikes reach the extended pose on the first active frame and finish on the last frame', () => {
    let strikes = 0
    for (let id = 0; id < MOVE_COUNT; id++) {
      const a = ANIMATION_MAP[id]
      if (!a || a.kind !== 'strike') continue
      strikes++
      const mv = MOVES[id]!
      expect(isAttackId(id)).toBe(true)
      expect(a.peak!).toBeGreaterThan(a.start!)
      expect(a.peak!).toBeLessThanOrEqual(a.end!)
      expect(clipTime(a, id, mv.startup, 100)).toBeCloseTo(a.peak!, 6)
      const last = mv.startup + mv.active - 1
      expect(clipTime(a, id, last, 100)).toBeCloseTo(a.peak! + a.hold!, 6)
      // Air normals end on their last active frame (the sim recovers on landing), so they stop at the held pose.
      expect(clipTime(a, id, mv.total, 100)).toBeCloseTo(mv.total > last ? a.end! : a.peak! + a.hold!, 6)
      let prev = -1
      for (let f = 1; f <= mv.total; f++) {
        const t = clipTime(a, id, f, 100)
        expect(t).toBeGreaterThanOrEqual(prev)
        prev = t
      }
    }
    expect(strikes).toBeGreaterThanOrEqual(12)
  })

  test('loops wrap inside the clip and walking back plays in reverse', () => {
    const walkF = ANIMATION_MAP[2]!
    const walkB = ANIMATION_MAP[3]!
    for (const f of [0, 77, 1000, 123456]) {
      expect(clipTime(walkF, 2, 0, f)).toBeLessThan(CLIPS[walkF.clip]!.duration)
      expect(clipTime(walkB, 3, 0, f)).toBeLessThanOrEqual(CLIPS[walkB.clip]!.duration)
    }
    expect(clipTime(walkB, 3, 0, 10)).toBeLessThan(clipTime(walkB, 3, 0, 5))
  })
})
