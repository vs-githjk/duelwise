import type { GameCore, Rng, Seat } from '@duelwise/core/src/types'
import type { Evaluation, Evaluator } from './evaluator'

// PUCT search (AlphaZero style) for two-player, zero-sum, turn-based games behind GameCore.
// Edge values are kept from the view of the seat that acts on that edge, so a backup adds +z or -z
// without caring who is to move. The search is a small state machine (`pending` then `provide`) so a
// host can run hundreds of searches at once and evaluate all their leaves in one batch.

export interface PuctOptions {
  /** Simulations after the root expansion; the root's child visits sum to this. */
  sims: number
  /** Number of action codes (policy width), e.g. 7 for Four in a Row. */
  actionCount: number
  /** Exploration constant. Default 1.5. */
  cPuct?: number
  /** Root exploration noise: priors become (1 - eps) * p + eps * Dirichlet(alpha). */
  dirichlet?: { alpha: number; eps: number }
  /** Needed for Dirichlet noise only. */
  rng?: Rng
}

export interface PuctResult {
  /** Child visits per action code (length actionCount); sums to the simulations run. */
  visits: number[]
  /** Visits normalised to sum 1 (all zeros when the root is terminal). */
  policy: number[]
  /** Mean backed-up value of each root action from the view of the seat to act, in [-1, 1] (0 where the action has no visits). */
  q: number[]
  /** Mean value of the root from the view of the seat to act, in [-1, 1]. */
  value: number
  /** Action code with the most visits (lowest code on ties); -1 when the root is terminal. */
  best: number
}

interface Edge<A> {
  action: A
  code: number
  actor: Seat
  prior: number
  n: number
  /** Sum of backed-up values from `actor`'s view. */
  w: number
  child: Node<any> | null
}

interface Node<S> {
  state: S
  seat: Seat
  terminal: boolean
  edges: Edge<any>[] | null
  n: number
}

function normal(rng: Rng): number {
  let u = rng.float()
  while (u <= 0) u = rng.float()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.float())
}

