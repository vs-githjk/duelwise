import { bestMove } from '@duelwise/agents/src/chess/alphabeta'
import { loadModelBytes, MODEL_BASE } from '@duelwise/agents/src/chess/model-files'
import { ValueNet } from '@duelwise/agents/src/chess/value-eval'
import { MATERIAL, type ChessEvaluator } from '../report/chess'

export interface EvalSource {
  /** Where the site is served from. The value net is fetched from its own static asset under this origin. */
  origin?: string
  /** Replaces the global fetch (tests). */
  fetch?: typeof fetch
  /** Read the model from the repo's public folder when the fetch is not possible or fails (dev and tests). Default true. */
  fsFallback?: boolean
}

let cached: Promise<ChessEvaluator> | null = null

/** Clears the remembered evaluator (tests only). */
export function resetChessEvaluator(): void {
  cached = null
}

async function modelBytes(src: EvalSource): Promise<Uint8Array> {
  if (src.origin) {
    try {
      const res = await (src.fetch ?? fetch)(`${src.origin.replace(/\/$/, '')}${MODEL_BASE}/value.bin`)
      if (res.ok) return new Uint8Array(await res.arrayBuffer())
    } catch {
      // Fall through to the file read below.
    }
  }
  if (src.fsFallback === false) throw new Error('chess value net: not reachable')
  // Dev and test only: in a production build this path does not exist, which is why the origin fetch comes first.
  return loadModelBytes('value.bin')
}

/**
 * The AI's own chess value net as the report evaluator, two plies deep. Falls back to a material count when the
 * model cannot be loaded; that fallback is not remembered, so the next report tries the net again.
 */
export function loadChessEvaluator(src: EvalSource = {}): Promise<ChessEvaluator> {
  if (cached) return cached
  const p = (async (): Promise<ChessEvaluator> => {
    try {
      const net = new ValueNet(await modelBytes(src))
      return {
        kind: 'value-net',
        // Search scores are logit times 100 for the side to move; the report wants White's side in logit units.
        eval: (fen: string) => {
          const v = bestMove(net, fen, { maxDepth: 2 }).score / 100
          return fen.split(' ')[1] === 'w' ? v : -v
        },
        blunder: 1,
        unit: "points of the AI's own position score",
        searched: 2,
      } satisfies ChessEvaluator
    } catch {
      cached = null
      return MATERIAL
    }
  })()
  cached = p
  return p
}
