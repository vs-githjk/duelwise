// Heads-up hold'em measurement and strategy export (T28). Run with absolute paths:
//   bun packages/agents/src/measure/holdem.ts export      gzip the chosen CFR snapshots into apps/web/public/agents/holdem/v1 and verify them
//   bun packages/agents/src/measure/holdem.ts ladder      adjacent levels, duplicate-dealt (interim looks 100 and 200, cap 400 deals), and the always-call baseline for Easy
//   bun packages/agents/src/measure/holdem.ts bots        every level against always-call, pot-raiser and equity-threshold (400 deals each)
//   bun packages/agents/src/measure/holdem.ts exploit [--hands 40000] [--processes 2]
//                                                          in-abstraction best response and local best response (LBR) on the real game
//   bun packages/agents/src/measure/holdem.ts publish     clean tree only: measure everything fresh, write packages/agents/registry/holdem.json
//                                                          (--hands, --br-deals and --out are for dry runs only; the registry is written from the defaults)
//
// A game here is one deal played twice with the seats swapped (a duplicate pair): the agent being scored wins the game
// when its combined chips over the two 30-hand matches are positive, draws when level, loses when negative. Dealt-card luck
// cancels, which is the point of duplicate play. Head-to-head chips per hand come from the same pairs.
// Nothing here reads a stage cache and `publish` measures from committed code (R17).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from '@duelwise/core/src/gzip'
import type { Level } from '@duelwise/core/src/product'
import type { Rng, Seat } from '@duelwise/core/src/types'
import { makeRng } from '@duelwise/core/src/rng'
import { ACTION_WIDTH, Abstraction, CALL, abstractActions, parseInfoKey, type BetSpot } from '@duelwise/core/src/games/holdem/abstraction'
import { abstractBestResponse, bucketDeals, sampleDeals, type StrategyLookup } from '@duelwise/core/src/games/holdem/abstract-br'
import { HOLDEM_BOT_KINDS, createBot, type HoldemBotKind } from '@duelwise/core/src/games/holdem/baselines'
import { CONFIGS } from '@duelwise/core/src/games/holdem/cfr-main'
import { holdemCore, type HoldemObservation } from '@duelwise/core/src/games/holdem/core'
import { holdemGame } from '@duelwise/core/src/games/holdem/holdem-game'
import { LbrAgent, playLbrMatch, summariseHands, type LbrSummary, type LbrVictim } from '@duelwise/core/src/games/holdem/lbr'
import { BIG_BLIND, MATCH_HANDS } from '@duelwise/core/src/games/holdem/match'
import { Mccfr, normalised, restoreSolver } from '@duelwise/core/src/games/holdem/mccfr'
import { HoldemTable, decodeTable } from '@duelwise/core/src/games/holdem/table-format'
import { commonRoot } from '../../../../scripts/paths'
import type { PreviewAgent } from '../agent-types'
import { HOLDEM_LEVELS, HoldemPolicy, beginnerProbs, callBiasProbs, shoveFloorProbs, pruneProbs, createGameAgent as createHoldemLevelAgent } from '../holdem/agent'
import { parseRegistry, type Registry } from '../registry'
import { LEVELS, pairBudget } from '../runtime/levels'
import { assertCleanTree } from './chess'
import { writeStdoutAndExit } from './drain'
import { Z95, publishLadder, runLadder, wilson, type LadderResult } from './ladder'

const HERE = import.meta.dir
const REPO = join(HERE, '..', '..', '..', '..')
const OUT_DIR = join(REPO, 'apps', 'web', 'public', 'agents', 'holdem', 'v1')
const REGISTRY_PATH = join(REPO, 'packages', 'agents', 'registry', 'holdem.json')
const THIS_MODULE = join(HERE, 'holdem.ts')
const TREE_PATHS = ['packages/agents', 'packages/core']
const TREE_EXCLUDE = ['packages/agents/registry/']

const MAX_TABLE_BYTES = 15 * 1024 * 1024
const LADDER_SEEDS = 7_000_000
/** Deals per adjacent pair and per seat. 1000 like Twelve Yards: at 400 the Champion v Hard seat 1 lower bound was 0.4998, a rounding away from the bar, and 400 deals cannot tell a 0.55 seat from a 0.50 one. Same rule (Wilson 95% lower bound above 0.5), tighter interval. */
export const LADDER_DEALS = 1000
const BOT_SEEDS = 8_000_000
const LBR_SEEDS = 9_000_000
const BR_FIT_SEED = 11_000_001
const BR_SCORE_SEED = 11_000_002
const BR_DEALS = 150_000
const LBR_HANDS = 120_000
const LBR_PARTICLES = 250
const LBR_CONTROL_HANDS = 3_000

