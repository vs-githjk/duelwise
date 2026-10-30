// Four in a Row measurement (T23). Run from anywhere with absolute paths:
//   bun packages/agents/src/measure/four.ts positions   write packages/agents/eval/four-positions.json (1,000 positions solved by the TS solver)
//   bun packages/agents/src/measure/four.ts rates       solver-optimal and value-hold rate per level on those positions
//   bun packages/agents/src/measure/four.ts timing      Champion seconds per move
//   bun packages/agents/src/measure/four.ts sitecheck  Champion (seat 1) vs Hard from the empty board, and the 60-seed replay of the judge's line
//   bun packages/agents/src/measure/four.ts ladder      adjacent-level games (interim looks 100 and 200, cap 400, at most 2 processes)
//   bun packages/agents/src/measure/four.ts publish     clean tree only: measure everything fresh, write packages/agents/registry/four.json
// Every level plays a fixed number of simulations (the Champion 800), never a time cap, so the numbers do not depend on
// machine load; the shipped Champion also has a 1.4 s safety cap that cuts search short on slow devices, where it
// searches less than the 800 simulations measured here, so the measured strength is an UPPER bound for the shipped
// Champion wherever the cap binds (the timing stage records the share of moves that hit it). Local stage results are for iteration only and `publish` never reads them (R17), exactly as in chess.ts.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { COLS, fourFromMoves } from '@duelwise/core/src/games/four/rules'
import { solve } from '@duelwise/core/src/games/four/solver'
import { makeRng } from '@duelwise/core/src/rng'
import type { Level } from '@duelwise/core/src/product'
import { commonRoot } from '../../../../scripts/paths'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { createGameAgent as createFourAgent, FOUR_LEVELS } from '../four/agent'
import { parseRegistry, type Registry } from '../registry'
import { LEVELS, pairBudget } from '../runtime/levels'
import { assertCleanTree, cacheFor, workingTreeHash, type MeasureMode } from './chess'
import { harnessPlayPair, harnessRuntime, runMatches, type ModuleRef } from './harness'
import { Z95, publishLadder, runLadder, wilson, type LadderResult } from './ladder'
import { GREEDY_SEEDS } from './four-greedy'
import { CHAMPION_LINE, REPLAY_SEED_SETS, REPLAY_WIN_LIMIT } from './four-replay'

const HERE = import.meta.dir
const REPO = join(HERE, '..', '..', '..', '..')
const PUBLIC = join(REPO, 'apps', 'web', 'public')
/** Where a level's model file is on disk: the folder its config names (default v1). */
const modelFile = (level: Level): string => join(PUBLIC, FOUR_LEVELS[level].base ?? '/agents/four/v1', FOUR_LEVELS[level].model)
const EVAL = join(REPO, 'packages', 'agents', 'eval')
const POSITIONS_PATH = join(EVAL, 'four-positions.json')
const SNAPSHOTS_PATH = join(EVAL, 'four-snapshots.json')
const REGISTRY_PATH = join(REPO, 'packages', 'agents', 'registry', 'four.json')
const THIS_MODULE = join(HERE, 'four.ts')
const RANDOM_MODULE = join(HERE, 'four-random.ts')
const OPENING_PLIES = 2
const SITE_SEAT_GAMES = 60
const SITE_SEAT_SEED_BASE = 9_000_000
const REPLAY_MODULE = join(HERE, 'four-replay.ts')
const SEED_BASE = 4_000_000
const POSITION_SEED = 2323
const POSITION_COUNT = 1000
const TREE_PATHS = ['packages/agents', 'packages/core']
const TREE_EXCLUDE = ['packages/agents/registry/']

// ---- agents and cores the child processes load by module path ----

/** A Four in a Row core whose start position is 2 seeded random plies in, so deterministic agents do not replay one game. Seeds 2k and 2k+1 share an opening: the pair of colour-swapped games. */
export function createOpeningCore(): typeof fourCore {
  return {
    ...fourCore,
    init(seed, opts) {
      const rng = makeRng(Math.floor(seed / 2) * 131 + 7)
      let s = fourCore.init(seed, opts)
      for (let i = 0; i < OPENING_PLIES; i++) {
        const seat = fourCore.toAct(s)[0]!
        const legal = fourCore.legal(s, seat)
        const m = legal[rng.int(legal.length)]!
        s = fourCore.step(s, seat === 0 ? [m, null] : [null, m])
      }
      return s
    },
  }
}