/** Gamma(alpha, 1) by Marsaglia and Tsang, with the usual boost for alpha < 1. */
function gamma(alpha: number, rng: Rng): number {
  if (alpha < 1) {
    let u = rng.float()
    while (u <= 0) u = rng.float()
    return gamma(alpha + 1, rng) * Math.pow(u, 1 / alpha)
  }
  const d = alpha - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number
    let v: number
    do {
      x = normal(rng)
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = rng.float()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

export class PuctSearch<S, A, O> {
  private readonly cPuct: number
  private readonly root: Node<S>
  private simsDone = 0
  private waiting: { node: Node<S>; path: Edge<A>[] } | null = null

  constructor(
    private readonly core: GameCore<S, A, O>,
    rootState: S,
    private readonly opts: PuctOptions,
  ) {
    if (!Number.isInteger(opts.sims) || opts.sims < 0) throw new RangeError('PuctSearch: sims must be a non-negative integer')
    if (opts.dirichlet && !opts.rng) throw new Error('PuctSearch: dirichlet noise needs an rng')
    this.cPuct = opts.cPuct ?? 1.5
    this.root = this.makeNode(rootState)
  }

  private makeNode(state: S): Node<S> {
    const terminal = this.core.terminal(state)
    const seat = terminal ? 0 : this.core.toAct(state)[0]!
    return { state, seat, terminal, edges: null, n: 0 }
  }

  /** True once the root is expanded and every simulation has finished. */
  get done(): boolean {
    return this.root.edges !== null && this.simsDone >= this.opts.sims && this.waiting === null
  }

  /** The position that needs an evaluation next, or null when the search is finished. Repeated calls
   *  return the same position until `provide` is called. */
  pending(): S | null {
    if (this.waiting) return this.waiting.node.state
    if (this.root.edges === null) {
      if (this.root.terminal) {
        this.root.edges = []
        return null
      }
      this.waiting = { node: this.root, path: [] }
      return this.root.state
    }
    while (this.simsDone < this.opts.sims) {
      const path: Edge<A>[] = []
      let node = this.root
      for (;;) {
        const edge = this.select(node)
        if (!edge) {
          // No legal move in a non-terminal position: score it as a draw.
          this.backup(path, 0)
          break
        }
        path.push(edge)
        if (!edge.child) {
          const acts: [A | null, A | null] = [null, null]
          acts[edge.actor] = edge.action
          edge.child = this.makeNode(this.core.step(node.state, acts))
        }
        node = edge.child
        if (node.terminal) {
          const r = this.core.result(node.state)
          this.backup(path, r ? r.score[0] - r.score[1] : 0)
          break
        }
        if (node.edges === null) {
          this.waiting = { node, path }
          return node.state
        }
      }
    }
    return null
  }

  /** Supplies the evaluation of the position `pending` returned. */
  provide(ev: Evaluation): void {
    const w = this.waiting
    if (!w) throw new Error('PuctSearch.provide: nothing is pending')
    this.waiting = null
    const node = w.node
    this.expand(node, ev.priors)
    if (node === this.root) {
      this.addNoise()
      return
    }
    const v = Math.max(-1, Math.min(1, ev.value))
    this.backup(w.path, node.seat === 0 ? v : -v)
  }

  result(): PuctResult {
    const visits = new Array<number>(this.opts.actionCount).fill(0)
    const q = new Array<number>(this.opts.actionCount).fill(0)
    let total = 0
    let w = 0
    let best = -1
    for (const e of this.root.edges ?? []) {
      visits[e.code] = e.n
      q[e.code] = e.n > 0 ? e.w / e.n : 0
      total += e.n
      w += e.w
    }
    for (let c = 0; c < visits.length; c++) {
      if (!(this.root.edges ?? []).some((e) => e.code === c)) continue
      if (best < 0 || visits[c]! > visits[best]!) best = c
    }
    return {
      visits,
      policy: visits.map((v) => (total > 0 ? v / total : 0)),
      q,
      value: total > 0 ? w / total : 0,
      best,
    }
  }

  /** Legal action code with the highest prior at the root (lowest code on ties); -1 if none. */
  topPrior(): number {
    let best: Edge<A> | null = null
    for (const e of this.root.edges ?? []) if (!best || e.prior > best.prior) best = e
    return best ? best.code : -1
  }

  private expand(node: Node<S>, priors: ArrayLike<number>): void {
    const legal = this.core.legal(node.state, node.seat)
    const edges: Edge<A>[] = legal.map((action) => {
      const code = this.core.encodeAction(action)
      const p = priors[code] ?? 0
      return { action, code, actor: node.seat, prior: p > 0 && Number.isFinite(p) ? p : 0, n: 0, w: 0, child: null }
    })
    let sum = 0
    for (const e of edges) sum += e.prior
    for (const e of edges) e.prior = sum > 0 ? e.prior / sum : 1 / edges.length
    node.edges = edges
  }

  private addNoise(): void {
    const d = this.opts.dirichlet
    const edges = this.root.edges
    if (!d || !edges || edges.length === 0) return
    const rng = this.opts.rng!
    const g = edges.map(() => gamma(d.alpha, rng))
    const total = g.reduce((a, b) => a + b, 0) || 1
    edges.forEach((e, i) => {
      e.prior = (1 - d.eps) * e.prior + d.eps * (g[i]! / total)
    })
  }

  private select(node: Node<S>): Edge<A> | null {
    const edges = node.edges as Edge<A>[]
    if (edges.length === 0) return null
    const sqrtN = Math.sqrt(node.n + 1)
    let best: Edge<A> | null = null
    let bestScore = -Infinity
    for (const e of edges) {
      const q = e.n > 0 ? e.w / e.n : 0
      const score = q + (this.cPuct * e.prior * sqrtN) / (1 + e.n)
      if (score > bestScore) {
        bestScore = score
        best = e
      }
    }
    return best
  }

  /** `z0` is the leaf value from seat 0's view. */
  private backup(path: Edge<A>[], z0: number): void {
    this.root.n++
    for (const e of path) {
      e.n++
      e.w += e.actor === 0 ? z0 : -z0
      if (e.child) e.child.n++
    }
    this.simsDone++
  }
}

/** Runs one search to the end against an evaluator (one position per call). */
export async function puctSearch<S, A, O>(
  core: GameCore<S, A, O>,
  state: S,
  evaluator: Evaluator<S>,
  opts: PuctOptions,
): Promise<PuctResult> {
  const search = new PuctSearch(core, state, opts)
  for (let s = search.pending(); s !== null; s = search.pending()) {
    const [ev] = await evaluator.evaluate([s])
    search.provide(ev!)
  }
  return search.result()
}

export interface SearchOptions extends PuctOptions {
  /** Temperature for picking the action from visits; 0 is greedy. */
  temperature: number
  /** Wall-clock budget in ms. No new leaf is requested once it has passed; the root expansion always happens. */
  timeCapMs?: number
  rng: Rng
}

export interface SearchResult {
  /** Chosen action code (-1 when the root is terminal). */
  action: number
  visits: number[]
  policy: number[]
  /** Mean value of each root action from the mover's view (see PuctResult.q). */
  q: number[]
  value: number
}

/** Time-capped search that also picks the move: the plan's `search` interface. */
export async function search<S, A, O>(
  core: GameCore<S, A, O>,
  state: S,
  evaluator: Evaluator<S>,
  opts: SearchOptions,
): Promise<SearchResult> {
  const start = Date.now()
  const s = new PuctSearch(core, state, opts)
  for (let pos = s.pending(); pos !== null; ) {
    const [ev] = await evaluator.evaluate([pos])
    s.provide(ev!)
    // Keep at least the root expansion, then stop issuing leaves once the cap has elapsed.
    if (opts.timeCapMs !== undefined && Date.now() - start >= opts.timeCapMs) break
    pos = s.pending()
  }
  const r = s.result()
  const visits = r.visits
  if (!visits.some((v) => v > 0)) {
    // Cap hit right after the root expansion: fall back to the highest-prior legal action.
    return { action: s.topPrior(), visits, policy: r.policy, q: r.q, value: r.value }
  }
  return { action: selectCode(visits, opts.temperature, opts.rng), visits, policy: r.policy, q: r.q, value: r.value }
}

/** Picks an action code from visit counts. temperature 0: most visits (lowest code on ties);
 *  otherwise sample in proportion to visits^(1 / temperature) with the given rng. */
export function selectCode(visits: readonly number[], temperature: number, rng: Rng): number {
  let best = -1
  for (let c = 0; c < visits.length; c++) if (visits[c]! > 0 && (best < 0 || visits[c]! > visits[best]!)) best = c
  if (best < 0) return -1
  if (temperature <= 0) return best
  const w = visits.map((v) => (v > 0 ? Math.pow(v, 1 / temperature) : 0))
  const total = w.reduce((a, b) => a + b, 0)
  let r = rng.float() * total
  for (let c = 0; c < w.length; c++) {
    r -= w[c]!
    if (r < 0 && w[c]! > 0) return c
  }
  return best
}