// ---- which snapshot each level plays ----

interface Source {
  /** Folder under <common root>/runs. */
  run: string
  file: string
  iterations: number
  abstraction: 'coarse' | 'fine'
}

/**
 * Chosen from a pilot on other deals (seeds below 7,000,000), not from the numbers published here. The snapshots differ little
 * head-to-head: the fine 5M table played mixed beats the coarse 250k table by only about 55 Elo and the coarse 1.5M table by about 20,
 * so Hard is the earliest coarse snapshot (the one the mixed Champion clears with a margin) and the 1.5M and 5M
 * coarse tables are not shipped. Easy, Medium and Hard share that snapshot and differ by how they play it (HOLDEM_LEVELS):
 * Hard plays it as it is (no shove from the weakest hands), Medium calls half of its folds and raises, Easy is the loose-passive beginner on top of that.
 */
export const SOURCES: Record<Level, Source> = {
  easy: { run: 'holdem-coarse', file: 'iter-250000.dwht', iterations: 250_000, abstraction: 'coarse' },
  medium: { run: 'holdem-coarse', file: 'iter-250000.dwht', iterations: 250_000, abstraction: 'coarse' },
  hard: { run: 'holdem-coarse', file: 'iter-250000.dwht', iterations: 250_000, abstraction: 'coarse' },
  champion: { run: 'holdem-fine', file: 'final.dwht', iterations: 5_000_000, abstraction: 'fine' },
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const round = (x: number): number => Math.round(x * 1e6) / 1e6
const publishedPath = (level: Level): string => join(OUT_DIR, `${level}.bin.gz`)
const runsDir = (): string => join(commonRoot(), 'runs')

// ---- export ----

export interface ExportRow {
  level: Level
  source: string
  iterations: number
  infosets: number
  rawBytes: number
  gzipBytes: number
  sha256: string
  /** Largest gap between the published probabilities and the solver's, in 1/255 units; null when no checkpoint of that exact iteration exists. */
  maxQuantisationError255: number | null
}

/** The solver state behind a final table, when the checkpoint is at that table's iteration: the full-precision source of the quantised probabilities. */
function solverFor(source: Source, table: HoldemTable): Mccfr<any> | null {
  const dir = join(runsDir(), source.run)
  const ckpt = join(dir, 'ckpt', 'state.bin')
  const thr = join(dir, `thresholds-${source.abstraction}.json`)
  if (!existsSync(ckpt) || !existsSync(thr)) return null
  const abs = new Abstraction(CONFIGS[source.abstraction]!, (JSON.parse(readFileSync(thr, 'utf8')) as { thresholds: number[][] }).thresholds)
  const m = new Mccfr(holdemGame(abs), { plus: true, linear: true })
  restoreSolver(m, new Uint8Array(readFileSync(ckpt)))
  return m.iteration === table.header.iterations ? m : null
}

function quantisationError(table: HoldemTable, solver: Mccfr<any>): number {
  let worst = 0
  for (const [key, node] of solver.nodes) {
    if (table.maskFor(key) !== node.mask) throw new Error(`table and solver disagree on the action mask at ${key}`)
    const exact = normalised(node.sum, node.mask, ACTION_WIDTH)
    const got = table.strategyFor(key)
    for (let a = 0; a < ACTION_WIDTH; a++) if (node.mask & (1 << a)) worst = Math.max(worst, Math.abs(got[a]! - exact[a]!) * 255)
  }
  if (table.entries !== solver.nodes.size) throw new Error('table and solver hold a different number of information sets')
  return worst
}

export function exportTables(): ExportRow[] {
  mkdirSync(OUT_DIR, { recursive: true })
  const rows: ExportRow[] = []
  for (const level of LEVELS) {
    const src = SOURCES[level]
    const raw = new Uint8Array(readFileSync(join(runsDir(), src.run, 'tables', src.file)))
    const table = decodeTable(raw)
    if (table.header.iterations !== src.iterations) throw new Error(`${src.file} is at iteration ${table.header.iterations}, expected ${src.iterations}`)
    if (table.header.abstraction.name !== src.abstraction) throw new Error(`${src.file} is the ${table.header.abstraction.name} abstraction, expected ${src.abstraction}`)
    const gz = gzipSync(raw)
    if (gz.length > MAX_TABLE_BYTES) throw new Error(`${level} table is ${gz.length} bytes gzipped, over the ${MAX_TABLE_BYTES} limit`)
    writeFileSync(publishedPath(level), gz)
    const back = gunzipSync(new Uint8Array(readFileSync(publishedPath(level))), MAX_TABLE_BYTES * 8)
    if (sha(back) !== sha(raw)) throw new Error(`${level}: the written file does not unpack to the source table`)
    const solver = solverFor(src, table)
    const err = solver ? quantisationError(table, solver) : null
    if (err !== null && err > 1 + 1e-6) throw new Error(`${level}: quantisation error ${err}/255 is over 1/255`)
    rows.push({
      level,
      source: `runs/${src.run}/tables/${src.file}`,
      iterations: src.iterations,
      infosets: table.entries,
      rawBytes: raw.length,
      gzipBytes: gz.length,
      sha256: sha(gz),
      maxQuantisationError255: err === null ? null : round(err),
    })
    console.log(level, JSON.stringify(rows[rows.length - 1]))
  }
  return rows
}

export function publishedTable(level: Level): { bytes: Uint8Array; table: HoldemTable } {
  const path = publishedPath(level)
  if (!existsSync(path)) throw new Error(`${path} is missing: run the export stage first`)
  const bytes = new Uint8Array(readFileSync(path))
  return { bytes, table: decodeTable(gunzipSync(bytes, MAX_TABLE_BYTES * 8)) }
}

// ---- players ----

interface Player {
  reset(seed: number): void
  act(obs: HoldemObservation): Promise<number>
}

/** The shipped agent for a level, built from the published file through the same factory the game page uses. */
export async function levelPlayer(level: Level): Promise<Player & { agent: PreviewAgent }> {
  const agent = await createHoldemLevelAgent(level, { table: publishedTable(level).bytes })
  if (agent.preview) throw new Error(`${level}: the agent is a preview stub, the table did not load`)
  return { agent, reset: (seed) => agent.reset(seed), act: async (obs) => (await agent.act(obs))[0]! }
}

export function botPlayer(kind: HoldemBotKind): Player {
  const bot = createBot(kind)
  let rng: Rng = makeRng(0)
  return { reset: (seed) => void (rng = makeRng(seed ^ 0xb07)), act: async (obs) => bot.decide(obs, rng) }
}

/** Plays one 30-hand match; returns the chips each seat finished with. */
async function playMatch(seed: number, players: [Player, Player]): Promise<[number, number]> {
  players[0].reset(seed * 4 + 1)
  players[1].reset(seed * 4 + 2)
  let s = holdemCore.init(seed)
  while (!holdemCore.terminal(s)) {
    const seat = s.actor
    const action = holdemCore.decodeAction(await players[seat].act(holdemCore.observe(s, seat)))
    s = holdemCore.step(s, seat === 0 ? [action, null] : [null, action])
  }
  return [s.net[0], s.net[1]]
}

/** Plays deals [from, to): each deal twice with the seats swapped. Returns the first player's points, and records its combined chips per deal. */
export function duplicateBlock(a: Player, b: Player, base: number, totals: number[], seats?: [number[], number[]]): (from: number, to: number) => Promise<number> {
  return async (from, to) => {
    let points = 0
    for (let d = from; d < to; d++) {
      let chips = 0
      for (const seatA of [0, 1] as Seat[]) {
        const net = await playMatch(base + d, seatA === 0 ? [a, b] : [b, a])
        chips += net[seatA]
        if (seats) seats[seatA][d] = net[seatA]
      }
      totals[d] = chips
      points += chips > 0 ? 1 : chips < 0 ? 0 : 0.5
    }
    return points
  }
}

/** Evaluate the first player on each seat, using the same win, draw and loss rule as the ladder. */
export function holdemSeatGate(seats: [number[], number[]], floor = 0.5, minDeals = 400) {
  const bySeat = seats.map((values, seat) => {
    const rows = values.filter(Number.isFinite)
    const points = rows.reduce((n, chips) => n + (chips > 0 ? 1 : chips < 0 ? 0 : 0.5), 0)
    return { seat, n: rows.length, points, ci95: wilson(points, rows.length) }
  })
  return { bySeat, passed: bySeat.every((s) => s.n >= minDeals && s.ci95[0] > floor) }
}

export interface DuelStats {
  deals: number
  points: number
  score: number
  ci95: [number, number]
  /** Chips per hand won by the first player, in milli big blinds, with a 95% interval over deals. */
  mbbPerHand: number
  mbbCi95: [number, number]
}

function duelStats(points: number, totals: number[], n: number): DuelStats {
  const t = totals.slice(0, n)
  const mean = t.reduce((s, x) => s + x, 0) / n
  const sd = Math.sqrt(t.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1))
  const toMbb = (chips: number): number => (chips / (2 * MATCH_HANDS) / BIG_BLIND) * 1000
  const half = 1.959964 * (sd / Math.sqrt(n))
  const ci = wilson(points, n, Z95)
  return { deals: n, points, score: round(points / n), ci95: [round(ci[0]), round(ci[1])], mbbPerHand: round(toMbb(mean)), mbbCi95: [round(toMbb(mean - half)), round(toMbb(mean + half))] }
}

