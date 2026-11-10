import { useEffect, useState } from 'react'
import { runVector, type Mismatch, type VectorFile } from '@duelwise/core/src/games/puck/vectors-lib'
import file from '@duelwise/core/src/games/puck/vectors.json'

type State = { phase: 'running'; done: number } | { phase: 'pass' | 'fail'; done: number; bad: Mismatch[]; ms: number }

const vectors = file as unknown as VectorFile

/** Dev-only: replays the 300 committed air hockey matches in this browser and prints pass or fail (open /dev/puck-vectors on a phone). */
export default function PuckVectors() {
  const [state, setState] = useState<State>({ phase: 'running', done: 0 })
  useEffect(() => {
    let dead = false
    const bad: Mismatch[] = []
    const t0 = performance.now()
    let i = 0
    const tick = (): void => {
      if (dead) return
      const end = Math.min(i + 10, vectors.vectors.length)
      for (; i < end; i++) {
        const v = vectors.vectors[i]!
        const got = runVector(v)
        for (const f of ['frames', 'hash', 'trace', 'winner'] as const) {
          if (got[f] !== v.expect[f]) bad.push({ id: v.id, field: f, want: v.expect[f], got: got[f] })
        }
        if (got.score[0] !== v.expect.score[0] || got.score[1] !== v.expect.score[1]) bad.push({ id: v.id, field: 'score', want: v.expect.score, got: got.score })
      }
      if (i < vectors.vectors.length) {
        setState({ phase: 'running', done: i })
        setTimeout(tick, 0)
      } else {
        setState({ phase: bad.length === 0 ? 'pass' : 'fail', done: i, bad, ms: Math.round(performance.now() - t0) })
      }
    }
    setTimeout(tick, 0)
    return () => { dead = true }
  }, [])
  const total = vectors.vectors.length
  const wrong = state.phase === 'running' ? 0 : new Set(state.bad.map((b) => b.id)).size
  return (
    <section className="grid gap-3 py-6">
      <h1 className="font-display text-display-md">Air hockey determinism check</h1>
      <p className="text-muted" data-testid="pv-state" data-state={state.phase}>
        {state.phase === 'running' ? `Running ${state.done} of ${total}` : state.phase === 'pass' ? `PASS: ${total} of ${total} matches identical` : `FAIL: ${wrong} of ${total} matches differ`}
      </p>
      <pre className="overflow-x-auto rounded-control bg-surface-2 p-3 font-mono text-xs" data-testid="pv-result">
        {state.phase === 'running' ? '' : JSON.stringify({ matched: total - wrong, total, ms: state.ms, engine: navigator.userAgent, mismatches: state.bad.slice(0, 10) }, null, 2)}
      </pre>
    </section>
  )
}
