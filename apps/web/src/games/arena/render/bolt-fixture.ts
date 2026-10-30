import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Test helper: the Poly Haven bolt action rifle (Ridgeline) as one self-contained GLB with no image textures, so bun can parse it
// (the game loads the .gltf with its textures through GLTFLoader.loadAsync).
const DIR = join(import.meta.dir, '..', '..', '..', '..', 'public', 'assets', 'arena', 'polyhaven', 'bolt_action_rifle_7_62')

export function boltGlb(): ArrayBuffer {
  const json = JSON.parse(readFileSync(join(DIR, 'bolt_action_rifle_7_62_1k.gltf'), 'utf8')) as {
    buffers: Array<{ uri?: string; byteLength: number }>
    textures?: unknown
    images?: unknown
    materials: Array<Record<string, unknown>>
  }
  const bin = readFileSync(join(DIR, 'bolt_action_rifle_7_62.bin'))
  delete (json.buffers[0] as { uri?: string }).uri
  delete json.textures
  delete json.images
  for (const m of json.materials) {
    delete m.normalTexture
    const pbr = m.pbrMetallicRoughness as Record<string, unknown> | undefined
    if (pbr) {
      delete pbr.baseColorTexture
      delete pbr.metallicRoughnessTexture
    }
  }
  const pad = (n: number): number => (4 - (n % 4)) % 4
  const jsonBytes = Buffer.from(JSON.stringify(json) + ' '.repeat(pad(JSON.stringify(json).length)))
  const binBytes = Buffer.concat([bin, Buffer.alloc(pad(bin.length))])
  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length
  const out = Buffer.alloc(total)
  out.writeUInt32LE(0x46546c67, 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(jsonBytes.length, 12)
  out.writeUInt32LE(0x4e4f534a, 16)
  jsonBytes.copy(out, 20)
  const b0 = 20 + jsonBytes.length
  out.writeUInt32LE(binBytes.length, b0)
  out.writeUInt32LE(0x004e4942, b0 + 4)
  binBytes.copy(out, b0 + 8)
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
}