// ---- ladder and bots ----

interface LadderRun {
  ladder: LadderResult
  /** Head-to-head chips per hand for each pair and the baseline, from the deals that were played. */
  mbb: Record<string, { mbbPerHand: number; mbbCi95: [number, number]; deals: number }>
}

async function ladder(): Promise<LadderRun> {
  const players = {} as Record<Level, Player>
  for (const level of LEVELS) players[level] = await levelPlayer(level)
  const totals: Record<string, number[]> = {}
  const seats: Record<string, [number[], number[]]> = {}
  const result = await runLadder({
    game: 'holdem',
    levels: [...LEVELS],
    budget: { maxGames: LADDER_DEALS, looks: [] },
    playPair: (pair, from, to) => {
      const key = `${pair.upper}>${pair.lower}`
      totals[key] ??= []
      seats[key] ??= [[], []]
      return duplicateBlock(players[pair.upper], players[pair.lower], LADDER_SEEDS + LEVELS.indexOf(pair.upper) * 100_000, totals[key]!, seats[key]!)(from, to)
    },
    baseline: {
      label: 'always-call',
      play: (from, to) => {
        totals['easy>always-call'] ??= []
        seats['easy>always-call'] ??= [[], []]
        return duplicateBlock(players.easy, botPlayer('always-call'), LADDER_SEEDS + 900_000, totals['easy>always-call']!, seats['easy>always-call']!)(from, to)
      },
    },
  })
  for (const pair of result.pairs) {
    const gate = holdemSeatGate(seats[`${pair.upper}>${pair.lower}`]!, 0.5, LADDER_DEALS)
    Object.assign(pair, { bySeat: gate.bySeat, passed: pair.passed && gate.passed })
  }
  if (result.baseline) {
    const gate = holdemSeatGate(seats['easy>always-call']!, 0.5, LADDER_DEALS)
    Object.assign(result.baseline, { bySeat: gate.bySeat, passed: result.baseline.passed && gate.passed })
  }
  const mbb: LadderRun['mbb'] = {}
  for (const p of result.pairs) {
    const s = duelStats(p.points, totals[`${p.upper}>${p.lower}`]!, p.n)
    mbb[`${p.upper}>${p.lower}`] = { mbbPerHand: s.mbbPerHand, mbbCi95: s.mbbCi95, deals: p.n }
  }
  if (result.baseline) {
    const s = duelStats(result.baseline.points, totals['easy>always-call']!, result.baseline.n)
    mbb['easy>always-call'] = { mbbPerHand: s.mbbPerHand, mbbCi95: s.mbbCi95, deals: result.baseline.n }
  }
  for (const p of result.pairs) {
    const m = mbb[`${p.upper}>${p.lower}`]!
    console.log(`${p.upper} vs ${p.lower}: ${p.points}/${p.n} deals`, p.ci95.map((x) => x.toFixed(3)), p.passed ? 'PASS' : 'FAIL', p.stoppedEarly ? '(stopped at interim look)' : '', `${m.mbbPerHand} mbb/hand`)
  }
  if (result.baseline) console.log(`easy vs always-call: ${result.baseline.points}/${result.baseline.n}`, `${mbb['easy>always-call']!.mbbPerHand} mbb/hand`)
  console.log('site Elo', JSON.stringify(result.elo))
  return { ladder: result, mbb }
}

