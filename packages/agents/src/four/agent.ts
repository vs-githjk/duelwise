import { fourCore, type FourObservation } from '@duelwise/core/src/games/four/core'
import { fourEncoder } from '@duelwise/core/src/games/four/encode'
import { COLS, bitOf, type FourState } from '@duelwise/core/src/games/four/rules'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { maskedSoftmax } from '../mcts/evaluator'
import { OnnxEvaluator } from '../mcts/onnx-evaluator'
import { search, selectCode } from '../mcts/puct'
import { createStubAgent } from '../stub-agent'
import { forcedMove, pickVaried, provenKeepers } from './tactics'
import { FourModelMissingError, loadFourModel, MODEL_BASE } from './model-files'

export interface FourLevelConfig {
  /** Model file under `base`. */
  model: string
  /** Site folder the model lives in; default /agents/four/v1. A retrain that is promoted ships its Champion in a new folder (registry four.json names it; a test pins the two). */
  base?: string
  /** PUCT simulations per move; 0 plays the net's policy directly. */
  sims: number
  /** Easy samples the policy at this temperature; with search it picks among root visits (0 is greedy). */
  temperature: number
  /** Wall-clock cap for one move in the shipped agent, ms. The measurement ladder removes it and counts simulations. */
  timeCapMs?: number
  /** Always take an immediate win and always block an open one-move threat, before any search or sampling. */
  tactics?: boolean
  /**
   * Per-match variety so one memorized line cannot beat the level twice: for the first `plies` stones the root gets Dirichlet noise
   * and the move is drawn from the near-best root moves (at least `keepShare` of the top visit count) that do not hand over an
   * immediate win and whose search value is within `valueMargin` of the top move's. A forced win or block is always played.
   */
  variety?: {
    plies: number
    keepShare: number
    valueMargin: number
    temperature: number
    dirichlet: { alpha: number; eps: number }
    /** A looser pick from stone `from` (default 0) up to `plies`. It starts at stone 3 on purpose: the human's first stone is answered by the tight pick, because the centre reply is worth about 0.35 more than any other column and trading it away made the Champion lose its strength in real play. */
    opening?: { from?: number; plies: number; keepShare: number; valueMargin: number; temperature: number }
    /**
     * From this stone on (up to `plies`) the weak solver proves which columns keep a drawn or won game value, and only those are ever played; in a
     * position that is lost every column has the same value, so `lostPick` (a looser search-value pick) applies. Before that stone the solver is too slow to run in a move (seconds from 8
     * stones, minutes from 1), so the opening tier relies on a tight search-value margin instead.
     */
    solverFrom?: number
    /** The pick in a position the solver proves lost for the side to move (from `solverFrom`): every column has the same value there, so it can be looser than the opening tier. */
    lostPick?: { keepShare: number; valueMargin: number; temperature: number }
  }
}

/** Must equal EASY_TEMPERATURE in training/trainer/four/pick_levels.py, which picks the Easy checkpoint with this config (a test pins both). */
export const EASY_TEMPERATURE = 0.15

const VARIETY = { plies: 24, keepShare: 0.05, valueMargin: 0.15, temperature: 1, dirichlet: { alpha: 1, eps: 0.4 } }
const CHAMPION_VARIETY = {
  plies: 24,
  keepShare: 0.05,
  valueMargin: 0.15,
  temperature: 1,
  dirichlet: { alpha: 1, eps: 0.4 },
  // Stones 3 to 11 vary only among moves the net rates within 0.1 of the best and that keep a real share of the visits; from stone 12 the solver decides.
  opening: { from: 3, plies: 12, keepShare: 0.05, valueMargin: 0.1, temperature: 1.5 },
  solverFrom: 12,
  lostPick: { keepShare: 0.002, valueMargin: 0.3, temperature: 3 },
}

/** Level configs: the same values are written into packages/agents/registry/four.json. */
export const FOUR_LEVELS: Record<Level, FourLevelConfig> = {
  easy: { model: 'easy.onnx', sims: 0, temperature: EASY_TEMPERATURE },
  medium: { model: 'medium.onnx', sims: 24, temperature: 0.3, tactics: true },
  hard: { model: 'hard.onnx', sims: 120, temperature: 0.1, variety: VARIETY },
  // The site allows the Champion 1.5 s a move; 800 simulations fit that on an M2, and the cap is a safety net on slower devices.
  champion: { model: 'champion.onnx', base: '/agents/four/v2', sims: 800, temperature: 0, timeCapMs: 1400, variety: CHAMPION_VARIETY },
}

export interface FourAgentOpts extends AgentOpts {
  /** Replace the level's search budget (the measurement ladder passes simulations only, no time cap). */
  search?: { sims?: number; timeCapMs?: number | undefined }
  /** Model bytes given directly (tests); otherwise fetched or read from /agents/four/v1. */
  modelBytes?: Uint8Array
}

