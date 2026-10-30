/// <reference lib="webworker" />
// Browser latency benchmark, run inside a dedicated worker like the shipped agents. Dev only.
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import modelUrl from '@duelwise/agents/fixtures/mlp-2x256.onnx?url'
import { OrtSession } from '@duelwise/agents/src/runtime/ort-session'
import { createCounterGame, type CounterState } from '@duelwise/core/src/testing/counter-game'

export interface Stats {
  calls: number
  meanMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
}

export interface BenchResult {
  userAgent: string
  hardwareConcurrency: number
  mlp: Stats & { budgetP95Ms: number; withinBudget: boolean }
  ortOverhead: { batch1MeanMs: number; batch64MeanMs: number; estimatedFixedMsPerCall: number }
  mcts: { standIn: string; sims: number; evalCalls: number; elapsedMs: number; budgetMs: number; withinBudget: boolean }
  mctsAnytime: { capMs: number; simsCompleted: number; evalCalls: number; elapsedMs: number }
}

const now = () => performance.now()

function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b)
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!
  return { calls: s.length, meanMs: samples.reduce((a, b) => a + b, 0) / samples.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: s[s.length - 1]! }
}

const features = (st: CounterState): Float32Array => new Float32Array([st.total / 20, st.target / 20, (st.target - st.total) / 20, 1])

interface Node {
  state: CounterState
  action: number
  prior: number
  n: number
  w: number
  children: Node[] | null
}

/**
 * Stand-in for the preview PUCT search: the same call pattern the four agent will have (one batch-1
 * ORT call per simulated leaf plus tree bookkeeping), on the counter game because the real four core
 * belongs to another lane. T23 re-measures with the shipped search.
 */
async function puct(session: OrtSession, sims: number, capMs: number | null): Promise<{ done: number; evalCalls: number; elapsedMs: number }> {
  const core = createCounterGame('four')
  const root: Node = { state: core.init(3), action: 0, prior: 1, n: 0, w: 0, children: null }
  const t0 = now()
  let evalCalls = 0
  let done = 0
  const evaluate = async (st: CounterState) => {
    evalCalls++
    const { logits } = await session.run('x', features(st), [1, 4])
    const l = Array.from(logits!)
    const m = Math.max(...l)
    const e = l.map((v) => Math.exp(v - m))
    const z = e.reduce((a, b) => a + b, 0)
    return { priors: e.map((v) => v / z), value: Math.tanh(l[0]! - l[1]!) }
  }
  for (let i = 0; i < sims; i++) {
    if (capMs !== null && now() - t0 >= capMs) break
    const path: Node[] = [root]
    let node = root
    while (node.children && node.children.length > 0) {
      const sqrtN = Math.sqrt(node.n + 1)
      let best = node.children[0]!
      let bestScore = -Infinity
      for (const c of node.children) {
        const q = c.n === 0 ? 0 : -c.w / c.n
        const score = q + 1.5 * c.prior * (sqrtN / (1 + c.n))
        if (score > bestScore) {
          bestScore = score
          best = c
        }
      }
      node = best
      path.push(node)
    }
    const { priors, value } = await evaluate(node.state)
    let leafValue = value
    if (core.terminal(node.state)) {
      // The player who just moved won; value is from the point of view of the player to move there.
      leafValue = -1
    } else if (!node.children) {
      const seat = core.toAct(node.state)[0]!
      node.children = core.legal(node.state, seat).map((a) => ({
        state: core.step(node.state, seat === 0 ? [a, null] : [null, a]),
        action: a,
        prior: priors[a - 1]!,
        n: 0,
        w: 0,
        children: null,
      }))
    }
    let v = leafValue
    for (let k = path.length - 1; k >= 0; k--) {
      path[k]!.n++
      path[k]!.w += v
      v = -v
    }
    done++
  }
  return { done, evalCalls, elapsedMs: now() - t0 }
}

async function run(): Promise<BenchResult> {
  const bytes = new Uint8Array(await (await fetch(modelUrl)).arrayBuffer())
  const session = await OrtSession.create(bytes, { wasmPaths: { wasm: wasmUrl } })
  const x1 = new Float32Array([0.1, 0.5, 0.4, 1])

  for (let i = 0; i < 100; i++) await session.run('x', x1, [1, 4])
  const samples: number[] = []
  for (let i = 0; i < 1000; i++) {
    const t = now()
    await session.run('x', x1, [1, 4])
    samples.push(now() - t)
  }
  const mlp = stats(samples)

  const x64 = new Float32Array(64 * 4)
  for (let i = 0; i < 64; i++) x64.set(x1, i * 4)
  const time = async (x: Float32Array, rows: number, reps: number) => {
    const t = now()
    for (let i = 0; i < reps; i++) await session.run('x', x, [rows, 4])
    return (now() - t) / reps
  }
  const batch1 = await time(x1, 1, 300)
  const batch64 = await time(x64, 64, 300)
  // t(b) = fixed + b * perRow, so the fixed per-call cost is t(1) minus one row's share.
  const perRow = Math.max(0, (batch64 - batch1) / 63)
  const fixed = Math.max(0, batch1 - perRow)

  const full = await puct(session, 800, null)
  const anytime = await puct(session, 1_000_000, 1500)
  await session.dispose()

  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    mlp: { ...mlp, budgetP95Ms: 4, withinBudget: mlp.p95Ms <= 4 },
    ortOverhead: { batch1MeanMs: batch1, batch64MeanMs: batch64, estimatedFixedMsPerCall: fixed },
    mcts: {
      standIn: 'PUCT over the counter game, 4 -> 256 -> 256 -> 3 MLP, one batch-1 ORT call per simulation',
      sims: full.done,
      evalCalls: full.evalCalls,
      elapsedMs: full.elapsedMs,
      budgetMs: 1500,
      withinBudget: full.elapsedMs <= 1500,
    },
    mctsAnytime: { capMs: 1500, simsCompleted: anytime.done, evalCalls: anytime.evalCalls, elapsedMs: anytime.elapsedMs },
  }
}

self.onmessage = () => {
  run().then(
    (result) => self.postMessage({ ok: true, result }),
    (e) => self.postMessage({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) }),
  )
}
