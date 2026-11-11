import { useEffect, useState } from 'react'
import { NET_VECTORS, checkNetVectors, type NetMismatch, type NetResult } from '@duelwise/core/src/netplay/vectors'

type State = { phase: 'running' } | { phase: 'pass' | 'fail'; bad: NetMismatch[]; results: Record<string, NetResult>; ms: number }

/**
 * Dev-only: replays the nine netplay determinism logs (three per realtime game) in this browser and compares every hash with the one pinned
 * in Bun (packages/core/src/netplay/vectors.ts). apps/web/e2e/determinism.spec.ts opens it in Chromium and WebKit.
 */
export default function Determinism() {
  const [state, setState] = useState<State>({ phase: 'running' })
  useEffect(() => {
    const t = setTimeout(() => {
      const t0 = performance.now()
      const { results, bad } = checkNetVectors()
      setState({ phase: bad.length === 0 ? 'pass' : 'fail', bad, results, ms: Math.round(performance.now() - t0) })
    }, 0)
    return () => clearTimeout(t)
  }, [])
  const total = NET_VECTORS.length
  const wrong = state.phase === 'running' ? 0 : new Set(state.bad.map((b) => b.id)).size
  return (
    <section className="grid gap-3 py-6">
      <h1 className="font-display text-display-md">Rollback determinism check</h1>
      <p className="text-muted" data-testid="dt-state" data-state={state.phase}>
        {state.phase === 'running' ? 'Running' : state.phase === 'pass' ? `PASS: ${total} of ${total} hashes identical` : `FAIL: ${wrong} of ${total} differ`}
      </p>
      <pre className="overflow-x-auto rounded-control bg-surface-2 p-3 font-mono text-xs" data-testid="dt-result">
        {state.phase === 'running' ? '' : JSON.stringify({ matched: total - wrong, total, ms: state.ms, engine: navigator.userAgent, hashes: Object.fromEntries(Object.entries(state.results).map(([id, r]) => [id, r.hash])), mismatches: state.bad }, null, 2)}
      </pre>
    </section>
  )
}
