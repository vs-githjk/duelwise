import type { GameCore } from '@duelwise/core/src/types'

/** What an evaluator says about one position. `priors` is indexed by encoded action code and needs no
 *  normalising (PUCT masks to the legal actions and renormalises). `value` is in [-1, 1] from the view
 *  of the seat to act in that position. */
export interface Evaluation {
  priors: ArrayLike<number>
  value: number
}

/** Scores positions in batches. Sync or async; PUCT never assumes more than the order of the results. */
export interface Evaluator<S> {
  evaluate(states: readonly S[]): Evaluation[] | Promise<Evaluation[]>
}

/** Uniform priors and value 0: PUCT then behaves like plain tree search guided by terminal results. */
export function uniformEvaluator<S>(actionCount: number): Evaluator<S> {
  return {
    evaluate: (states) => states.map(() => ({ priors: new Float32Array(actionCount).fill(1), value: 0 })),
  }
}

/** Numerically stable softmax over the legal action codes only; every other entry is 0. */
export function maskedSoftmax(logits: ArrayLike<number>, legalCodes: readonly number[], actionCount: number): Float32Array {
  const out = new Float32Array(actionCount)
  if (legalCodes.length === 0) return out
  let max = -Infinity
  for (const c of legalCodes) if (logits[c]! > max) max = logits[c]!
  let sum = 0
  for (const c of legalCodes) {
    const e = Math.exp(logits[c]! - max)
    out[c] = e
    sum += e
  }
  for (const c of legalCodes) out[c] = out[c]! / sum
  return out
}

/** Wraps a function over a flat feature batch (the shape the self-play bridge and the ONNX nets use):
 *  `encode` writes one position's features at an offset, `run` returns policy logits and values for the batch. */
export function batchEvaluator<S, A, O>(opts: {
  core: GameCore<S, A, O>
  seat: (s: S) => 0 | 1
  encode: (s: S, out: Float32Array, offset: number) => void
  featureSize: number
  actionCount: number
  run: (batch: Float32Array, n: number) => { logits: ArrayLike<number>; values: ArrayLike<number> } | Promise<{ logits: ArrayLike<number>; values: ArrayLike<number> }>
}): Evaluator<S> {
  const { core, featureSize, actionCount } = opts
  return {
    async evaluate(states) {
      const n = states.length
      const batch = new Float32Array(n * featureSize)
      for (let i = 0; i < n; i++) opts.encode(states[i]!, batch, i * featureSize)
      const { logits, values } = await opts.run(batch, n)
      return states.map((s, i) => {
        const codes = core.legal(s, opts.seat(s)).map((a) => core.encodeAction(a))
        const row = Array.from({ length: actionCount }, (_, k) => logits[i * actionCount + k]!)
        return { priors: maskedSoftmax(row, codes, actionCount), value: Math.max(-1, Math.min(1, values[i]!)) }
      })
    },
  }
}