export interface BotRow extends DuelStats {
  level: Level
  bot: HoldemBotKind
}

async function bots(deals = 400): Promise<BotRow[]> {
  const rows: BotRow[] = []
  for (const level of LEVELS) {
    const player = await levelPlayer(level)
    for (const kind of HOLDEM_BOT_KINDS) {
      const totals: number[] = []
      const seats: [number[], number[]] = [[], []]
      const points = await duplicateBlock(player, botPlayer(kind), BOT_SEEDS + LEVELS.indexOf(level) * 10_000, totals, seats)(0, deals)
      const row = { level, bot: kind, ...duelStats(points, totals, deals), bySeat: holdemSeatGate(seats).bySeat }
      console.log(level, 'vs', kind, `${row.points}/${row.deals}`, row.ci95.map((x) => x.toFixed(3)), `${row.mbbPerHand} mbb/hand`, row.mbbCi95)
      rows.push(row)
    }
  }
  return rows
}

// ---- exploitability ----

/** Table approximation for the abstraction benchmark. It cannot represent the live premium-hand guard. */
export function shippedLookup(table: HoldemTable, level: Level, settings: { purify: boolean; explore: number; beginner?: boolean; shoveFloor?: number; callBias?: number } = HOLDEM_LEVELS[level]): StrategyLookup {
  const { purify, explore } = settings
  const abs = table.abstraction()
  return (key) => {
    const mask = table.maskFor(key)
    if (!mask) return null
    const raw = table.strategyFor(key)
    let probs = Array.from(raw)
    if (purify) {
      let best = -1
      for (let a = 0; a < ACTION_WIDTH; a++) if (mask & (1 << a) && (best < 0 || probs[a]! > probs[best]!)) best = a
      probs = probs.map((_, a) => (a === best ? 1 : 0))
    }
    if (explore > 0) {
      let used = 0
      for (let a = 0; a < ACTION_WIDTH; a++) if (mask & (1 << a)) used++
      const total = probs.reduce((s, x, a) => s + (mask & (1 << a) ? x : 0), 0)
      probs = probs.map((x, a) => (mask & (1 << a) ? (1 - explore) * (total > 0 ? x / total : 1 / used) + explore / used : 0))
    }
    if (settings.beginner) {
      const ids: number[] = []
      for (let a = 0; a < ACTION_WIDTH; a++) if (mask & (1 << a)) ids.push(a)
      const { street, bucket } = parseInfoKey(key)
      const shaped = beginnerProbs(ids.map((a) => probs[a]!), ids, street, bucket, abs.size(street))
      probs = probs.map(() => 0)
      ids.forEach((a, i) => (probs[a] = shaped[i]!))
    }
    if (settings.callBias) {
      const ids: number[] = []
      for (let a = 0; a < ACTION_WIDTH; a++) if (mask & (1 << a)) ids.push(a)
      const shaped = callBiasProbs(ids.map((a) => probs[a]!), ids, settings.callBias)
      probs = probs.map(() => 0)
      ids.forEach((a, i) => (probs[a] = shaped[i]!))
    }
    if (settings.shoveFloor) {
      const ids: number[] = []
      for (let a = 0; a < ACTION_WIDTH; a++) if (mask & (1 << a)) ids.push(a)
      const { street, bucket } = parseInfoKey(key)
      const shaped = shoveFloorProbs(ids.map((a) => probs[a]!), ids, street, bucket, abs.size(street), settings.shoveFloor)
      probs = probs.map(() => 0)
      ids.forEach((a, i) => (probs[a] = shaped[i]!))
    }
    const ids = probs.map((_, i) => i).filter((i) => (mask & (1 << i)) !== 0)
    const kept = pruneProbs(ids.map((i) => probs[i]!))
    probs = probs.map(() => 0)
    ids.forEach((id, i) => (probs[id] = kept[i]!))
    return { mask, probs }
  }
}

