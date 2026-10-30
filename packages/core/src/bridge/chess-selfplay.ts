// Chess self-play host: plays whole games of the Champion search against itself and sends back the searched
// positions, so the trainer (training/trainer/chess/selfplay_value.py) can fine-tune the value net on them.
// Entered through `main.ts --game chess --mode selfplay` (see selfplay-loader.ts).
//
// Unlike the shared host there is no network round trip: the search runs on the TypeScript value net
// (value.bin), the same code the browser Champion uses, so the data is exactly what that agent sees.
//
// Flags: --value <absolute path to value.bin> (default: the shipped apps/web/public/agents/chess/v1/value.bin),
// --games (default --n, default 1), --seed, --nodes (search node budget per move, default 400),
// --max-plies (160; a game cut short is returned with truncated: true and no winner),
// --open-plies (4: random legal moves at the start so games differ; they are played but not recorded),
// --explore-plies (12) and --eps (0.1: inside those plies a searched move is replaced by a random legal one
// with this probability; the position is still recorded with its own search score), --tt-bits (16).
//
// A ply with a single legal move is played but not recorded (the search returns score 0 for it without looking), and
// counted in `forced`, so feats.length == moves.length - opening - forced.
//
// Wire: one frame {type:'games', games, stats} when every game is done. Per game: `moves` (UCI, all plies),
// `opening` (number of random opening plies), and for each searched ply `feats` (active feature indices of the
// position from the mover's side, the same 768 features as core sparse.ts), `scores` (search score for the mover
// in logit * 100 units, see agents/src/chess/alphabeta.ts, mate = +-20000 minus plies) and `seats` (who moved).
import { chessCore, type ChessState } from '../games/chess/core'
import { sparseIndices } from '../games/chess/sparse'
import { makeRng } from '../rng'
import { encodeFrame } from './protocol'
import type { RunSelfPlay } from './selfplay-loader'
import { Searcher } from '../../../agents/src/chess/alphabeta'
import { ValueNet } from '../../../agents/src/chess/value-eval'
import { loadModelBytes } from '../../../agents/src/chess/model-files'

const num = (args: Record<string, string>, key: string, dflt: number): number => {
  const raw = args[key]
  if (raw === undefined) return dflt
  const v = Number(raw)
  if (!Number.isFinite(v)) throw new Error(`--${key} must be a number, got ${raw}`)
  return v
}

export interface ChessSelfPlayGame {
  moves: string[]
  opening: number
  forced: number
  feats: number[][]
  scores: number[]
  seats: (0 | 1)[]
  winner: 0 | 1 | null
  truncated: boolean
}

export const runSelfPlay: RunSelfPlay = async (args, io) => {
  const games = num(args, 'games', num(args, 'n', 1))
  const seed = num(args, 'seed', 0)
  const nodes = num(args, 'nodes', 400)
  const maxPlies = num(args, 'max-plies', 160)
  const openPlies = num(args, 'open-plies', 4)
  const explorePlies = num(args, 'explore-plies', 12)
  const eps = num(args, 'eps', 0.1)
  const ttBits = num(args, 'tt-bits', 16)
  for (const [k, v] of Object.entries({ games, nodes, 'max-plies': maxPlies })) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`--${k} must be a positive integer`)
  }
  if (!Number.isInteger(openPlies) || openPlies < 0) throw new Error('--open-plies must be a non-negative integer')
  let bytes: Uint8Array
  if (args.value) {
    const { readFile } = await import('node:fs/promises')
    bytes = new Uint8Array(await readFile(args.value))
  } else bytes = await loadModelBytes('value.bin')
  const searcher = new Searcher(new ValueNet(bytes), ttBits)

  const out: ChessSelfPlayGame[] = []
  let searched = 0
  for (let g = 0; g < games; g++) {
    const rng = makeRng(seed * 7919 + g + 1)
    searcher.clear()
    let state: ChessState = chessCore.init(0)
    const game: ChessSelfPlayGame = { moves: [], opening: 0, forced: 0, feats: [], scores: [], seats: [], winner: null, truncated: false }
    while (!chessCore.terminal(state)) {
      if (game.moves.length >= maxPlies) {
        game.truncated = true
        break
      }
      const seat = chessCore.toAct(state)[0]!
      const legal = chessCore.legal(state, seat)
      const ply = game.moves.length
      let uci: string
      if (ply < openPlies) {
        uci = legal[rng.int(legal.length)]!
        game.opening++
      } else {
        const r = searcher.search(state.fen, { nodeBudget: nodes, priorKeys: state.keys.slice(0, -1) })
        if (r.ended === 'only-move') game.forced++ // a single legal move is not searched (score 0), so it has no training target
        else {
          game.feats.push(Array.from(sparseIndices(chessCore.observe(state, seat))))
          game.scores.push(r.score)
          game.seats.push(seat as 0 | 1)
          searched++
        }
        uci = ply < openPlies + explorePlies && rng.float() < eps ? legal[rng.int(legal.length)]! : r.uci
      }
      game.moves.push(uci)
      const acts: [string | null, string | null] = [null, null]
      acts[seat] = uci
      state = chessCore.step(state, acts)
    }
    if (!game.truncated) game.winner = (chessCore.result(state)?.winner ?? null) as 0 | 1 | null
    out.push(game)
  }
  await io.write(encodeFrame({ type: 'games', games: out, stats: { games: out.length, searched, nodes } }))
  return 0
}
