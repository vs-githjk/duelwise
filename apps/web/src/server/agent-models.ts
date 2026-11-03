import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import * as ort from 'onnxruntime-web/wasm'
import type { GameId, Level } from '@duelwise/core/src/product'
import type { Seat } from '@duelwise/core/src/types'
import { createGameAgent } from '@duelwise/agents/src/agent-dispatch'
import { CHESS_LEVELS } from '@duelwise/agents/src/chess/agent'
import { FOUR_LEVELS } from '@duelwise/agents/src/four/agent'
import { DEFAULT_TABLE_BASE } from '@duelwise/agents/src/holdem/agent'
import { MODEL_BASE as CHESS_BASE } from '@duelwise/agents/src/chess/model-files'
import { MODEL_BASE as FOUR_BASE } from '@duelwise/agents/src/four/model-files'
import { loadTable } from '@duelwise/agents/src/holdem/table'
import type { CheckAgent } from './agent-check'

/**
 * The server's copy of the opponent for the H1 check (agent-check.ts). The agents package reads its model files
 * by a path that only exists in a source checkout, or by a relative fetch that means nothing on a server, so the
 * bytes are read here and handed to the same factory the page uses. The files are the site's own static files:
 * read from the build or the source tree when they are there, else fetched from the site (BETTER_AUTH_URL).
 */

const ORT_MJS = 'ort-wasm-simd-threaded.mjs'
const ORT_WASM = 'ort-wasm-simd-threaded.wasm'
let ortReady = false

/**
 * Points onnxruntime-web at its wasm glue and binary on disk. The package finds them next to its own file, which is
 * only true in a source checkout: in a server bundle the build copies them to <server>/ort (vite.config.ts), and this
 * looks upward from the running file, then in node_modules.
 */
export function configureOrt(): void {
  if (ortReady) return
  const dirs: string[] = []
  for (let d = import.meta.dirname, i = 0; i < 5; i++, d = dirname(d)) dirs.push(join(d, 'ort'))
  try {
    dirs.push(dirname(createRequire(import.meta.url).resolve('onnxruntime-web/wasm')))
  } catch {
    /* not resolvable from a bundle; the copied folder above is the way */
  }
  const dir = dirs.find((d) => existsSync(join(d, ORT_MJS)) && existsSync(join(d, ORT_WASM)))
  if (!dir) throw new Error(`onnxruntime-web files not found (looked in ${dirs.join(', ')})`)
  ort.env.wasm.wasmPaths = { mjs: pathToFileURL(join(dir, ORT_MJS)).href, wasm: pathToFileURL(join(dir, ORT_WASM)).href }
  ort.env.wasm.numThreads = 1
  ortReady = true
}

const cache = new Map<string, Promise<Uint8Array>>()

function candidates(path: string): string[] {
  const here = import.meta.dirname
  return [join(here, '..', '..', 'public', path), join(process.cwd(), 'public', path), join(process.cwd(), 'apps', 'web', 'public', path), join(process.cwd(), '.output', 'public', path)]
}

/** Bytes of a file under public/ (a path starting with "/agents/..."), cached for the life of the process. */
export function publicBytes(path: string, site: string | null): Promise<Uint8Array> {
  let hit = cache.get(path)
  if (!hit) {
    hit = (async () => {
      for (const p of candidates(path)) if (existsSync(p)) return new Uint8Array(await readFile(p))
      if (!site) throw new Error(`model file ${path} is not on disk and no site URL is set`)
      const res = await fetch(`${site}${path}`)
      if (!res.ok) throw new Error(`model file ${path}: HTTP ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    })()
    cache.set(path, hit)
    hit.catch(() => cache.delete(path))
  }
  return hit
}

/**
 * Levels whose play depends on how fast the player's device ran a time-capped search: the page cuts the search
 * at its cap, so the move it played cannot be reproduced exactly here. They are never treated as forged
 * when the moves differ, only as not checkable (so the match is not counted).
 */
export function isTimeCapped(game: GameId, level: Level): boolean {
  // The chess Champion searches a fixed node budget (no clock), so the server reproduces every move.
  if (game === 'chess') return false
  if (game === 'four') return FOUR_LEVELS[level].timeCapMs !== undefined
  return false
}

/** The shipped agent for a check, built from model bytes this process read. Throws when a model file is missing. */
export async function makeServerAgent(game: GameId, level: Level, seat: Seat, site: string | null): Promise<CheckAgent> {
  // Hold'em reads a table and Crosscurrent is a plain search: neither loads the onnx runtime.
  if (game !== 'holdem' && game !== 'slack') configureOrt()
  if (game === 'chess') {
    // The Champion needs only the value net: it runs the page's fixed node budget, so its moves match.
    if (level === 'champion') {
      const valueBytes = await publicBytes(`${CHESS_BASE}/value.bin`, site)
      return createGameAgent('chess', level, { seat, valueBytes } as never) as Promise<CheckAgent>
    }
    const config = CHESS_LEVELS[level]
    const policyBytes = await publicBytes(`${CHESS_BASE}/policy-${config.band}.onnx`, site)
    // The page tolerates a missing value net (Medium and Hard then play without the repetition rule); so must the check.
    const valueBytes = await publicBytes(`${CHESS_BASE}/value.bin`, site).catch(() => undefined)
    return createGameAgent('chess', level, { seat, policyBytes, ...(valueBytes ? { valueBytes } : {}) } as never) as Promise<CheckAgent>
  }
  if (game === 'four') {
    const config = FOUR_LEVELS[level]
    const modelBytes = await publicBytes(`${config.base ?? FOUR_BASE}/${config.model}`, site)
    // The check runs the full simulation count: a time cap would make the result depend on this server's speed.
    return createGameAgent('four', level, { seat, modelBytes, search: { timeCapMs: undefined } } as never) as Promise<CheckAgent>
  }
  if (game === 'slack') {
    // The same factory and the same options as the page's worker (games/slack/worker.ts): a search that stops at a node count, never a clock.
    return createGameAgent('slack', level, { seat }) as Promise<CheckAgent>
  }
  if (game === 'holdem') {
    const table = loadTable(await publicBytes(`${DEFAULT_TABLE_BASE}/${level}.bin.gz`, site))
    return createGameAgent('holdem', level, { seat, table } as never) as Promise<CheckAgent>
  }
  throw new Error(`no server copy of the ${game} opponent`)
}
