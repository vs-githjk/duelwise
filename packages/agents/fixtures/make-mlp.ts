// Writes fixtures/mlp-2x256.onnx: a 4 -> 256 -> 256 -> 3 ReLU MLP with seeded weights.
// Hand-encoded ONNX protobuf, so no torch or onnx package is needed. Run:
//   bun packages/agents/fixtures/make-mlp.ts
import { makeRng } from '@duelwise/core/src/rng'

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

export function buildMlp(seed = 1): Uint8Array {
  const rng = makeRng(seed)
  const dims = [4, 256, 256, 3]
  const inits: number[][] = []
  const nodes: number[][] = []
  let prev = 'x'
  for (let l = 0; l < dims.length - 1; l++) {
    const [i, o] = [dims[l]!, dims[l + 1]!]
    const w = new Float32Array(i * o)
    const scale = Math.sqrt(2 / i)
    for (let k = 0; k < w.length; k++) w[k] = Math.fround((rng.float() * 2 - 1) * scale)
    const b = new Float32Array(o)
    inits.push(tensor(`w${l}`, [i, o], w), tensor(`b${l}`, [o], b))
    nodes.push(node('MatMul', [prev, `w${l}`], `m${l}`), node('Add', [`m${l}`, `b${l}`], `a${l}`))
    prev = `a${l}`
    if (l < dims.length - 2) {
      nodes.push(node('Relu', [prev], `r${l}`))
      prev = `r${l}`
    }
  }
  nodes.push(node('Identity', [prev], 'logits'))
  const graph = [
    ...nodes.flatMap((n) => lenField(1, n)),
    ...strField(2, 'mlp'),
    ...inits.flatMap((t) => lenField(5, t)),
    ...lenField(11, valueInfo('x', ['batch', 4])),
    ...lenField(12, valueInfo('logits', ['batch', 3])),
  ]
  const model = [...intField(1, 8), ...strField(2, 'duelwise-fixture'), ...lenField(7, graph), ...lenField(8, intField(2, 17))]
  return Uint8Array.from(model)
}

if (import.meta.main) {
  const out = new URL('./mlp-2x256.onnx', import.meta.url).pathname
  await Bun.write(out, buildMlp())
  console.log('wrote', out)
}