export interface InAbstractionRow {
  level: Level
  /** False for a row that measures a table as it is before the level's settings are applied (context, not what ships). */
  shipped: boolean
  abstraction: 'coarse' | 'fine'
  strategy: string
  heldOutMbb: number
  heldOutCi95: [number, number]
  fittedMbb: number
  seatMbb: [number, number]
  fitDeals: number
  scoreDeals: number
  unknownShare: number
}

function inAbstraction(deals = BR_DEALS): InAbstractionRow[] {
  const started = Date.now()
  const fit = sampleDeals(deals, BR_FIT_SEED)
  const score = sampleDeals(deals, BR_SCORE_SEED)
  console.log(`sampled ${deals} + ${deals} deals in ${Math.round((Date.now() - started) / 1000)} s`)
  const rows: InAbstractionRow[] = []
  const measure = (level: Level, settings: { purify: boolean; explore: number; beginner?: boolean; shoveFloor?: number; callBias?: number }, shipped: boolean): void => {
    const { table } = publishedTable(level)
    const abs = table.abstraction()
    const t0 = Date.now()
    const r = abstractBestResponse(shippedLookup(table, level, settings), bucketDeals(fit, abs), bucketDeals(score, abs))
    const row: InAbstractionRow = {
      level,
      shipped,
      abstraction: SOURCES[level].abstraction,
      strategy: `${settings.purify ? 'purified' : 'mixed'}${settings.beginner ? ', loose-passive beginner mix' : ''}${settings.explore > 0 ? `, ${settings.explore} random play` : ''}${shipped && (level === 'hard' || level === 'champion') ? ', approximation without premium protection' : ''}${shipped ? '' : ' (the table before the level\'s settings, not what ships)'}`,
      heldOutMbb: round(r.heldOutMbb),
      heldOutCi95: [round(r.heldOutCi95[0]), round(r.heldOutCi95[1])],
      fittedMbb: round(r.fittedMbb),
      seatMbb: [round(r.seatMbb[0]), round(r.seatMbb[1])],
      fitDeals: r.fitDeals,
      scoreDeals: r.scoreDeals,
      unknownShare: round(r.unknownShare),
    }
    console.log(level, JSON.stringify(row), `${Math.round((Date.now() - t0) / 1000)} s`)
    rows.push(row)
  }
  for (const level of LEVELS) measure(level, HOLDEM_LEVELS[level], true)
  if (HOLDEM_LEVELS.champion.purify) measure('champion', { purify: false, explore: 0 }, false)
  return rows
}

