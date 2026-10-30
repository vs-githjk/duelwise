// Chess measurement (T27). Run from anywhere with absolute paths:
//   bun packages/agents/src/measure/chess.ts calibrate     Champion node budget worth 1 s on this machine
//   bun packages/agents/src/measure/chess.ts timing        Champion seconds per move with the site's time cap
//   bun packages/agents/src/measure/chess.ts puzzles       puzzle accuracy by rating band, every available level
//   bun packages/agents/src/measure/chess.ts ladder        adjacent-level games, 400 per seat
//   bun packages/agents/src/measure/chess.ts publish       clean tree only: measure everything fresh, write packages/agents/registry/chess.json
// Local stage results are JSON files under <common root>/data/cache/chess/measure/, for iteration only: the ladder keeps
// every finished block of games there, so an interrupted run resumes without replaying them, and every file is stamped
// with the full working-tree hash of packages/agents and packages/core plus the model files (R17). `publish` NEVER reads
// those caches: it refuses a dirty tree, then recalibrates, re-times and replays the puzzles and the whole ladder from
// scratch. The Champion plays at a fixed node budget on the page and during measurement.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { chessCore } from '@duelwise/core/src/games/chess/core'
import { decodeAbs } from '@duelwise/core/src/games/chess/policy-index'
import { makeRng } from '@duelwise/core/src/rng'
import { ladderToElo } from '@duelwise/core/src/elo'
import type { Level } from '@duelwise/core/src/product'
import { commonRoot } from '../../../../scripts/paths'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { Searcher } from '../chess/alphabeta'
import { createGameAgent as createChessAgent, CHAMPION_SEARCH, CHESS_LEVELS } from '../chess/agent'
import { Board, moveToUci } from '../chess/board'
import { ValueNet } from '../chess/value-eval'
import { parseRegistry, type Registry } from '../registry'
import { LEVELS, adjacentPairs } from '../runtime/levels'
import { harnessRuntime, runMatches, type ModuleRef, type GameRecord } from './harness'
import { Z95, publishLadder, wilson, type LadderResult } from './ladder'

const HERE = import.meta.dir
const REPO = join(HERE, '..', '..', '..', '..')
const MODELS = join(REPO, 'apps', 'web', 'public', 'agents', 'chess', 'v1')
const REGISTRY_PATH = join(REPO, 'packages', 'agents', 'registry', 'chess.json')
const THIS_MODULE = join(HERE, 'chess.ts')
const RANDOM_MODULE = join(HERE, 'chess-random.ts')
const TWOPLY_MODULE = join(HERE, 'chess-twoply.ts')
const OPENING_PLIES = 4
const SEED_BASE = 6_000_000

export const SITE_ELO_LABEL = 'site Elo; Stockfish anchor pending until T43'

// ---- agents and cores the child processes load by module path ----

/** A chess core whose start position is 4 seeded random plies in, so deterministic agents do not replay one game. Seeds 2k and 2k+1 share an opening: the pair of colour-swapped games. */
export function createOpeningCore(): typeof chessCore {
  return {
    ...chessCore,
    init(seed, opts) {
      if (opts?.fen) return chessCore.init(seed, opts)
      for (let attempt = 0; ; attempt++) {
        const rng = makeRng(Math.floor(seed / 2) * 131 + attempt)
        let s = chessCore.init(seed)
        for (let i = 0; i < OPENING_PLIES && !chessCore.terminal(s); i++) {
          const seat = chessCore.toAct(s)[0]!
          const legal = chessCore.legal(s, seat)
          const m = legal[rng.int(legal.length)]!
          s = chessCore.step(s, seat === 0 ? [m, null] : [null, m])
        }
        if (!chessCore.terminal(s)) return s
      }
    },
  }
}

/** The shipped chess agent; the Champion searches a fixed node budget from CHESS_NODE_BUDGET (set by this script) instead of a time cap. */
export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const nodes = Number(process.env.CHESS_NODE_BUDGET)
  if (level === 'champion' && !(nodes > 0)) throw new Error('chess measurement: set CHESS_NODE_BUDGET (run the calibrate stage first)')
  return createChessAgent(level, level === 'champion' ? { ...opts, search: { nodeBudget: nodes, timeCapMs: undefined } } : opts)
}

