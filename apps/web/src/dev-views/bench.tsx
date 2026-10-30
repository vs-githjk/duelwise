import { useEffect, useState } from 'react'
import type { BenchResult } from './bench-worker'

type State = { phase: 'running' } | { phase: 'done'; result: BenchResult } | { phase: 'error'; error: string }

/** Dev-only: runs the browser latency benchmark in a worker and prints the JSON for bench.spec.ts. */
export default function Bench() {
  const [state, setState] = useState<State>({ phase: 'running' })
  useEffect(() => {
    const worker = new Worker(new URL('./bench-worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (ev: MessageEvent<{ ok: true; result: BenchResult } | { ok: false; error: string }>) => {
      setState(ev.data.ok ? { phase: 'done', result: ev.data.result } : { phase: 'error', error: ev.data.error })
      worker.terminate()
    }
    worker.onerror = (ev) => setState({ phase: 'error', error: ev.message || 'worker failed' })
    worker.postMessage('run')
    return () => worker.terminate()
  }, [])
  return (
    <section className="grid gap-3 py-6">
      <h1 className="font-display text-display-md">Browser latency benchmark</h1>
      <p className="text-muted" data-testid="bench-state" data-state={state.phase}>
        {state.phase === 'running' ? 'Running' : state.phase === 'done' ? 'Done' : 'Failed'}
      </p>
      <pre className="overflow-x-auto rounded-control bg-surface-2 p-3 font-mono text-xs" data-testid="bench-result">
        {state.phase === 'done' ? JSON.stringify(state.result, null, 2) : state.phase === 'error' ? state.error : ''}
      </pre>
    </section>
  )
}
