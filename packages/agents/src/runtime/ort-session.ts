import * as ort from 'onnxruntime-web/wasm'

export interface OrtSessionOpts {
  /** Where the browser finds the ORT wasm files (the web app passes its `?url` imports). Unset under Bun and Node. */
  wasmPaths?: string | { mjs?: string; wasm?: string }
}

let configured = false
function configure(opts: OrtSessionOpts): void {
  // One thread: the site sends no COOP/COEP headers, so SharedArrayBuffer is not available in the browser.
  if (!configured) {
    ort.env.wasm.numThreads = 1
    configured = true
  }
  if (opts.wasmPaths !== undefined) ort.env.wasm.wasmPaths = opts.wasmPaths
}

/**
 * Thin wrapper over an onnxruntime-web wasm session. The same code runs in the browser worker and under
 * Bun or Node in the measurement harness, so published numbers measure the shipped path.
 */
export class OrtSession {
  private constructor(private readonly session: ort.InferenceSession) {}

  static async create(model: Uint8Array, opts: OrtSessionOpts = {}): Promise<OrtSession> {
    configure(opts)
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
    return new OrtSession(session)
  }

  get inputNames(): readonly string[] {
    return this.session.inputNames
  }

  /** The width of the first input (its last dimension), or null when the model does not say. */
  get inputWidth(): number | null {
    const m = this.session.inputMetadata?.[0]
    const w = m && m.isTensor ? m.shape[m.shape.length - 1] : undefined
    return typeof w === 'number' ? w : null
  }

  get outputNames(): readonly string[] {
    return this.session.outputNames
  }

  /** Runs one float32 input; returns every output as a Float32Array copy keyed by output name. */
  async run(inputName: string, data: Float32Array, dims: readonly number[]): Promise<Record<string, Float32Array>> {
    const out = await this.session.run({ [inputName]: new ort.Tensor('float32', data, dims as number[]) })
    const result: Record<string, Float32Array> = {}
    for (const name of this.session.outputNames) result[name] = Float32Array.from(out[name]!.data as Float32Array)
    return result
  }

  async dispose(): Promise<void> {
    await this.session.release()
  }
}
