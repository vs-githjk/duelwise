// TypeScript evaluator for the chess value net (value.bin, format in training/trainer/chess/export.py):
// 768 sparse piece-square features -> 256 -> 32 -> 1, clipped ReLU (clamp 0..1) after both hidden layers.
// It computes the same function as value.onnx, which value-eval.test.ts checks to 1e-4 on 1,000 positions.
// Plain Float32 loops: a leaf costs about 32 row additions of 256 floats, far cheaper than an ORT call.

import { BLACK, Board, WHITE, pieceColor } from './board'

const MAGIC = 'CHV1'

export class ValueNet {
  readonly nIn: number
  readonly h1: number
  readonly h2: number
  private readonly w1: Float32Array
  private readonly b1: Float32Array
  private readonly w2: Float32Array
  private readonly b2: Float32Array
  private readonly w3: Float32Array
  private readonly b3: number
  private readonly a1: Float32Array
  private readonly active = new Uint16Array(64)

  constructor(bytes: Uint8Array) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
    if (magic !== MAGIC) throw new Error('value net: bad magic ' + JSON.stringify(magic))
    this.nIn = dv.getUint32(4, true)
    this.h1 = dv.getUint32(8, true)
    this.h2 = dv.getUint32(12, true)
    const nOut = dv.getUint32(16, true)
    if (nOut !== 1) throw new Error('value net: expected one output, got ' + nOut)
    const total = 20 + 4 * (this.nIn * this.h1 + this.h1 + this.h2 * this.h1 + this.h2 + nOut * this.h2 + nOut)
    if (bytes.byteLength !== total) throw new Error(`value net: ${bytes.byteLength} bytes, expected ${total}`)
    // Copy so the arrays are aligned whatever the offset of `bytes` in its buffer.
    const floats = new Float32Array(bytes.slice(20).buffer)
    let at = 0
    const take = (n: number): Float32Array => floats.subarray(at, (at += n))
    this.w1 = take(this.nIn * this.h1)
    this.b1 = take(this.h1)
    this.w2 = take(this.h2 * this.h1)
    this.b2 = take(this.h2)
    this.w3 = take(this.h2)
    this.b3 = take(1)[0]!
    this.a1 = new Float32Array(this.h1)
  }

  /** Pre-sigmoid output for the first `n` entries of `active` (feature indices), from the mover's side. */
  logit(active: ArrayLike<number>, n: number): number {
    const { h1, h2, w1, w2, w3, a1 } = this
    a1.set(this.b1)
    for (let i = 0; i < n; i++) {
      const row = active[i]! * h1
      for (let j = 0; j < h1; j++) a1[j]! += w1[row + j]!
    }
    for (let j = 0; j < h1; j++) a1[j] = a1[j]! < 0 ? 0 : a1[j]! > 1 ? 1 : a1[j]!
    let z = this.b3
    for (let k = 0; k < h2; k++) {
      let s = this.b2[k]!
      const row = k * h1
      for (let j = 0; j < h1; j++) s += w2[row + j]! * a1[j]!
      s = s < 0 ? 0 : s > 1 ? 1 : s
      z += w3[k]! * s
    }
    return z
  }

  /** Expected score of the side to move, 0..1. */
  score(active: ArrayLike<number>, n: number): number {
    return 1 / (1 + Math.exp(-this.logit(active, n)))
  }

  /** Active feature indices of a board, from the side to move's view; same features as core sparse.ts. */
  features(b: Board): number {
    const white = b.side === WHITE
    let n = 0
    for (let s = 0; s < 64; s++) {
      const c = b.sq[s]!
      if (c === 0) continue
      if (white) this.active[n++] = (c - 1) * 64 + s
      else {
        // The board is flipped and the colours swap, so the mover's pieces are always "own".
        const rel = pieceColor(c) === BLACK ? c - 6 : c + 6
        this.active[n++] = (rel - 1) * 64 + (s ^ 56)
      }
    }
    return n
  }

  /** Pre-sigmoid value of the position for the side to move. */
  evaluate(b: Board): number {
    return this.logit(this.active, this.features(b))
  }
}