/** The shipped Four in a Row agent with its levels' simulation counts and no time cap. */
export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  return createFourAgent(level, { ...opts, search: { timeCapMs: undefined } })
}

const OPENING_CORE: ModuleRef = { module: THIS_MODULE, export: 'createOpeningCore' }
const agentRef = (level: Level) => ({ level, module: THIS_MODULE })

// ---- test positions solved by the TS solver ----

export interface SolvedPosition {
  /** Columns played from the empty board; the side to move is moves.length % 2. */
  moves: number[]
  /** Exact solver score for the side to move (positive: a win by that margin, 0 draw, negative loss). */
  score: number
  /** Columns that reach the exact score: the fastest win, or the slowest loss. */
  optimalMoves: number[]
  /** Columns that keep the game-theoretic outcome (win, draw or loss), the weak solve. */
  holdMoves: number[]
}

export function positionsHash(positions: readonly SolvedPosition[]): string {
  return createHash('sha256').update(JSON.stringify(positions)).digest('hex')
}

/** Positions after 12 to 34 seeded random moves (not finished), deduplicated, in a fixed order. */
export function generatePositions(count: number = POSITION_COUNT, seed: number = POSITION_SEED): SolvedPosition[] {
  const rng = makeRng(seed)
  const seen = new Set<string>()
  const out: SolvedPosition[] = []
  while (out.length < count) {
    const length = 12 + rng.int(23)
    const moves: number[] = []
    let s = fourCore.init(0)
    while (moves.length < length && !fourCore.terminal(s)) {
      const seat = fourCore.toAct(s)[0]!
      const legal = fourCore.legal(s, seat)
      const m = legal[rng.int(legal.length)]!
      moves.push(m)
      s = fourCore.step(s, seat === 0 ? [m, null] : [null, m])
    }
    const key = moves.join('')
    if (fourCore.terminal(s) || seen.has(key)) continue
    seen.add(key)
    const exact = solve(s)
    const weak = solve(s, { weak: true })
    out.push({ moves, score: exact.score, optimalMoves: exact.bestMoves, holdMoves: weak.bestMoves })
  }
  return out
}

/** Share of positions where the move is a solver-optimal one, and where it keeps the outcome. */
export function optimalRates(positions: readonly SolvedPosition[], moves: readonly number[]): { optimal: number; hold: number; n: number } {
  let optimal = 0
  let hold = 0
  positions.forEach((p, i) => {
    if (p.optimalMoves.includes(moves[i]!)) optimal++
    if (p.holdMoves.includes(moves[i]!)) hold++
  })
  return { optimal: optimal / positions.length, hold: hold / positions.length, n: positions.length }
}

function loadPositions(): { count: number; hash: string; positions: SolvedPosition[] } {
  const file = JSON.parse(readFileSync(POSITIONS_PATH, 'utf8')) as { count: number; hash: string; positions: SolvedPosition[] }
  if (positionsHash(file.positions) !== file.hash) throw new Error('four-positions.json does not match its hash')
  return file
}

// ---- stage helpers ----

const round = (x: number): number => Math.round(x * 1e6) / 1e6
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const localDir = (): string => {
  const d = join(commonRoot(), 'data', 'cache', 'four', 'measure')
  mkdirSync(d, { recursive: true })
  return d
}

export interface LevelRates {
  level: Level
  n: number
  optimal: number
  optimalCi95: [number, number]
  hold: number
  holdCi95: [number, number]
  sims: number
}