/** The victim as the best responder models it: the same policy over the same table, with bucket lookups cached. */
function victimModel(level: Level): { victim: LbrVictim; real: HoldemPolicy } {
  const { table } = publishedTable(level)
  const s = HOLDEM_LEVELS[level]
  const model = new HoldemPolicy(table, s.purify, { memoBuckets: true, explore: s.explore, beginner: s.beginner, shoveFloor: s.shoveFloor, callBias: s.callBias, premiumProtection: s.premiumProtection })
  return { victim: { branches: (obs, mem) => model.branches(obs, mem) }, real: new HoldemPolicy(table, s.purify, { explore: s.explore, beginner: s.beginner, shoveFloor: s.shoveFloor, callBias: s.callBias, premiumProtection: s.premiumProtection }) }
}

export interface LbrChunk {
  chips: number[]
  resets: number
  updates: number
  /** The victim's decisions answered by its fallback rule because its table had no entry, and all its decisions. */
  fallbacks: number
  decisions: number
}

/** Matches [from, to) of the LBR run for a level. Deterministic: match m always uses the same seeds. */
export function lbrChunk(level: Level, from: number, to: number, particles = LBR_PARTICLES): LbrChunk {
  const { victim, real } = victimModel(level)
  const out: LbrChunk = { chips: [], resets: 0, updates: 0, fallbacks: 0, decisions: 0 }
  for (let m = from; m < to; m++) {
    real.reset()
    const lbr = new LbrAgent(victim, (m % 2) as Seat, { seed: LBR_SEEDS + m, particles })
    let decisions = 0
    const chips = playLbrMatch({
      seed: LBR_SEEDS + m,
      lbr,
      victim: (obs, rng) => (decisions++, real.decide(obs, rng)),
      victimRng: makeRng(LBR_SEEDS * 3 + m),
    })
    out.chips.push(...chips)
    out.resets += lbr.resets
    out.updates += lbr.updates
    out.decisions += decisions
  }
  out.fallbacks = real.misses
  return out
}

function runChild(args: string[]): Promise<LbrChunk> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [THIS_MODULE, ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
    let text = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (text += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`lbr process exited with code ${code}`))
      try {
        resolve(JSON.parse(text) as LbrChunk)
      } catch (e) {
        reject(e)
      }
    })
  })
}

export interface LbrRow extends LbrSummary {
  level: Level
  /** The 95% lower bound on what a best responder wins per hand against this level, floored at zero: the exploitability lower bound the measurement supports. */
  exploitabilityLowerBoundMbb: number
  particles: number
  beliefResets: number
  beliefUpdates: number
  fallbackShare: number
}

async function lbr(level: Level, hands: number, processes: number): Promise<LbrRow> {
  const matches = Math.ceil(hands / MATCH_HANDS)
  const per = Math.ceil(matches / processes)
  const parts = Array.from({ length: processes }, (_, p) => [p * per, Math.min(matches, (p + 1) * per)] as const).filter(([a, b]) => b > a)
  const chunks = await Promise.all(parts.map(([a, b]) => runChild(['lbr-chunk', level, String(a), String(b), String(LBR_PARTICLES)])))
  const chips = chunks.flatMap((c) => c.chips)
  const s = summariseHands(chips)
  const row: LbrRow = {
    level,
    ...s,
    mbbPerHand: round(s.mbbPerHand),
    ci95: [round(s.ci95[0]), round(s.ci95[1])],
    sdBb: round(s.sdBb),
    exploitabilityLowerBoundMbb: round(Math.max(0, s.ci95[0])),
    particles: LBR_PARTICLES,
    beliefResets: chunks.reduce((t, c) => t + c.resets, 0),
    beliefUpdates: chunks.reduce((t, c) => t + c.updates, 0),
    fallbackShare: round(chunks.reduce((t, c) => t + c.fallbacks, 0) / Math.max(1, chunks.reduce((t, c) => t + c.decisions, 0))),
  }
  console.log(level, JSON.stringify(row))
  return row
}

