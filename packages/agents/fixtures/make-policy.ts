// Builds the ONNX bytes of a league policy (the trainer's Agent: a tanh trunk of two layers, then one logits head per
// action dimension and a value head) straight from its weights, as hand-encoded protobuf. Used for the puck
// preview model and parity fixture when the `onnx` Python package is not installed (torch.onnx.export needs it), so
// no torch or onnx package is needed on the TypeScript side. The graph is the same maths as trainer/ppo/export.py's
// PolicyGraph: out0..outN are the head logits, then the value. Parity with torch is a test, not a promise.

export interface PolicyWeights {
  obs: number
  hidden: number
  nvec: number[]
  /** Row-major [in][out] (already transposed from torch's [out][in]). */
  trunk0: { w: Float32Array; b: Float32Array }
  trunk1: { w: Float32Array; b: Float32Array }
  actor: { w: Float32Array; b: Float32Array }
  critic: { w: Float32Array; b: Float32Array }
}

function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
  return out
}
const tag = (field: number, wire: number) => varint(field * 8 + wire)
const lenField = (field: number, bytes: number[] | Uint8Array) => [...tag(field, 2), ...varint(bytes.length), ...bytes]
const strField = (field: number, s: string) => lenField(field, [...new TextEncoder().encode(s)])
const intField = (field: number, n: number) => [...tag(field, 0), ...varint(n)]

function tensor(name: string, dims: number[], data: Float32Array): number[] {
  const raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return [...dims.flatMap((d) => intField(1, d)), ...intField(2, 1), ...strField(8, name), ...lenField(9, raw)]
}
function node(op: string, inputs: string[], output: string): number[] {
  return [...inputs.flatMap((i) => strField(1, i)), ...strField(2, output), ...strField(3, output), ...strField(4, op)]
}
function valueInfo(name: string, dims: (number | string)[]): number[] {
  const shape = dims.flatMap((d) => lenField(1, typeof d === 'number' ? intField(1, d) : strField(2, d)))
  const tensorType = [...intField(1, 1), ...lenField(2, shape)]
  return [...strField(1, name), ...lenField(2, lenField(1, tensorType))]
}

/** Columns [from, to) of a row-major [rows][cols] matrix as its own row-major matrix. */
function cols(w: Float32Array, rows: number, total: number, from: number, to: number): Float32Array {
  const out = new Float32Array(rows * (to - from))
  for (let r = 0; r < rows; r++) for (let c = from; c < to; c++) out[r * (to - from) + (c - from)] = w[r * total + c]!
  return out
}

export function buildPolicyOnnx(p: PolicyWeights): Uint8Array {
  const total = p.nvec.reduce((a, b) => a + b, 0)
  const inits: number[][] = [
    tensor('w0', [p.obs, p.hidden], p.trunk0.w), tensor('b0', [p.hidden], p.trunk0.b),
    tensor('w1', [p.hidden, p.hidden], p.trunk1.w), tensor('b1', [p.hidden], p.trunk1.b),
    tensor('wv', [p.hidden, 1], p.critic.w), tensor('bv', [1], p.critic.b),
  ]
  const nodes: number[][] = [
    node('MatMul', ['input', 'w0'], 'm0'), node('Add', ['m0', 'b0'], 'a0'), node('Tanh', ['a0'], 'h0'),
    node('MatMul', ['h0', 'w1'], 'm1'), node('Add', ['m1', 'b1'], 'a1'), node('Tanh', ['a1'], 'h1'),
  ]
  const outputs: number[][] = []
  let from = 0
  p.nvec.forEach((n, i) => {
    inits.push(tensor(`wa${i}`, [p.hidden, n], cols(p.actor.w, p.hidden, total, from, from + n)), tensor(`ba${i}`, [n], p.actor.b.slice(from, from + n)))
    nodes.push(node('MatMul', ['h1', `wa${i}`], `ma${i}`), node('Add', [`ma${i}`, `ba${i}`], `out${i}`))
    outputs.push(valueInfo(`out${i}`, ['batch', n]))
    from += n
  })
  nodes.push(node('MatMul', ['h1', 'wv'], 'mv'), node('Add', ['mv', 'bv'], `out${p.nvec.length}`))
  outputs.push(valueInfo(`out${p.nvec.length}`, ['batch', 1]))
  const graph = [
    ...nodes.flatMap((n) => lenField(1, n)),
    ...strField(2, 'policy'),
    ...inits.flatMap((t) => lenField(5, t)),
    ...lenField(11, valueInfo('input', ['batch', p.obs])),
    ...outputs.flatMap((o) => lenField(12, o)),
  ]
  const model = [...intField(1, 8), ...strField(2, 'duelwise-fixture'), ...lenField(7, graph), ...lenField(8, intField(2, 17))]
  return Uint8Array.from(model)
}

/** Reads the JSON that puck-dump-weights.py writes (base64 float32 tensors, torch layout [out][in]) and transposes to [in][out]. */
export function weightsFromJson(j: { obs: number; hidden: number; nvec: number[]; tensors: Record<string, { shape: number[]; data: string }> }): PolicyWeights {
  const get = (name: string): { shape: number[]; data: Float32Array } => {
    const t = j.tensors[name]
    if (!t) throw new Error(`weights json has no ${name}`)
    const bytes = Uint8Array.from(Buffer.from(t.data, 'base64'))
    return { shape: t.shape, data: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4) }
  }
  const layer = (prefix: string) => {
    const w = get(`${prefix}.weight`)
    const b = get(`${prefix}.bias`)
    const [out, inn] = w.shape as [number, number]
    const wt = new Float32Array(inn * out)
    for (let o = 0; o < out; o++) for (let i = 0; i < inn; i++) wt[i * out + o] = w.data[o * inn + i]!
    return { w: wt, b: b.data }
  }
  return { obs: j.obs, hidden: j.hidden, nvec: j.nvec, trunk0: layer('trunk.0'), trunk1: layer('trunk.2'), actor: layer('actor'), critic: layer('critic') }
}
