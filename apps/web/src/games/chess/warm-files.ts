import type { Level } from '@duelwise/core/src/product'
import { MODEL_BASE } from '@duelwise/agents/src/chess/model-files'

/** Policy net band per level. Must match CHESS_LEVELS in packages/agents/src/chess/agent.ts (warm.test.ts checks). */
export const WARM_BANDS: Record<'easy' | 'medium' | 'hard', string> = { easy: 'b1100', medium: 'b1500', hard: 'b1900' }

/** The static files an agent of this level downloads, in the order it needs them; `wasmUrl` is the ORT runtime. */
export function warmFiles(level: Level, wasmUrl: string): string[] {
  const model = level === 'champion' ? [] : [`${MODEL_BASE}/policy-${WARM_BANDS[level]}.onnx`]
  return [...model, `${MODEL_BASE}/value.bin`, wasmUrl]
}
