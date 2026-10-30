// Shared self-play host: many games at once, one PUCT search per game, all leaf evaluations of a round
// sent to Python in a single batch. Entered through `main.ts --mode selfplay` (see selfplay-loader.ts).
//
// Flags (all through main.ts): --game four, --n parallel games, --games total games (default n),
// --sims per move (default 200), --seed, --cpuct (1.5), --alpha (Dirichlet, 1.0), --eps (0.25),
// --temp-plies (8: sample from visits^1 for this many plies, then play the most visited column),
// --max-plies (0: none; a game cut short is returned with truncated: true),
// --cache (400000: positions whose network output is remembered for the whole run; 0 turns the cache and the
// sharing of equal leaves off, which is the T12 behaviour),
// --flush (0: none; send the games finished so far every this many finished games, see below),
// --starts (path of a JSON file { positions: number[][] }: move lists of positions people reached) with --start-share
// (0.3: the fraction of games that begin from one of them instead of the empty board). Such a game reports the
// moves that led to its start as `prefix`; `moves`, `visits` and `q` cover only the searched plies after it.
//
// Throughput (T12b): the network is the bottleneck, so a leaf is sent to Python at most once per run. Leaves
// seen before (transpositions inside one search, and the openings every game shares) are answered from the
// cache, and equal leaves inside one round share one row of the batch. The evaluations are identical to
// uncached ones, so a run plays the same games with or without the cache.
//
// Resilience (T12b): with --flush K the host also sends {type:'games', partial:true, games} after every K
// finished games, so a caller whose bridge dies keeps what was finished and only replays the rest.
//
// Wire: Bun sends {type:'eval_request', n, obsSize} + float32 batch (n * obsSize); Python answers
// {type:'eval_response', n} + float32 policy logits (n * A) then float32 values (n), value from the view of
// the seat to act. When every game is finished Bun sends one {type:'games', games, stats}; the samples are
// the moves plus the visit counts of each ply, so Python rebuilds the features by replaying the moves.
import { readFileSync } from 'node:fs'
import type { GameCore, Rng } from '../types'
import { makeRng } from '../rng'
import { fourCore, fourEncoder } from '../games/four'
import type { FeatureEncoder } from '../types'
import { encodeFrame, type Frame } from './protocol'
import type { RunSelfPlay } from './selfplay-loader'
// The search lives with the agents (the browser runs the same code); the host only drives it.
import { PuctSearch, selectCode } from '../../../agents/src/mcts/puct'
import { maskedSoftmax } from '../../../agents/src/mcts/evaluator'

interface SelfPlayGame {
  core: GameCore<any, any, any>
  encoder: FeatureEncoder<any>
  actionCount: number
  /** Key of a position (a function of the network input) and whether the board is left-right mirrored to
   *  reach the key's orientation: a position and its mirror image share one network evaluation. */
  canon: (obs: any) => { k: string; flip: boolean }
  /** Mirrors one encoded feature row in place (the same flip `canon` reports). */
  mirrorRow: (buf: Float32Array, offset: number) => void
}

const FOUR_COLS = 7
const FOUR_ROWS = 6

const GAMES: Record<string, SelfPlayGame> = {
  four: {
    core: fourCore,
    encoder: fourEncoder,
    actionCount: FOUR_COLS,
    canon: (o) => {
      let a = ''
      let b = ''
      for (let r = 0; r < FOUR_ROWS; r++) {
        for (let c = 0; c < FOUR_COLS; c++) {
          a += o.cells[r * FOUR_COLS + c]
          b += o.cells[r * FOUR_COLS + FOUR_COLS - 1 - c]
        }
      }
      return a <= b ? { k: a, flip: false } : { k: b, flip: true }
    },
    mirrorRow: (buf, off) => {
      for (let plane = 0; plane < 3; plane++) {
        for (let r = 0; r < FOUR_ROWS; r++) {
          const base = off + plane * FOUR_ROWS * FOUR_COLS + r * FOUR_COLS
          for (let c = 0; c < FOUR_COLS >> 1; c++) {
            const t = buf[base + c]!
            buf[base + c] = buf[base + FOUR_COLS - 1 - c]!
            buf[base + FOUR_COLS - 1 - c] = t
          }
        }
      }
    },
  },
}

export interface FinishedGame {
  moves: number[]
  /** Root visit counts of each ply, one row per move. */
  visits: number[][]
  /** Root value of each ply from the view of the seat that moved, rounded to 4 decimals. */
  q: number[]
  /** The unsearched moves that led to the start position (human-reached positions); absent for a game from the empty board. */
  prefix?: number[]
  /** Winning seat, or null for a draw or a truncated game. */
  winner: 0 | 1 | null
  truncated: boolean
}

