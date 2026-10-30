import type { Rng } from '../../types'
import { makeRng } from '../../rng'

// External-sampling MCCFR (Lanctot et al. 2009) over a small interface, shared by Kuhn, Leduc and
// the abstracted hold'em tree. Chance is sampled once at the root (the whole deal), so a game
// object hides undealt cards behind its infoset keys.

export interface CfrGame<S> {
  /** Width of the per-infoset arrays: every action id is below this. */
  readonly width: number
  /** Samples a chance outcome and returns the root state. */
  sampleRoot(rng: Rng): S
  isTerminal(s: S): boolean
  /** Payoff to `player` at a terminal state (zero-sum). */
  utility(s: S, player: 0 | 1): number
  actor(s: S): 0 | 1
  /** Available action ids, ascending. */
  actions(s: S): number[]
  child(s: S, action: number): S
  /** Infoset key of the acting player. */
  key(s: S): string
}

export interface CfrNode {
  regret: Float64Array
  sum: Float64Array
  /** Bit i set when action id i has been available at this key. */
  mask: number
}

export interface MccfrOptions {
  /** Clamp negative regrets to zero after each update (regret matching plus). */
  plus?: boolean
  /** Weight the average strategy by the iteration number (linear averaging). */
  linear?: boolean
}

export class Mccfr<S> {
  readonly nodes = new Map<string, CfrNode>()
  iteration = 0
  private readonly plus: boolean
  private readonly linear: boolean

  constructor(readonly game: CfrGame<S>, opts: MccfrOptions = {}) {
    this.plus = opts.plus ?? false
    this.linear = opts.linear ?? false
  }

  private node(key: string, acts: number[]): CfrNode {
    let n = this.nodes.get(key)
    if (!n) {
      n = { regret: new Float64Array(this.game.width), sum: new Float64Array(this.game.width), mask: 0 }
      this.nodes.set(key, n)
    }
    for (const a of acts) n.mask |= 1 << a
    return n
  }

  /** Regret matching over the available actions; fills `out` (width entries). */
  private strategy(n: CfrNode, acts: number[], out: Float64Array): void {
    out.fill(0)
    let pos = 0
    for (const a of acts) {
      const r = n.regret[a]!
      if (r > 0) pos += r
    }
    if (pos > 0) {
      for (const a of acts) {
        const r = n.regret[a]!
        out[a] = r > 0 ? r / pos : 0
      }
    } else {
      const u = 1 / acts.length
      for (const a of acts) out[a] = u
    }
  }

  /** One iteration for each player (alternating traversals). */
  iterate(rng: Rng): void {
    this.iteration++
    for (const p of [0, 1] as const) this.traverse(this.game.sampleRoot(rng), p, rng)
  }

  private traverse(s: S, p: 0 | 1, rng: Rng): number {
    const g = this.game
    if (g.isTerminal(s)) return g.utility(s, p)
    const acts = g.actions(s)
    const node = this.node(g.key(s), acts)
    const sigma = new Float64Array(g.width)
    this.strategy(node, acts, sigma)
    if (g.actor(s) === p) {
      const vals = new Float64Array(g.width)
      let v = 0
      for (const a of acts) {
        vals[a] = this.traverse(g.child(s, a), p, rng)
        v += sigma[a]! * vals[a]!
      }
      for (const a of acts) {
        const r = node.regret[a]! + vals[a]! - v
        node.regret[a] = this.plus && r < 0 ? 0 : r
      }
      return v
    }
    const w = this.linear ? this.iteration : 1
    for (const a of acts) node.sum[a]! += w * sigma[a]!
    let x = rng.float()
    let pick = acts[acts.length - 1]!
    for (const a of acts) {
      x -= sigma[a]!
      if (x < 0) {
        pick = a
        break
      }
    }
    return this.traverse(g.child(s, pick), p, rng)
  }

  /** Average strategy at a key over the actions in `mask` (uniform when never updated). */
  averageStrategy(key: string): Float64Array | null {
    const n = this.nodes.get(key)
    if (!n) return null
    return normalised(n.sum, n.mask, this.game.width)
  }

  run(iterations: number, seed: number): void {
    for (let i = 0; i < iterations; i++) this.iterate(makeRng(iterationSeed(seed, this.iteration + 1)))
  }
}

export function normalised(sum: Float64Array, mask: number, width: number): Float64Array {
  const out = new Float64Array(width)
  let t = 0
  let k = 0
  for (let a = 0; a < width; a++) {
    if (mask & (1 << a)) {
      t += sum[a]!
      k++
    }
  }
  for (let a = 0; a < width; a++) {
    if (mask & (1 << a)) out[a] = t > 0 ? sum[a]! / t : 1 / k
  }
  return out
}

/** Independent stream per iteration, so a resumed run continues exactly. */
export function iterationSeed(seed: number, iteration: number): number {
  return (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(iteration | 0, 0x85ebca6b)) | 0
}

// Checkpoint format: "DWCK", u32 version 1, u32 iteration, u32 node count, then per node
// u16 key length, key utf8, u8 mask, f64 regret x width, f64 sum x width. The width and the game
// identity live in the caller's own metadata.

export function serializeSolver<S>(m: Mccfr<S>): Uint8Array {
  const enc = new TextEncoder()
  const width = m.game.width
  const keys: Uint8Array[] = []
  let size = 16
  for (const k of m.nodes.keys()) {
    const b = enc.encode(k)
    keys.push(b)
    size += 2 + b.length + 1 + 16 * width
  }
  const out = new Uint8Array(size)
  const dv = new DataView(out.buffer)
  out.set(enc.encode('DWCK'), 0)
  dv.setUint32(4, 1, true)
  dv.setUint32(8, m.iteration, true)
  dv.setUint32(12, m.nodes.size, true)
  let off = 16
  let i = 0
  for (const n of m.nodes.values()) {
    const kb = keys[i++]!
    dv.setUint16(off, kb.length, true)
    off += 2
    out.set(kb, off)
    off += kb.length
    dv.setUint8(off, n.mask)
    off += 1
    for (let a = 0; a < width; a++, off += 8) dv.setFloat64(off, n.regret[a]!, true)
    for (let a = 0; a < width; a++, off += 8) dv.setFloat64(off, n.sum[a]!, true)
  }
  return out
}

export function restoreSolver<S>(m: Mccfr<S>, bytes: Uint8Array): void {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const dec = new TextDecoder()
  if (dec.decode(bytes.subarray(0, 4)) !== 'DWCK' || dv.getUint32(4, true) !== 1) throw new Error('mccfr: bad checkpoint')
  const width = m.game.width
  m.nodes.clear()
  m.iteration = dv.getUint32(8, true)
  const count = dv.getUint32(12, true)
  let off = 16
  for (let i = 0; i < count; i++) {
    const kl = dv.getUint16(off, true)
    off += 2
    const key = dec.decode(bytes.subarray(off, off + kl))
    off += kl
    const mask = dv.getUint8(off)
    off += 1
    const regret = new Float64Array(width)
    const sum = new Float64Array(width)
    for (let a = 0; a < width; a++, off += 8) regret[a] = dv.getFloat64(off, true)
    for (let a = 0; a < width; a++, off += 8) sum[a] = dv.getFloat64(off, true)
    m.nodes.set(key, { regret, sum, mask })
  }
  if (off !== bytes.length) throw new Error('mccfr: checkpoint has trailing bytes')
}