async function levelRates(level: Level, positions: readonly SolvedPosition[]): Promise<LevelRates> {
  const agent = await createGameAgent(level, { seat: 0 })
  const moves: number[] = []
  for (const [i, p] of positions.entries()) {
    const s = fourFromMoves(p.moves)
    agent.reset(7000 + i)
    moves.push((await agent.act(fourCore.observe(s, fourCore.toAct(s)[0]!), s))[0]!)
  }
  agent.dispose()
  const r = optimalRates(positions, moves)
  const ci = (rate: number) => wilson(rate * r.n, r.n, Z95).map(round) as [number, number]
  const out = { level, n: r.n, optimal: round(r.optimal), optimalCi95: ci(r.optimal), hold: round(r.hold), holdCi95: ci(r.hold), sims: FOUR_LEVELS[level].sims }
  console.log(`${level}: optimal ${out.optimal} ${JSON.stringify(out.optimalCi95)}, value-hold ${out.hold} ${JSON.stringify(out.holdCi95)} over ${r.n} positions`)
  return out
}

async function allRates(positions: readonly SolvedPosition[]): Promise<LevelRates[]> {
  const out: LevelRates[] = []
  for (const level of LEVELS) out.push(await levelRates(level, positions))
  return out
}

/** Site-reachable 13-stone positions where the weak solver is slowest (7 to 26 million nodes), so the timing sample covers the tail the every-25th sample misses. */
const SLOW_TAIL = ['2100256265552', '2100256265556', '2100256265554'] as const

/** Champion decision time: the 800 simulations the ladder measures, and the shipped agent with its 1.4 s cap. */
async function timing(positions: readonly SolvedPosition[]): Promise<Record<string, unknown>> {
  const sample = [...positions.filter((_, i) => i % 25 === 0), ...SLOW_TAIL.map((m) => ({ moves: [...m].map(Number) }) as SolvedPosition)]
  const run = async (agent: PreviewAgent): Promise<number[]> => {
    const ms: number[] = []
    for (const [i, p] of sample.entries()) {
      const s = fourFromMoves(p.moves)
      agent.reset(i)
      const t = performance.now()
      await agent.act(fourCore.observe(s, fourCore.toAct(s)[0]!), s)
      ms.push(performance.now() - t)
    }
    agent.dispose()
    return ms.sort((a, b) => a - b)
  }
  const stat = (ms: number[]) => ({ positions: ms.length, medianMs: Math.round(ms[ms.length >> 1]!), p95Ms: Math.round(ms[Math.floor(ms.length * 0.95)]!), maxMs: Math.round(ms[ms.length - 1]!) })
  const uncapped = stat(await run(await createGameAgent('champion', { seat: 0 })))
  const shippedMs = await run(await createFourAgent('champion', { seat: 0 }))
  const shipped = stat(shippedMs)
  const capMs = FOUR_LEVELS.champion.timeCapMs!
  // A move "hit the cap" when it ran to within 2% of it; search ended early there, so those moves had fewer than 800 simulations.
  const shippedCapHitShare = round(shippedMs.filter((m) => m >= capMs * 0.98).length / shippedMs.length)
  const result = { sims: FOUR_LEVELS.champion.sims, uncapped, shippedTimeCapMs: capMs, shipped, shippedCapHitShare, loadAverage1m: round(loadavg()[0]!), at: new Date().toISOString() }
  console.log(JSON.stringify(result))
  return result
}

// ---- ladder ----