const OPENING_CORE: ModuleRef = { module: THIS_MODULE, export: 'createOpeningCore' }
const agentRef = (level: Level) => ({ level, module: THIS_MODULE })

// ---- stage files ----

let outDir: string | null = null
function out(name: string): string {
  if (outDir === null) {
    outDir = join(commonRoot(), 'data', 'cache', 'chess', 'measure')
    mkdirSync(outDir, { recursive: true })
  }
  return join(outDir, name)
}
const readJson = <T>(name: string): T | null => (existsSync(out(name)) ? (JSON.parse(readFileSync(out(name), 'utf8')) as T) : null)
const writeJson = (name: string, value: unknown): void => writeFileSync(out(name), JSON.stringify(value, null, 1) + '\n')
const round = (x: number): number => Math.round(x * 1e6) / 1e6
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

interface Stamped<T> {
  fingerprint: string
  entries: Record<string, T>
}

/** Folders whose working tree decides every measured number: the agents (search, nets, measurement) and the core (sims, rng). */
const TREE_PATHS = ['packages/agents', 'packages/core']
/** The registry is the output of publish, not an input of any game. */
const TREE_EXCLUDE = ['packages/agents/registry/']

/** sha256 over the content of every tracked or untracked (not ignored) file under `paths`, uncommitted edits included. */
export function workingTreeHash(repo: string = REPO, paths: string[] = TREE_PATHS, exclude: string[] = TREE_EXCLUDE): string {
  const r = spawnSync('git', ['-C', repo, 'ls-files', '-z', '-c', '-o', '--exclude-standard', '--', ...paths], { maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error('working tree hash: git ls-files failed')
  const files = [...new Set(r.stdout.toString().split('\0').filter(Boolean))].filter((f) => !exclude.some((x) => f.startsWith(x))).sort()
  const h = createHash('sha256')
  for (const f of files) {
    const abs = join(repo, f)
    h.update(f + '\0' + (existsSync(abs) ? sha(abs) : 'deleted') + '\n')
  }
  return h.digest('hex')
}

/** Publishing from uncommitted code would stamp a commit that cannot reproduce the numbers: refuse. */
export function assertCleanTree(repo: string = REPO, paths: string[] = ['.']): void {
  const r = spawnSync('git', ['-C', repo, 'status', '--porcelain', '--', ...paths])
  if (r.status !== 0) throw new Error('git status failed')
  const dirty = r.stdout.toString().trim()
  if (dirty) throw new Error('refusing to publish from a dirty tree, commit first:\n' + dirty)
}

export interface FingerprintInputs {
  modelsDir: string
  levels: unknown
  search: unknown
  code: string
}

/** What a locally cached result depends on: the model files, the level and Champion search config, the working-tree hash of packages/agents and packages/core, the node budget, and the opening and seed settings. */
export function measureFingerprint(nodeBudget: number, inputs?: FingerprintInputs): string {
  const { modelsDir, levels, search, code } = inputs ?? { modelsDir: MODELS, levels: CHESS_LEVELS, search: CHAMPION_SEARCH, code: workingTreeHash() }
  const files = ['value.bin', ...Object.values(CHESS_LEVELS).map((c) => `policy-${c.band}.onnx`)]
  const parts = files.map((f) => `${f}=${existsSync(join(modelsDir, f)) ? sha(join(modelsDir, f)) : 'absent'}`)
  parts.push(`levels=${JSON.stringify(levels)}`, `search=${JSON.stringify(search)}`, `tree=${code}`)
  parts.push(`nodeBudget=${nodeBudget}`, `openingPlies=${OPENING_PLIES}`, `seedBase=${SEED_BASE}`)
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

/** Cached entries from a stamped stage file; empty when the file is missing, in the old unstamped format, or stamped with a different fingerprint. */
export function entriesFor<T>(raw: unknown, fingerprint: string): Record<string, T> {
  const r = raw as Partial<Stamped<T>> | null
  return r && r.fingerprint === fingerprint && r.entries && typeof r.entries === 'object' ? { ...r.entries } : {}
}

export type MeasureMode = 'local' | 'publish'

/** A stage's result store. Local mode reads and writes a stamped file; publish mode is memory only, so no earlier result can reach a published number. */
export class StageCache<T> {
  entries: Record<string, T>
  constructor(private file: string | null, private fingerprint: string, existing: unknown) {
    this.entries = file ? entriesFor<T>(existing, fingerprint) : {}
  }
  set(key: string, value: T): void {
    this.entries[key] = value
    if (this.file) writeFileSync(this.file, JSON.stringify({ fingerprint: this.fingerprint, entries: this.entries }, null, 1) + '\n')
  }
}

export function cacheFor<T>(mode: MeasureMode, name: string, fingerprint: string, dir?: string): StageCache<T> {
  if (mode === 'publish') return new StageCache<T>(null, fingerprint, null)
  const file = dir ? join(dir, name) : out(name)
  return new StageCache<T>(file, fingerprint, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null)
}

/** Levels whose model files are published: Champion needs the value net, the rest a policy net. */
export function availableLevels(): Level[] {
  return LEVELS.filter((l) => (l === 'champion' ? existsSync(join(MODELS, 'value.bin')) : existsSync(join(MODELS, `policy-${CHESS_LEVELS[l].band}.onnx`))))
}

const netOf = (): ValueNet => new ValueNet(new Uint8Array(readFileSync(join(MODELS, 'value.bin'))))

/** Mid-game positions from seeded random games, the same on every run. */
export function samplePositions(count: number, seed = 5): string[] {
  const rng = makeRng(seed)
  const out: string[] = []
  const core = createOpeningCore()
  for (let g = 0; out.length < count; g++) {
    let s = core.init(2 * g)
    for (let ply = 0; ply < 60 && !core.terminal(s) && out.length < count; ply++) {
      if (ply >= 8 && ply % 4 === 0) out.push(s.fen)
      const seat = core.toAct(s)[0]!
      const legal = core.legal(s, seat)
      const m = legal[rng.int(legal.length)]!
      s = core.step(s, seat === 0 ? [m, null] : [null, m])
    }
  }
  return out
}

// ---- calibrate and timing ----

interface Calibration {
  nodeBudget: number
  [k: string]: unknown
}

function calibrate(): Calibration {
  const net = netOf()
  const fens = samplePositions(12)
  const per = fens.map((fen) => {
    const r = new Searcher(net, 20).search(fen, { timeCapMs: 1000 })
    return { nodes: r.nodes, ms: r.elapsedMs, depth: r.depth }
  })
  const nps = per.map((p) => (p.nodes / p.ms) * 1000).sort((a, b) => a - b)
  const median = nps[Math.floor(nps.length / 2)]!
  const nodeBudget = Math.round(median / 500) * 500
  const result = { nodeBudget, medianNodesPerSecond: Math.round(median), positions: fens.length, loadAverage1m: round(loadavg()[0]!), cores: navigator.hardwareConcurrency, at: new Date().toISOString(), per }
  console.log(`node budget ${nodeBudget} (median ${Math.round(median)} nodes/s, load average ${result.loadAverage1m})`)
  return result
}

function timing(): Record<string, unknown> {
  const net = netOf()
  const searcher = new Searcher(net, 20)
  const ms: number[] = []
  for (const fen of samplePositions(40, 9)) {
    const r = searcher.search(fen, { ...CHAMPION_SEARCH })
    ms.push(r.elapsedMs)
  }
  ms.sort((a, b) => a - b)
  const result = { nodeBudget: CHAMPION_SEARCH.nodeBudget, positions: ms.length, maxMs: Math.round(ms[ms.length - 1]!), p95Ms: Math.round(ms[Math.floor(ms.length * 0.95)]!), medianMs: Math.round(ms[ms.length >> 1]!), loadAverage1m: round(loadavg()[0]!), at: new Date().toISOString() }
  console.log(JSON.stringify(result))
  return result
}

// ---- puzzles ----

interface Puzzle {
  id: string
  fen: string
  moves: string[]
  rating: number
  band: number
}
interface PuzzleFile {
  bands: Array<[number, number]>
  puzzles: Puzzle[]
}
export interface BandAccuracy {
  band: [number, number]
  n: number
  solved: number
  accuracy: number
  ci95: [number, number]
}

const canon = (u: string): string => (u.length === 5 && u[4] === 'q' ? u.slice(0, 4) : u)

/** True when the agent plays every one of the solver's moves (or any mating move, as on Lichess). */
export async function solvesPuzzle(agent: PreviewAgent, p: Puzzle, seed: number): Promise<boolean> {
  agent.reset(seed)
  let s = chessCore.init(0, { fen: p.fen })
  const play = (uci: string): void => {
    const seat = chessCore.toAct(s)[0]!
    s = chessCore.step(s, seat === 0 ? [uci, null] : [null, uci])
  }
  play(canon(p.moves[0]!))
  for (let i = 1; i < p.moves.length; i += 2) {
    if (chessCore.terminal(s)) return false
    const seat = chessCore.toAct(s)[0]!
    const [code] = await agent.act(chessCore.observe(s, seat), s)
    const uci = decodeAbs(code!)
    const want = canon(p.moves[i]!)
    if (uci !== want) {
      // Another move that mates is as good as the one in the line.
      const b = Board.fromFen(s.fen)
      const m = b.parseUci(uci)
      if (m < 0) return false
      b.make(m)
      return b.legalMoves().length === 0 && b.inCheck()
    }
    play(uci)
    if (i + 1 < p.moves.length) play(canon(p.moves[i + 1]!))
  }
  return true
}

type PuzzleResult = { perBand: number; bands: BandAccuracy[]; overall: BandAccuracy }

/** The puzzle set itself (data/cache/chess/puzzles.json, built by trainer.chess.puzzles from the CC0 Lichess dump) is an input, not a cached result. */
async function puzzles(perBand: number, nodeBudget: number | undefined, mode: MeasureMode): Promise<Record<string, PuzzleResult>> {
  const file = JSON.parse(readFileSync(join(commonRoot(), 'data', 'cache', 'chess', 'puzzles.json'), 'utf8')) as PuzzleFile
  if (nodeBudget) process.env.CHESS_NODE_BUDGET = String(nodeBudget)
  const store = cacheFor<PuzzleResult>(mode, 'puzzles.json', measureFingerprint(nodeBudget ?? 0))
  const all = store.entries
  for (const level of availableLevels()) {
    if (all[level]?.perBand === perBand) continue
    if (level === 'champion' && !nodeBudget) throw new Error('run the calibrate stage before the puzzle stage')
    const agent = await createGameAgent(level, { seat: 0 })
    const solved = file.bands.map(() => 0)
    const seen = file.bands.map(() => 0)
    for (const b of file.bands.keys()) {
      const mine = file.puzzles.filter((p) => p.band === b).slice(0, perBand)
      for (let i = 0; i < mine.length; i++) {
        seen[b]!++
        if (await solvesPuzzle(agent, mine[i]!, 7000 + i)) solved[b]!++
      }
    }
    agent.dispose()
    const mk = (band: [number, number], n: number, k: number): BandAccuracy => ({ band, n, solved: k, accuracy: round(k / n), ci95: wilson(k, n, Z95).map(round) as [number, number] })
    const bands = file.bands.map((band, i) => mk(band, seen[i]!, solved[i]!))
    const overall = mk([file.bands[0]![0], file.bands[file.bands.length - 1]![1]], seen.reduce((a, b) => a + b, 0), solved.reduce((a, b) => a + b, 0))
    store.set(level, { perBand, bands, overall })
    console.log(level, bands.map((b) => `${b.band[0]}-${b.band[1]}: ${b.solved}/${b.n}`).join('  '), 'overall', overall.accuracy)
  }
  return all
}

// ---- ladder ----

export const CHESS_GAMES_PER_SEAT = 400

/** Each seat has its own sample and confidence bound, so a strong average cannot hide a weak colour. */
export function chessSeatGate(games: Array<Pick<GameRecord, 'seatOfA' | 'scoreA'>>, floor: number) {
  const bySeat = ([0, 1] as const).map((seat) => {
    const rows = games.filter((g) => g.seatOfA === seat)
    const points = rows.reduce((sum, g) => sum + g.scoreA, 0)
    return { seat, n: rows.length, points, ci95: wilson(points, rows.length) }
  })
  return { bySeat, passed: bySeat.every((x) => x.n >= CHESS_GAMES_PER_SEAT && x.ci95[0] > floor) }
}

async function ladder(processes: number, nodeBudget: number, mode: MeasureMode): Promise<LadderResult> {
  process.env.CHESS_NODE_BUDGET = String(nodeBudget)
  const available = availableLevels()
  const chain: Level[] = []
  for (const l of LEVELS) { if (!available.includes(l)) break; chain.push(l) }
  if (chain[0] !== 'easy') throw new Error('the ladder needs the Easy policy net')
  const blocks = cacheFor<GameRecord[]>(mode, 'seat-blocks.json', measureFingerprint(nodeBudget))
  const measure = async (key: string, a: Level, b: Level | null) => {
    const games: GameRecord[] = []
    const upperIndex = LEVELS.indexOf(a)
    const base = SEED_BASE + (b === null ? 900_000 : upperIndex * 1_000_000)
    for (let from = 0; from < CHESS_GAMES_PER_SEAT * 2; from += 100) {
      const to = Math.min(from + 100, CHESS_GAMES_PER_SEAT * 2)
      const cacheKey = `${key}:${from}-${to}`
      let block = blocks.entries[cacheKey]
      if (!block) {
        const seeds = Array.from({ length: to - from }, (_, i) => base + from + i)
        const job = { game: 'chess' as const, core: OPENING_CORE, a: agentRef(a), b: b === null ? { level: 'easy' as Level, module: RANDOM_MODULE } : agentRef(b), seeds, firstIndex: from }
        block = (await runMatches(job, { processes })).games
        blocks.set(cacheKey, block)
      }
      games.push(...block)
    }
    const points = games.reduce((sum, g) => sum + g.scoreA, 0)
    const gate = chessSeatGate(games, 0.5)
    return { points, n: games.length, score: points / games.length, ci95: wilson(points, games.length), stoppedEarly: false, passed: gate.passed, bySeat: gate.bySeat }
  }
  const pairs = []
  for (const pair of adjacentPairs(chain)) pairs.push({ ...pair, ...(await measure(`${pair.upper}>${pair.lower}`, pair.upper, pair.lower)) })
  const baseline = { label: 'random legal moves', ...(await measure('easy>random', 'easy', null)) }
  const elo = ladderToElo(pairs.map((p) => ({ lower: p.lower, upper: p.upper, score: p.score })), { level: 'easy', elo: 1000 })
  return { game: 'chess', levels: chain, pairs, baseline, elo }
}

// ---- 2-ply bot gate ----

/** Games Hard plays against the 2-ply material bot (half as each colour) and the score it must reach (judge round 3). */
export const TWOPLY_GAMES = 400
export const TWOPLY_FLOOR = 0.7
const TWOPLY_SEED_BASE = SEED_BASE + 800_000

export interface TwoPlyResult {
  n: number
  points: number
  score: number
  floor: number
  passed: boolean
}

export function twoPlyGate(games: Array<Pick<GameRecord, 'seatOfA' | 'scoreA'>>) {
  const bySeat = ([0, 1] as const).map((seat) => {
    const rows = games.filter((game) => game.seatOfA === seat)
    const points = rows.reduce((sum, game) => sum + game.scoreA, 0)
    return { seat, n: rows.length, points, ci95: wilson(points, rows.length) }
  })
  const points = bySeat.reduce((sum, seat) => sum + seat.points, 0)
  return { bySeat, passed: games.length >= TWOPLY_GAMES && points / games.length >= TWOPLY_FLOOR && bySeat.every((seat) => seat.n >= 200 && seat.points / seat.n >= 0.6) }
}

export function publishChessLadder(reg: Registry, ladder: LadderResult, meta: Parameters<typeof publishLadder>[2], twoPlyPassed: boolean): Registry {
  const failures: Partial<Record<Level, string>> = {}
  if (!ladder.baseline?.passed) failures.easy = 'Easy did not pass the random bot gate'
  if (!twoPlyPassed) failures.hard = 'Hard did not pass the 2-ply bot gate'
  return publishLadder(reg, ladder, { ...meta, failures, allowEmpty: true })
}

/** Hard against the 2-ply bot on the ladder's openings; the bot cannot be a Champion-budget run, so no node budget is needed. */
async function twoPlyCheck(processes: number, games = TWOPLY_GAMES): Promise<TwoPlyResult> {
  const seeds = Array.from({ length: games }, (_, i) => TWOPLY_SEED_BASE + i)
  const job = { game: 'chess' as const, core: OPENING_CORE, a: agentRef('hard'), b: { level: 'hard' as Level, module: TWOPLY_MODULE }, seeds, firstIndex: 0 }
  const played = await runMatches(job, { processes })
  const points = played.scoreA
  const score = points / games
  const gate = twoPlyGate(played.games)
  const out = { n: games, points, score: round(score), floor: TWOPLY_FLOOR, passed: gate.passed, bySeat: gate.bySeat }
  console.log(`hard vs the 2-ply material bot: ${points}/${games}`, out.passed ? 'PASS' : 'FAIL')
  return out
}

// ---- publish ----

function trainedSteps(): number {
  let total = 0
  for (const f of [join(commonRoot(), 'runs', 'chess-value', 'metrics.jsonl'), ...['b1100', 'b1500', 'b1900'].map((b) => join(commonRoot(), 'runs', 'chess-policy', `metrics-${b}.jsonl`))]) {
    if (!existsSync(f)) continue
    let last = 0
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const s = JSON.parse(line).step
        if (typeof s === 'number') last = Math.max(last, s)
      } catch {}
    }
    total += last
  }
  return total
}

/** R17: nothing here reads a stage cache. The tree must be clean, then every number is measured again from the committed code and models. */
async function publish(perBand: number, processes: number): Promise<void> {
  assertCleanTree(REPO, [...TREE_PATHS, 'apps/web/public/agents', ...TREE_EXCLUDE.map((x) => `:(exclude)${x}`)])
  const commit = spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']).stdout.toString().trim()
  // The Champion plays CHAMPION_SEARCH.nodeBudget on the page and in the server check, so that is the budget measured.
  // The calibration only records how long that budget takes on this machine.
  const cal = calibrate()
  const budget = CHAMPION_SEARCH.nodeBudget!
  const tim = timing()
  const pz = await puzzles(perBand, budget, 'publish')
  const lad = await ladder(processes, budget, 'publish')
  const twoPly = await twoPlyCheck(processes)
  const now = new Date().toISOString()
  const artifacts: Record<string, string> = {}
  const sha256: Record<string, string> = {}
  for (const name of ['value.bin', 'value.onnx', ...Object.values(CHESS_LEVELS).map((c) => `policy-${c.band}.onnx`)]) {
    const path = join(MODELS, name)
    if (!existsSync(path)) continue
    artifacts[name] = `apps/web/public/agents/chess/v1/${name}`
    sha256[name] = sha(path)
  }
  const config = (level: Level): Record<string, unknown> =>
    level === 'champion'
      ? { search: 'iterative-deepening PVS, transposition table, quiescence, MVV-LVA', eval: 'value.bin (TS evaluator)', measuredNodeBudget: budget }
      : { net: `policy-${CHESS_LEVELS[level].band}.onnx`, ...CHESS_LEVELS[level] }
  const draft: Registry = {
    game: 'chess',
    champion: 'v1',
    versions: [
      {
        version: 'v1',
        parent: null,
        createdAt: now,
        promotedAt: now,
        status: 'preview',
        artifacts,
        sha256,
        trainedSteps: trainedSteps(),
        humanMatchesUsed: 0,
        gate: null,
      },
    ],
    levels: Object.fromEntries(LEVELS.map((l) => [l, { version: 'v1', config: config(l) }])),
    measured: {},
    unpublished: {},
    unpublishedConfig: {},
    learnsFromHumans: false,
  }
  const measuredLevels = lad.levels
  const reg = publishChessLadder(parseRegistry(draft), lad, { harness: harnessRuntime(), commit, measuredAt: now, version: 'v1' }, twoPly.passed)
  reg.versions[0]!.gate = {
    rule: 'each level plays 400 games per seat against its test bot; each seat must clear the 95% Wilson lower bound gate',
    eloLabel: SITE_ELO_LABEL,
    eloNote: 'Easy is anchored at 1000 and each higher level is the chained gap from its head-to-head score. It is not a Stockfish-anchored or FIDE-comparable rating.',
    championBudget: { calibration: cal, timing: tim, note: 'The Champion plays the same fixed node budget in the ladder, on the page and in the server check, so its measured strength is the strength a player meets.' },
    twoPlyBot: { rule: `Hard against the round-3 judge's 2-ply bot: ${TWOPLY_GAMES} games, 200 per seat, pooled score at least ${TWOPLY_FLOOR} and each seat at least 0.6`, ...twoPly },
    openings: `${OPENING_PLIES} random plies from the start position, shared by the two colour-swapped games of a pair`,
    puzzleAccuracy: Object.keys(pz).length ? pz : null,
    pairs: lad.pairs.map((p) => ({ lower: p.lower, upper: p.upper, n: p.n, points: p.points, score: round(p.score), ci95: p.ci95.map(round), stoppedEarly: p.stoppedEarly, passed: p.passed, bySeat: (p as typeof p & { bySeat?: unknown }).bySeat })),
    baseline: lad.baseline ? { label: lad.baseline.label, n: lad.baseline.n, points: lad.baseline.points, score: round(lad.baseline.score), bySeat: (lad.baseline as typeof lad.baseline & { bySeat?: unknown }).bySeat } : null,
    laddered: measuredLevels,
  }
  writeFileSync(REGISTRY_PATH, JSON.stringify(parseRegistry(reg), null, 2) + '\n')
  console.log('wrote', REGISTRY_PATH, 'unpublished:', JSON.stringify(reg.unpublished))
}

if (import.meta.main) {
  const stage = process.argv[2]
  const flag = (name: string, dflt: number): number => {
    const i = process.argv.indexOf(name)
    return i > 0 ? Number(process.argv[i + 1]) : dflt
  }
  const localBudget = (): number => {
    const cal = readJson<{ nodeBudget: number }>('calibration.json')
    if (!cal) throw new Error('run the calibrate stage first')
    return cal.nodeBudget
  }
  if (stage === 'calibrate') writeJson('calibration.json', calibrate())
  else if (stage === 'timing') writeJson('timing.json', timing())
  else if (stage === 'puzzles') await puzzles(flag('--per-band', 100), readJson<{ nodeBudget: number }>('calibration.json')?.nodeBudget, 'local')
  else if (stage === 'ladder') await ladder(flag('--processes', 2), localBudget(), 'local')
  else if (stage === 'twoply') await twoPlyCheck(flag('--processes', 2), flag('--games', TWOPLY_GAMES))
  else if (stage === 'publish') await publish(flag('--per-band', 100), flag('--processes', 2))
  else {
    console.error('usage: chess.ts calibrate | timing | puzzles [--per-band 100] | ladder [--processes 2] | twoply [--processes 2] | publish [--per-band 100] [--processes 2]')
    process.exit(2)
  }
}
