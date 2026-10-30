import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { OrtSession } from './ort-session'

// Kept in its own file: after an ORT wasm session has run on a Bun main thread, creating a Web Worker
// in the same process hangs (observed on Bun 1.4.2). The product never does both on one thread:
// the page only talks to a worker, and the harness runs agents inline in child processes.
const FIX = join(import.meta.dir, '../../fixtures')

describe('OrtSession', () => {
  test('loads the 2x256 MLP and runs a batch under wasm, single thread', async () => {
    const bytes = new Uint8Array(await Bun.file(join(FIX, 'mlp-2x256.onnx')).arrayBuffer())
    const s = await OrtSession.create(bytes)
    const one = await s.run('x', new Float32Array([1, 2, 3, 4]), [1, 4])
    expect(one.logits!.length).toBe(3)
    const two = await s.run('x', new Float32Array([1, 2, 3, 4, 1, 2, 3, 4]), [2, 4])
    expect(Array.from(two.logits!.slice(0, 3))).toEqual(Array.from(one.logits!))
    expect(Array.from(two.logits!.slice(3, 6))).toEqual(Array.from(one.logits!))
    await s.dispose()
  })
})
