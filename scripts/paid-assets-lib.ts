import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where the paid files sit under the web public folder (gitignored); the dev server serves them at /paid/<path>. */
export const PAID_LOCAL_DIR = 'apps/web/public/paid'

/** Paid files: their path under the paid base (and under PAID_LOCAL_DIR) and the file in the purchased-pack cache they are copied from. */
export const PAID_FILES: Array<{ path: string; source: string }> = [
  {
    path: 'arena/quaternius/universal-animation-library/ual1-shooter.glb',
    // The pruned 24 clip file cut from UAL1.glb (UAL1 Pro tier), kept next to the full packs.
    source: 'pruned/ual1-shooter.glb',
  },
]

/** Animation names in a glTF binary (the JSON chunk). */
export function glbClipNames(file: string): string[] {
  const b = readFileSync(file)
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`not a glb: ${file}`)
  const n = b.readUInt32LE(12)
  const json = JSON.parse(b.subarray(20, 20 + n).toString('utf8')) as { animations?: Array<{ name?: string }> }
  return (json.animations ?? []).map((a) => a.name ?? '')
}

export function freeClips(root: string): Set<string> {
  const j = JSON.parse(readFileSync(join(root, 'docs/third-party/quaternius-free-clips.json'), 'utf8')) as { ual1: string[]; ual2: string[] }
  return new Set([...j.ual1, ...j.ual2])
}

/** Clips in `file` that are not in the free set: the proof that a file is paid. */
export function paidClipsIn(file: string, free: Set<string>): string[] {
  return glbClipNames(file).filter((n) => !free.has(n))
}