/** Rebuilds the position from an observation (cells from the observer's view). Used only when the caller sends no state. */
export function stateFromObservation(o: FourObservation): FourState {
  const bb: [number, number, number, number] = [0, 0, 0, 0]
  const h = new Array<number>(COLS).fill(0)
  let n = 0
  for (let i = 0; i < o.cells.length; i++) {
    const v = o.cells[i]!
    if (v === 0) continue
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const owner = v === 1 ? o.seat : 1 - o.seat
    const [lo, hi] = bitOf(col, row)
    bb[owner * 2] = (bb[owner * 2]! | lo) >>> 0
    bb[owner * 2 + 1] = (bb[owner * 2 + 1]! | hi) >>> 0
    h[col] = Math.max(h[col]!, row + 1)
    n++
  }
  return { bb, h, n, winner: null }
}

function sample(priors: ArrayLike<number>, rng: Rng): number {
  let r = rng.float()
  let last = -1
  for (let c = 0; c < priors.length; c++) {
    if (priors[c]! <= 0) continue
    last = c
    r -= priors[c]!
    if (r < 0) return c
  }
  return last
}

/** Part of the Champion time cap kept back for the proof-of-keepers solver on solver-stage positions. */
const SOLVER_RESERVE_MS = 400

export async function createGameAgent(level: Level, opts: FourAgentOpts = {}): Promise<PreviewAgent> {
  const config = FOUR_LEVELS[level]
  let bytes: Uint8Array
  try {
    bytes = opts.modelBytes ?? (await loadFourModel(config.model, config.base ?? MODEL_BASE))
  } catch (e) {
    // A model that is not published yet leaves the level a labelled preview; any other failure is a real error.
    if (!(e instanceof FourModelMissingError)) throw e
    return createStubAgent('four', level, opts)
  }
  const evaluator = await OnnxEvaluator.create({ core: fourCore, encoder: fourEncoder, actionCount: COLS, model: bytes })
  const sims = opts.search?.sims ?? config.sims
  const timeCapMs = opts.search && 'timeCapMs' in opts.search ? opts.search.timeCapMs : config.timeCapMs
  let rng: Rng = makeRng(0)
  return {
    preview: false,
    reset(seed) {
      rng = makeRng(seed)
    },
    async act(obs, state) {
      const s = (state as FourState | undefined) ?? stateFromObservation(obs as FourObservation)
      if (config.tactics) {
        const forced = forcedMove(s)
        if (forced !== null) return [forced]
      }
      if (sims === 0) {
        const { logits } = await evaluator.raw([s])
        const codes = fourCore.legal(s, fourCore.toAct(s)[0]!)
        const scaled = Array.from(logits, (x) => x / Math.max(config.temperature, 1e-6))
        return [sample(maskedSoftmax(scaled, codes, COLS), rng)]
      }
      const v = config.variety
      if (v && s.n < v.plies) {
        const started = performance.now()
        const solving = v.solverFrom !== undefined && s.n >= v.solverFrom
        // The solver runs after the search, so a position that will be solved gives it a slice of the cap and the search the rest.
        const searchCap = solving && timeCapMs !== undefined ? Math.max(timeCapMs - SOLVER_RESERVE_MS, timeCapMs / 2) : timeCapMs
        const r = await search(fourCore, s, evaluator, { sims, actionCount: COLS, temperature: 0, timeCapMs: searchCap, rng, dirichlet: v.dirichlet })
        // A time cap that ended the search at the root leaves no visits; play its prior-based move then.
        if (!r.visits.some((x) => x > 0)) return [r.action]
        const pick = v.opening && s.n >= (v.opening.from ?? 0) && s.n < v.opening.plies ? v.opening : v
        if (v.solverFrom === undefined || s.n < v.solverFrom) return [pickVaried(r.visits, r.q, s, rng, pick)]
        const keep = provenKeepers(s, timeCapMs !== undefined ? { deadline: started + timeCapMs } : {})
        // Out of solver budget: the proof is unknown, so take the tight pick (never the looser lost pick, which may play a losing-class move).
        if (keep === 'unknown') return [pickVaried(r.visits, r.q, s, rng, pick)]
        // A lost position has no proven set (every move has the same value), so it takes the looser lost pick: a blind winning line must still meet a different game each time.
        return [pickVaried(r.visits, r.q, s, rng, keep === null ? (v.lostPick ?? pick) : { ...pick, allowed: keep })]
      }
      const r = await search(fourCore, s, evaluator, { sims, actionCount: COLS, temperature: config.temperature, timeCapMs, rng })
      return [r.action >= 0 ? r.action : selectCode(r.policy, 0, rng)]
    },
    dispose() {
      void evaluator.dispose()
    },
  }
}