/** The calling station is the control: a best responder that cannot find a large win here is too weak to say anything about the levels. */
function lbrControl(hands = LBR_CONTROL_HANDS): LbrSummary {
  const station: LbrVictim = {
    branches(obs) {
      const me = obs.seat
      const opp = (1 - me) as Seat
      const spot: BetSpot = {
        bet: obs.bet[me],
        oppBet: obs.bet[opp],
        total: obs.total[me],
        oppTotal: obs.total[opp],
        minTo: obs.minRaiseTo > 0 ? obs.minRaiseTo : 1,
        maxTo: obs.maxRaiseTo > 0 ? obs.maxRaiseTo : 0,
      }
      const options = abstractActions(spot)
      return [{ weight: 1, options, probs: options.map((o) => (o.id === CALL ? 1 : 0)) }]
    },
  }
  const bot = createBot('always-call')
  const chips: number[] = []
  for (let m = 0; m < Math.ceil(hands / MATCH_HANDS); m++) {
    const agent = new LbrAgent(station, (m % 2) as Seat, { seed: LBR_SEEDS + 500_000 + m, particles: LBR_PARTICLES })
    chips.push(...playLbrMatch({ seed: LBR_SEEDS + 500_000 + m, lbr: agent, victim: (obs, rng) => bot.decide(obs, rng), victimRng: makeRng(m + 1) }))
  }
  const s = summariseHands(chips)
  console.log('control vs always-call', JSON.stringify(s))
  return s
}

// ---- publish ----

const exportMeta = (rows: ExportRow[]) => rows.map((r) => ({ ...r }))

