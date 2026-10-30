import type { FeatureEncoder, GameCore } from '@duelwise/core/src/types'
import { OrtSession, type OrtSessionOpts } from '../runtime/ort-session'
import { maskedSoftmax, type Evaluation, type Evaluator } from './evaluator'

export interface OnnxEvaluatorOpts<S, A, O> extends OrtSessionOpts {
  core: GameCore<S, A, O>
  /** Features of the observation of the seat to act (shape `[planes, rows, cols]`). */
  encoder: FeatureEncoder<O>
  actionCount: number
  model: Uint8Array
}

/**
 * PUCT evaluator backed by an ONNX policy and value net run with onnxruntime-web (wasm, one thread). The net takes a
 * float32 batch `input (N, ...shape)` and returns policy logits `(N, actionCount)` then values `(N,)`, from the view of
 * the seat to act (the trainer's export, training/trainer/export_onnx.py). One class serves the browser worker and the
 * Bun or Node measurement harness, so published numbers measure the shipped path.
 */
export class OnnxEvaluator<S, A, O> implements Evaluator<S> {
  private readonly featureSize: number

  private constructor(
    private readonly opts: OnnxEvaluatorOpts<S, A, O>,
    private readonly session: OrtSession,
  ) {
    this.featureSize = opts.encoder.shape.reduce((a, b) => a * b, 1)
  }

  static async create<S, A, O>(opts: OnnxEvaluatorOpts<S, A, O>): Promise<OnnxEvaluator<S, A, O>> {
    return new OnnxEvaluator(opts, await OrtSession.create(opts.model, { wasmPaths: opts.wasmPaths }))
  }

  /** Raw net outputs for a batch of positions: logits `(n * actionCount)` row-major and values `(n)`. */
  async raw(states: readonly S[]): Promise<{ logits: Float32Array; values: Float32Array }> {
    const { core, encoder, actionCount } = this.opts
    const n = states.length
    const batch = new Float32Array(n * this.featureSize)
    for (let i = 0; i < n; i++) {
      const s = states[i]!
      encoder.encode(core.observe(s, core.toAct(s)[0]!), batch, i * this.featureSize)
    }
    const out = await this.session.run('input', batch, [n, ...encoder.shape])
    const [logitsName, valuesName] = this.session.outputNames
    const logits = out[logitsName!]!
    const values = out[valuesName!]!
    if (logits.length !== n * actionCount || values.length !== n) throw new Error(`onnx evaluator: unexpected output sizes ${logits.length} and ${values.length} for ${n} positions`)
    return { logits, values }
  }

  async evaluate(states: readonly S[]): Promise<Evaluation[]> {
    const { core, actionCount } = this.opts
    const { logits, values } = await this.raw(states)
    return states.map((s, i) => {
      const seat = core.toAct(s)[0]!
      const codes = core.legal(s, seat).map((a) => core.encodeAction(a))
      const row = logits.subarray(i * actionCount, (i + 1) * actionCount)
      return { priors: maskedSoftmax(row, codes, actionCount), value: Math.max(-1, Math.min(1, values[i]!)) }
    })
  }

  dispose(): Promise<void> {
    return this.session.dispose()
  }
}

export const createOnnxEvaluator = OnnxEvaluator.create