interface Slot {
  index: number
  prefix: number[]
  rng: Rng
  state: any
  search: PuctSearch<any, any, any> | null
  moves: number[]
  visits: number[][]
  q: number[]
}

const num = (args: Record<string, string>, key: string, dflt: number): number => {
  const raw = args[key]
  if (raw === undefined) return dflt
  const v = Number(raw)
  if (!Number.isFinite(v)) throw new Error(`--${key} must be a number, got ${raw}`)
  return v
}

/** Pulls whole frames off the shared reader as they arrive on stdin. */
class FrameQueue {
  private waiting: ((f: Frame | null) => void) | null = null
  private ended = false
  private queue: Frame[] = []
  error: Error | null = null

  constructor(reader: { push(c: Uint8Array): void; drain(): Generator<Frame> }) {
    process.stdin.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk)
        for (const f of reader.drain()) this.queue.push(f)
      } catch (e) {
        this.error = e as Error
        this.ended = true
      }
      this.wake()
    })
    process.stdin.on('end', () => {
      this.ended = true
      this.wake()
    })
  }

  private wake(): void {
    if (!this.waiting) return
    if (this.queue.length) {
      const w = this.waiting
      this.waiting = null
      w(this.queue.shift()!)
    } else if (this.ended) {
      const w = this.waiting
      this.waiting = null
      w(null)
    }
  }

  next(): Promise<Frame | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!)
    if (this.ended) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }
}

