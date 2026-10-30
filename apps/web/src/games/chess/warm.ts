import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import type { Level } from '@duelwise/core/src/product'
import { warmFiles } from './warm-files'

const started = new Set<string>()

/**
 * Starts downloading the model and the wasm runtime while the player is still on the setup screen, in
 * parallel, so the HTTP cache already holds them when the opponent's worker asks (it fetches the model,
 * then the wasm, one after the other). Fire and forget: a failure only means the worker downloads it itself.
 */
export function warmChessAssets(level: Level, fetchFn: typeof fetch = fetch): void {
  for (const url of warmFiles(level, ortWasmUrl)) {
    if (started.has(url)) continue
    started.add(url)
    void fetchFn(url).then((r) => r.arrayBuffer()).catch(() => started.delete(url))
  }
}