async function publish(hands: number, processes: number, brDeals: number, outPath: string): Promise<void> {
  assertCleanTree(REPO, [...TREE_PATHS, 'apps/web/public/agents/holdem', ...TREE_EXCLUDE.map((x) => `:(exclude)${x}`)])
  const commit = spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']).stdout.toString().trim()
  // The export stage must have been committed: the files on disk are re-derived and have to be identical.
  const published = LEVELS.map((l) => sha(publishedTable(l).bytes))
  const exported = exportTables()
  exported.forEach((r, i) => {
    if (r.sha256 !== published[i]) throw new Error(`${r.level}: the committed table differs from a fresh export of ${r.source}`)
  })
  const lad = await ladder()
  if (!lad.ladder.baseline?.passed) throw new Error('Easy did not clear the per-seat calling bot gate: nothing written')
  const botRows = await bots()
  const abstractRows = inAbstraction(brDeals)
  const control = lbrControl()
  const lbrRows: LbrRow[] = []
  for (const level of [...LEVELS].reverse()) lbrRows.push(await lbr(level, hands, processes))
  lbrRows.reverse()
  const now = new Date().toISOString()
  const artifacts: Record<string, string> = {}
  const sha256: Record<string, string> = {}
  for (const r of exported) {
    artifacts[r.level] = `apps/web/public/agents/holdem/v1/${r.level}.bin.gz`
    sha256[r.level] = r.sha256
  }
  const config = (level: Level): Record<string, unknown> => {
    const src = SOURCES[level]
    return { table: `${level}.bin.gz`, snapshot: `${src.run} ${src.file}`, abstraction: src.abstraction, iterations: src.iterations, ...HOLDEM_LEVELS[level] }
  }
  const draft: Registry = {
    game: 'holdem',
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
        trainedSteps: SOURCES.champion.iterations,
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
  const reg = publishLadder(parseRegistry(draft), lad.ladder, { harness: 'bun', commit, measuredAt: now, version: 'v1' })
  const lbrFor = (l: Level) => lbrRows.find((r) => r.level === l)!
  reg.versions[0]!.gate = {
    rule: `adjacent levels: the stronger level wins the duplicate-dealt game above 50% with a 95% Wilson lower bound; a game is one deal played twice with the seats swapped and is won when the level's combined chips over the two 30-hand matches are positive; ${LADDER_DEALS} deals (${2 * LADDER_DEALS} matches); each seat must also clear a 95% Wilson lower bound above 50%`,
    eloLabel: 'site Elo; Easy anchored at 1000, each higher level is the chained gap from its duplicate-pair score',
    deals: `deal d is seed ${LADDER_SEEDS} + 100000 * (index of the upper level) + d, played from both seats`,
    checkpointRule: 'a pilot on other deals (seeds below 7,000,000) showed the snapshots barely differ head-to-head (the fine 5M table played mixed beats the earliest coarse snapshot by only about 55 Elo and the coarse 1.5M one by about 20, and the coarse 1.5M and 5M tables do not separate); Easy, Medium and Hard therefore share the earliest snapshot (250,000 iterations) and differ by how they play it: Hard plays it as it is but never shoves the weakest quarter of starting hands, Medium also plays half of its folds and raises as calls, Easy plays the loose-passive beginner mix with the same call dial (calls most folds, rarely shoves, never folds a premium hand before the flop); Champion is the final fine table (5,000,000 iterations) played as its mixed strategy, because the purified play was far more exploitable',
    settings: HOLDEM_LEVELS,
    easyBaseline: 'always-call; the gate for Easy is that it beats a calling station',
    tables: exportMeta(exported),
    pairs: lad.ladder.pairs.map((p) => ({ lower: p.lower, upper: p.upper, n: p.n, points: p.points, score: round(p.score), ci95: p.ci95.map(round), stoppedEarly: p.stoppedEarly, passed: p.passed, bySeat: (p as typeof p & { bySeat?: unknown }).bySeat, ...lad.mbb[`${p.upper}>${p.lower}`] })),
    baseline: lad.ladder.baseline
      ? { label: lad.ladder.baseline.label, n: lad.ladder.baseline.n, points: lad.ladder.baseline.points, score: round(lad.ladder.baseline.score), ci95: lad.ladder.baseline.ci95.map(round), bySeat: (lad.ladder.baseline as typeof lad.ladder.baseline & { bySeat?: unknown }).bySeat, ...lad.mbb['easy>always-call'] }
      : null,
    bots: botRows,
    exploitability: {
      note: 'Two numbers, both lower-bound style and both labelled. LBR is local best response on the real game: a best responder that knows the level\'s strategy but never its cards, 250 sampled opponent hands, check-down after a call, raises of 0.33 to 2 pot and all in; the chips it really won over the hands played are a lower bound on how much the level can lose per hand. In-abstraction is the best response inside the abstraction the strategy was trained on, without the live premium-hand guard, on a chance model estimated from sampled deals, fitted on one set of deals and scored on another.',
      lbrControl: { victim: 'always-call', ...control },
      lbr: lbrRows.map((r) => ({ ...r })),
      inAbstraction: abstractRows,
      lbrByLevel: Object.fromEntries(LEVELS.map((l) => [l, { mbbPerHand: lbrFor(l).mbbPerHand, ci95: lbrFor(l).ci95, hands: lbrFor(l).hands, lowerBound: lbrFor(l).exploitabilityLowerBoundMbb }])),
    },
  }
  writeFileSync(outPath, JSON.stringify(parseRegistry(reg), null, 2) + '\n')
  console.log('wrote', outPath, 'unpublished:', JSON.stringify(reg.unpublished))
}

// ---- command line ----

if (import.meta.main) {
  const stage = process.argv[2]
  const flag = (name: string, dflt: number): number => {
    const i = process.argv.indexOf(name)
    return i > 0 ? Number(process.argv[i + 1]) : dflt
  }
  if (stage === 'export') exportTables()
  else if (stage === 'ladder') await ladder()
  else if (stage === 'bots') await bots()
  else if (stage === 'exploit') {
    inAbstraction()
    lbrControl()
    for (const level of [...LEVELS].reverse()) await lbr(level, flag('--hands', LBR_HANDS), flag('--processes', 2))
  } else if (stage === 'lbr-chunk') {
    const [level, from, to, particles] = process.argv.slice(3)
    writeStdoutAndExit(JSON.stringify(lbrChunk(level as Level, Number(from), Number(to), Number(particles))))
  } else if (stage === 'publish') {
    // --br-deals and --out exist for dry runs of this pipeline; a real publish uses the defaults.
    const outIdx = process.argv.indexOf('--out')
    await publish(flag('--hands', LBR_HANDS), flag('--processes', 2), flag('--br-deals', BR_DEALS), outIdx > 0 ? process.argv[outIdx + 1]! : REGISTRY_PATH)
  }
  else {
    console.error('usage: holdem.ts export | ladder | bots | exploit [--hands N] [--processes 2] | publish [--hands N] [--processes 2]')
    process.exit(2)
  }
}