export const runSelfPlay: RunSelfPlay = async (args, io) => {
  const game = GAMES[args.game ?? '']
  if (!game) {
    console.error(`self-play host: no self-play setup for game ${args.game}`)
    return 2
  }
  const { core, encoder, actionCount, canon, mirrorRow } = game
  const parallel = num(args, 'n', 1)
  const total = num(args, 'games', parallel)
  const sims = num(args, 'sims', 200)
  const seed = num(args, 'seed', 0)
  const cPuct = num(args, 'cpuct', 1.5)
  const alpha = num(args, 'alpha', 1.0)
  const eps = num(args, 'eps', 0.25)
  const tempPlies = num(args, 'temp-plies', 8)
  const maxPlies = num(args, 'max-plies', 0)
  const cacheSize = num(args, 'cache', 400_000)
  const flushEvery = num(args, 'flush', 0)
  const startShare = num(args, 'start-share', 0.3)
  const starts: number[][] = args.starts ? (JSON.parse(readFileSync(args.starts, 'utf8')) as { positions: number[][] }).positions : []
  if (startShare < 0 || startShare > 1) throw new Error('--start-share must be between 0 and 1')
  for (const [k, v] of Object.entries({ n: parallel, games: total, sims })) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`--${k} must be a positive integer`)
  }
  const obsSize = encoder.shape.reduce((a, b) => a * b, 1)

  const frames = new FrameQueue(io.reader)
  const finished: FinishedGame[] = []
  let started = 0
  let evals = 0
  let batches = 0
  let hits = 0
  let flushed = 0
  /** position key -> [policy logits (actionCount), value], valid because the network is fixed for the run. */
  const cache = new Map<string, Float32Array>()
  const remember = (k: string, logits: Float32Array, value: number): void => {
    if (cacheSize <= 0) return
    if (cache.size >= cacheSize) cache.clear()
    const row = new Float32Array(actionCount + 1)
    row.set(logits)
    row[actionCount] = value
    cache.set(k, row)
  }
  const flipped = new Float32Array(actionCount)
  /** `row` holds the logits of the key's orientation; a mirrored leaf reads them back to front. */
  const answer = (slot: Slot, state: any, flip: boolean, row: ArrayLike<number>, value: number): void => {
    const seat = core.toAct(state)[0]!
    const codes = core.legal(state, seat).map((m: any) => core.encodeAction(m))
    let logits = row
    if (flip) {
      for (let c = 0; c < actionCount; c++) flipped[c] = row[actionCount - 1 - c]!
      logits = flipped
    }
    slot.search!.provide({ priors: maskedSoftmax(logits, codes, actionCount), value })
  }

  const startGame = (index: number): Slot => {
    const rng = makeRng(seed * 7919 + index + 1)
    let state = core.init(seed * 7919 + index + 1)
    const prefix: number[] = []
    if (starts.length > 0 && rng.float() < startShare) {
      for (const code of starts[rng.int(starts.length)]!) {
        const acts: [any, any] = [null, null]
        acts[core.toAct(state)[0]!] = core.decodeAction(code)
        state = core.step(state, acts)
        prefix.push(code)
      }
    }
    return { index, prefix, rng, state, search: null, moves: [], visits: [], q: [] }
  }
  const slots: (Slot | null)[] = []
  for (let i = 0; i < Math.min(parallel, total); i++) slots.push(startGame(started++))

  const finish = (slot: Slot, truncated: boolean): void => {
    const r = core.result(slot.state)
    finished.push({
      ...(slot.prefix.length > 0 ? { prefix: slot.prefix } : {}),
      moves: slot.moves,
      visits: slot.visits,
      q: slot.q,
      winner: truncated ? null : (r?.winner ?? null),
      truncated,
    })
  }
  const flush = async (): Promise<void> => {
    if (flushEvery <= 0 || finished.length - flushed < flushEvery) return
    await io.write(encodeFrame({ type: 'games', partial: true, games: finished.slice(flushed) }))
    flushed = finished.length
  }

  for (;;) {
    // Give every live slot a search, collect the leaves that need the network.
    const asking: { slot: Slot; state: any; obs: any; k: string; flip: boolean }[] = []
    for (let i = 0; i < slots.length; i++) {
      let slot = slots[i]
      while (slot) {
        if (core.terminal(slot.state)) {
          finish(slot, false)
        } else if (maxPlies > 0 && slot.moves.length >= maxPlies) {
          finish(slot, true)
        } else {
          if (!slot.search) {
            slot.search = new PuctSearch(core, slot.state, { sims, actionCount, cPuct, dirichlet: { alpha, eps }, rng: slot.rng })
          }
          const leaf = slot.search.pending()
          if (leaf !== null) {
            const obs = core.observe(leaf, core.toAct(leaf)[0]!)
            const { k, flip } = cacheSize > 0 ? canon(obs) : { k: '', flip: false }
            const hit = cacheSize > 0 ? cache.get(k) : undefined
            if (hit) {
              answer(slot, leaf, flip, hit, hit[actionCount]!)
              hits++
              continue
            }
            asking.push({ slot, state: leaf, obs, k, flip })
            break
          }
          // Search finished: play the move.
          const res = slot.search.result()
          const seat = core.toAct(slot.state)[0]!
          const code = selectCode(res.visits, slot.moves.length < tempPlies ? 1 : 0, slot.rng)
          slot.moves.push(code)
          slot.visits.push(res.visits)
          slot.q.push(Math.round(res.value * 1e4) / 1e4)
          const acts: [any, any] = [null, null]
          acts[seat] = core.decodeAction(code)
          slot.state = core.step(slot.state, acts)
          slot.search = null
          continue
        }
        // This slot's game ended: start the next one in its place, or retire the slot.
        slot = started < total ? startGame(started++) : null
        slots[i] = slot
      }
    }
    await flush()
    if (asking.length === 0) break

    // Equal leaves (and mirror images) in one round share a row of the batch, encoded in the key's orientation.
    const rowOf = new Map<string, number>()
    const rowSources: (typeof asking)[number][] = []
    const rowIndex = asking.map((a, i) => {
      const id = cacheSize > 0 ? a.k : '#' + i
      let r = rowOf.get(id)
      if (r === undefined) {
        r = rowSources.length
        rowOf.set(id, r)
        rowSources.push(a)
      }
      return r
    })
    const rows = rowSources.length
    const batch = new Float32Array(rows * obsSize)
    rowSources.forEach((a, i) => {
      encoder.encode(a.obs, batch, i * obsSize)
      if (a.flip) mirrorRow(batch, i * obsSize)
    })
    await io.write(encodeFrame({ type: 'eval_request', n: rows, obsSize }, new Uint8Array(batch.buffer)))
    const reply = await frames.next()
    if (!reply) {
      if (frames.error) {
        console.error('self-play host: ' + frames.error.message)
        return 3
      }
      console.error('self-play host: stdin closed before the run finished')
      return 2
    }
    if (reply.header.type === 'close') return 0
    if (reply.header.type !== 'eval_response' || reply.header.n !== rows) {
      console.error(`self-play host: expected eval_response for ${rows}, got ${JSON.stringify(reply.header)}`)
      return 3
    }
    const floats = new Float32Array(reply.payload.buffer.slice(reply.payload.byteOffset, reply.payload.byteOffset + reply.payload.byteLength))
    if (floats.length !== rows * (actionCount + 1)) {
      console.error(`self-play host: eval_response holds ${floats.length} floats, wanted ${rows * (actionCount + 1)}`)
      return 3
    }
    const values = floats.subarray(rows * actionCount)
    const seen = new Set<number>()
    asking.forEach((a, i) => {
      const r = rowIndex[i]!
      const logits = floats.subarray(r * actionCount, (r + 1) * actionCount)
      if (!seen.has(r)) {
        seen.add(r)
        remember(a.k, logits, values[r]!)
      }
      answer(a.slot, a.state, a.flip, logits, values[r]!)
    })
    evals += rows
    batches++
  }

  await io.write(encodeFrame({ type: 'games', games: finished.slice(flushed), stats: { evals, batches, started, hits } }))
  return 0
}