function fingerprint(): string {
  const parts = LEVELS.map((l) => `${l}=${existsSync(modelFile(l)) ? sha(modelFile(l)) : 'absent'}`)
  parts.push(`levels=${JSON.stringify(FOUR_LEVELS)}`, `tree=${workingTreeHash(REPO, TREE_PATHS, TREE_EXCLUDE)}`, `openingPlies=${OPENING_PLIES}`, `seedBase=${SEED_BASE}`)
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

async function ladder(processes: number, mode: MeasureMode): Promise<LadderResult> {
  const blocks = cacheFor<number>(mode, 'blocks.json', fingerprint(), mode === 'local' ? localDir() : undefined)
  const cached = (key: string, play: () => Promise<number>) => async (): Promise<number> => {
    if (blocks.entries[key] !== undefined) return blocks.entries[key]!
    const v = await play()
    blocks.set(key, v)
    return v
  }
  const base = { game: 'four' as const, core: OPENING_CORE, agentFor: agentRef, processes, seedBase: SEED_BASE }
  const pairPlay = harnessPlayPair(base)
  const result = await runLadder({
    game: 'four',
    levels: [...LEVELS],
    budget: pairBudget('four'),
    playPair: (pair, from, to) => cached(`${pair.upper}>${pair.lower}:${from}-${to}`, () => pairPlay(pair, from, to))(),
    baseline: {
      label: 'random legal moves',
      play: (from, to) =>
        cached(`easy>random:${from}-${to}`, async () => {
          const seeds = Array.from({ length: to - from }, (_, i) => SEED_BASE + 900_000 + from + i)
          const job = { game: 'four' as const, core: OPENING_CORE, a: agentRef('easy'), b: { level: 'easy' as Level, module: RANDOM_MODULE }, seeds, firstIndex: from }
          return (await runMatches(job, { processes })).scoreA
        })(),
    },
  })
  for (const p of result.pairs) console.log(`${p.upper} vs ${p.lower}: ${p.points}/${p.n}`, p.ci95.map((x) => x.toFixed(3)), p.passed ? 'PASS' : 'FAIL', p.stoppedEarly ? '(stopped at interim look)' : '')
  if (result.baseline) console.log(`easy vs random: ${result.baseline.points}/${result.baseline.n}`)
  console.log('site Elo', JSON.stringify(result.elo))
  return result
}

// ---- the two site-play checks (judge round 2) ----
// The ladder starts every game 2 random plies in, so the Champion's reply to the human's first stone is never measured. On the site the
// human is seat 0 and moves first from the empty board, so these two checks play exactly that.

/** Splits the seeds over `processes` child bun processes running four-replay.ts, and returns each child's JSON field. */
function runChildren(processes: number, head: string[], seeds: number[], field: 'wins' | 'points' | 'notWins'): Promise<number[]> {
  const chunks = Array.from({ length: processes }, (_, p) => seeds.filter((_, i) => i % processes === p)).filter((c) => c.length > 0)
  return Promise.all(
    chunks.map(
      (chunk) =>
        new Promise<number>((resolve, reject) => {
          const child = spawn('bun', [REPLAY_MODULE, ...head, chunk.join(',')])
          let out = ''
          let err = ''
          child.stdout.on('data', (d) => (out += d))
          child.stderr.on('data', (d) => (err += d))
          child.on('close', (code) => {
            if (code !== 0) reject(new Error(`four-replay child failed: ${err}`))
            else resolve((JSON.parse(out.trim().split('\n').pop()!) as Record<string, number>)[field]!)
          })
        }),
    ),
  )
}

export interface SiteSeatResult {
  games: number
  points: number
  score: number
  ci95: [number, number]
  passed: boolean
}

/** The Champion as seat 1 against Hard as seat 0 from the empty board (no random opening plies), Hard and Champion at their shipped simulation counts. Passes when the Champion's 95% Wilson lower bound is above 50%. */
async function siteSeat(processes: number): Promise<SiteSeatResult> {
  const seeds = Array.from({ length: SITE_SEAT_GAMES }, (_, i) => SITE_SEAT_SEED_BASE + i)
  const points = (await runChildren(processes, ['siteseat'], seeds, 'points')).reduce((x, y) => x + y, 0)
  const ci = wilson(points, seeds.length, Z95).map(round) as [number, number]
  const out = { games: seeds.length, points, score: round(points / seeds.length), ci95: ci, passed: ci[0] > 0.5 }
  console.log(`site seat (empty board, champion seat 1) vs hard: ${points}/${seeds.length}`, ci, out.passed ? 'PASS' : 'FAIL')
  return out
}

export interface ReplayResult {
  line: string
  games: number
  humanWins: number
  limit: number
  passed: boolean
}

/** A blind replay of the judge's winning Champion line over 60 seeds (3 independent sets). Passes when the human wins fewer than REPLAY_WIN_LIMIT of them. */
async function replayCheck(processes: number): Promise<ReplayResult> {
  const seeds = REPLAY_SEED_SETS.flat()
  const counts = await runChildren(processes, ['replay', 'champion', CHAMPION_LINE], seeds, 'wins')
  const humanWins = counts.reduce((a, b) => a + b, 0)
  const out = { line: CHAMPION_LINE, games: seeds.length, humanWins, limit: REPLAY_WIN_LIMIT, passed: humanWins < REPLAY_WIN_LIMIT }
  console.log(`replay of the judge's Champion line: human won ${humanWins}/${seeds.length}`, out.passed ? 'PASS' : 'FAIL')
  return out
}

export interface GreedyResult {
  games: number
  notWins: number
  passed: boolean
}

/** The Champion against the 1-ply greedy bot (win, block, else centre-first), 20 games in each seat. Passes only when it wins all 40 (judge round 2). */
async function greedyCheck(processes: number): Promise<GreedyResult> {
  const notWins = (await runChildren(processes, ['greedy', 'champion'], GREEDY_SEEDS, 'notWins')).reduce((a, b) => a + b, 0)
  const out = { games: GREEDY_SEEDS.length, notWins, passed: notWins === 0 }
  console.log(`champion vs the 1-ply greedy bot: ${GREEDY_SEEDS.length - notWins}/${GREEDY_SEEDS.length} won`, out.passed ? 'PASS' : 'FAIL')
  return out
}

// ---- publish ----

/** R17: nothing here reads a stage cache. The tree must be clean, then every number is measured again from the committed code and models. */
async function publish(processes: number): Promise<void> {
  assertCleanTree(REPO, [...TREE_PATHS, 'apps/web/public/agents/four', ...TREE_EXCLUDE.map((x) => `:(exclude)${x}`)])
  const commit = spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']).stdout.toString().trim()
  const { positions, hash } = loadPositions()
  const rates = await allRates(positions)
  const tim = await timing(positions)
  const lad = await ladder(processes, 'publish')
  const seat = await siteSeat(processes)
  const rep = await replayCheck(processes)
  const greedy = await greedyCheck(processes)
  if (!seat.passed || !rep.passed || !greedy.passed) throw new Error(`site-play checks failed, nothing written: siteSeat ${JSON.stringify(seat)} replay ${JSON.stringify(rep)} greedy ${JSON.stringify(greedy)}`)
  const now = new Date().toISOString()
  const snaps = JSON.parse(readFileSync(SNAPSHOTS_PATH, 'utf8')) as { levels: Record<Level, { snapshot: string; games: number; steps: number; sha256: string }>; snapshots: unknown[]; rule: string }
  // The learning-loop lineage lives in the registry already: v1 (the self-play snapshots) and v2 (the promoted Champion retrain).
  // A republish re-measures everything and keeps both versions; the live Champion is whatever the registry names (a test pins the loader to it).
  const prior = parseRegistry(JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')))
  const liveChampion = prior.champion
  const priorV1 = prior.versions.find((v) => v.version === 'v1')
  const lineage = prior.versions.filter((v) => v.version !== 'v1')
  const v1Dir = '/agents/four/v1'
  const artifacts: Record<string, string> = {}
  const sha256: Record<string, string> = {}
  for (const level of LEVELS) {
    // Version v1 is the self-play snapshots: its own files, whatever the live Champion is.
    const name = level === 'champion' ? 'champion.onnx' : FOUR_LEVELS[level].model
    artifacts[level] = `apps/web/public${v1Dir}/${name}`
    sha256[level] = sha(join(PUBLIC, v1Dir, name))
    if (sha256[level] !== snaps.levels[level].sha256) throw new Error(`${name} is not the checkpoint four-snapshots.json picked`)
  }
  const config = (level: Level): Record<string, unknown> => {
    const base = { ...FOUR_LEVELS[level], snapshot: snaps.levels[level].snapshot, selfPlayGames: snaps.levels[level].games }
    // A level served by a later version keeps the lineage fields that version's promotion wrote (snapshot, selfPlayGames, retrainOf).
    const live = prior.levels[level]
    return live && live.version !== 'v1' ? { ...base, ...Object.fromEntries(Object.entries(live.config).filter(([k]) => !(k in FOUR_LEVELS[level]))) } : base
  }
  const draft: Registry = {
    game: 'four',
    champion: 'v1',
    versions: [
      {
        version: 'v1',
        parent: null,
        createdAt: priorV1?.createdAt ?? now,
        promotedAt: priorV1?.promotedAt ?? now,
        status: 'preview',
        artifacts,
        sha256,
        trainedSteps: snaps.levels.champion.steps,
        humanMatchesUsed: 0,
        gate: null,
      },
    ],
    levels: Object.fromEntries(LEVELS.map((l) => [l, { version: 'v1', config: config(l) }])),
    measured: {},
    unpublished: {},
    unpublishedConfig: {},
    learnsFromHumans: true,
  }
  const reg = publishLadder(parseRegistry(draft), lad, { harness: harnessRuntime(), commit, measuredAt: now, version: 'v1' })
  reg.versions[0]!.gate = {
    rule: 'adjacent levels: the stronger level scores above 50% against the weaker with a 95% Wilson lower bound; interim looks at 100 and 200 games stop early only on a 99% lower bound above 50%; cap 400 games',
    eloLabel: 'site Elo; Easy anchored at 1000, each higher level is the chained gap from its head-to-head score',
    openings: `${OPENING_PLIES} random plies from the empty board, shared by the two colour-swapped games of a pair`,
    simulations: 'every level plays a fixed number of simulations (Champion 800), never a time cap; the shipped Champion also has a time cap that cuts search short where it binds, so the measured strength is an upper bound for the shipped Champion there (timing.shippedCapHitShare is the share of sampled moves that hit the cap)',
    checkpointRule: snaps.rule,
    championVersion: liveChampion,
    solverPositions: { count: positions.length, hash, source: 'packages/agents/eval/four-positions.json, solved by packages/core/src/games/four/solver.ts', perLevel: rates },
    timing: tim,
    siteSeat: { rule: 'Champion as seat 1 against Hard as seat 0 from the empty board, the only way the site plays; 95% Wilson lower bound above 50%', ...seat },
    replay: { rule: `a blind replay of the judge's winning Champion line over 60 seeds (3 independent sets); the human wins fewer than ${REPLAY_WIN_LIMIT}`, ...rep },
    greedy: { rule: 'Champion against a 1-ply bot that takes a win, blocks, else plays the centre-most column: 20 games in each seat, it must win all 40', ...greedy },
    pairs: lad.pairs.map((p) => ({ lower: p.lower, upper: p.upper, n: p.n, points: p.points, score: round(p.score), ci95: p.ci95.map(round), stoppedEarly: p.stoppedEarly, passed: p.passed })),
    baseline: lad.baseline ? { label: lad.baseline.label, n: lad.baseline.n, points: lad.baseline.points, score: round(lad.baseline.score), ci95: lad.baseline.ci95.map(round) } : null,
  }
  // Put the lineage back: later versions as promoted (their own gate stays the record of their promotion), served levels on them.
  reg.versions.push(...lineage)
  reg.champion = liveChampion
  for (const level of LEVELS) {
    const served = prior.levels[level]
    if (reg.levels[level] && served && served.version !== 'v1') reg.levels[level] = { version: served.version, config: reg.levels[level]!.config }
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
  if (stage === 'positions') {
    const positions = generatePositions()
    mkdirSync(EVAL, { recursive: true })
    writeFileSync(POSITIONS_PATH, JSON.stringify({ count: positions.length, seed: POSITION_SEED, hash: positionsHash(positions), positions }) + '\n')
    const wins = positions.filter((p) => p.score > 0).length
    const losses = positions.filter((p) => p.score < 0).length
    console.log(`wrote ${positions.length} positions: ${wins} won, ${positions.length - wins - losses} drawn, ${losses} lost for the side to move; columns ${COLS}`)
  } else if (stage === 'rates') await allRates(loadPositions().positions)
  else if (stage === 'timing') await timing(loadPositions().positions)
  else if (stage === 'sitecheck') {
    const seat = await siteSeat(flag('--processes', 2))
    const rep = await replayCheck(flag('--processes', 2))
    const greedy = await greedyCheck(flag('--processes', 2))
    console.log(JSON.stringify({ seat, rep, greedy }))
  } else if (stage === 'ladder') await ladder(flag('--processes', 2), 'local')
  else if (stage === 'publish') await publish(flag('--processes', 2))
  else {
    console.error('usage: four.ts positions | rates | timing | sitecheck | ladder [--processes 2] | publish [--processes 2]')
    process.exit(2)
  }
}
