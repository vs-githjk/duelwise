import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { ladderToElo } from '@duelwise/core/src/elo'
import { LEVEL_MALLET } from '@duelwise/core/src/games/puck/constants'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import type { Level } from '@duelwise/core/src/product'
import { parseRegistry, type Registry } from '../registry'
import { harnessRuntime } from './harness'
import { wilson } from './ladder'
import { c2Statement, c2StatementScripted, complianceFailures, gatePuck, LEVELS_ORDER, PUCK_BARS, SEAT_GAMES, type BotRow, type LevelMeasure, type PairResult } from './puck'

// Builds packages/agents/registry/puck.json from measured results (never hand-edited). A level is published only when its per-seat
// bot gate, its compliance numbers, its adjacent ladder pair (and for Champion the lane cap) all pass; every other level is
// "in training" with the reason the page shows. Same shape as the arena and fighter registries so strength-gates.ts reads it.

export type ChampionBots = 'live' | 'human' | 'human-hands'

/** Sable's shot lanes: no lane above this share of its shots (plan, Sable unpredictable). */
export const LANE_CAP = 0.5

export interface LevelInput {
  /** The primary measurement: net replies applied one tick late (the worker). */
  measure: LevelMeasure
  /** Claim C2's control: the same network with the score hidden from it (--mask-score), same bots and seeds. */
  control?: LevelMeasure
  /** The same with replies two ticks late (30 fps), reported alongside. */
  lag2?: LevelMeasure
  /** Human-hands mode only: the same bots after a slower reaction delay (a slower person), reported alongside. */
  slower?: LevelMeasure
  /** Null for Pip, which is scripted and has no model file. */
  model: { artifact: string; absolute: string; source: string; step: number } | null
  /** ORT (onnxruntime-web) against torch on real observations for this exported file. */
  parity?: { worstAbsDiff: number; tolerance: number; observations: number; pass: boolean }
}

export interface PuckPublishInput {
  levels: Partial<Record<Level, LevelInput>>
  /** Adjacent ladder pairs, lower -> upper, as measured. */
  pairs: PairResult[]
  /** The registry on disk, for each level's persona config. */
  existing: Registry
  championBots: ChampionBots
  now: string
  commit: string
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const seatDetail = (s: { games: number; wins: number; draws: number; losses: number; score: number }) => ({ games: s.games, wins: s.wins, draws: s.draws, losses: s.losses, score: round6(s.score), lower: round6(wilson(s.wins + s.draws / 2, s.games)[0]) })

/** Both seats of an adjacent pair beat the lower level (Wilson lower bound above 0.5), 400 each. */
export function pairVerdict(p: PairResult): { passed: boolean; reason: string } {
  const bad: string[] = []
  for (const seat of ['0', '1'] as const) {
    const s = p.bySeat[seat]
    const lower = wilson(s.wins + s.draws / 2, s.games)[0]
    if (s.games < SEAT_GAMES) bad.push(`${s.games} matches on seat ${seat}`)
    else if (lower <= 0.5) bad.push(`seat ${seat} scored ${s.wins + s.draws / 2} of ${s.games} (Wilson lower bound ${lower.toFixed(4)})`)
  }
  return { passed: bad.length === 0, reason: bad.length ? `does not beat ${p.lower} from both seats: ${bad.join('; ')}` : '' }
}

export function levelVerdict(level: Level, input: LevelInput, pairs: PairResult[]): { passed: boolean; failures: string[] } {
  const failures: string[] = []
  const gate = gatePuck(level, input.measure.rows)
  failures.push(...gate.failures)
  failures.push(...complianceFailures(level, input.measure.aggregate))
  if (level === 'champion' && input.measure.lanes.shareMax > LANE_CAP) failures.push(`${level}: one shot lane carries ${(input.measure.lanes.shareMax * 100).toFixed(0)}% of its shots, above the ${LANE_CAP * 100}% cap`)
  const index = LEVELS_ORDER.indexOf(level)
  if (index > 0) {
    const pair = pairs.find((p) => p.upper === level && p.lower === LEVELS_ORDER[index - 1])
    if (!pair) failures.push(`no ladder pair against ${LEVELS_ORDER[index - 1]}`)
    else {
      const v = pairVerdict(pair)
      if (!v.passed) failures.push(`${level} ${v.reason}`)
    }
  }
  if (input.model === null && level !== 'easy') failures.push(`${level}: no model`)
  if (input.model !== null && input.parity && !input.parity.pass) failures.push(`${level}: the exported model differs from torch by ${input.parity.worstAbsDiff}`)
  return { passed: failures.length === 0, failures }
}

const PERSONA: Record<Level, string> = { easy: 'Pip', medium: 'Marlow', hard: 'Vesper', champion: 'Sable' }

export const LADDER_NOTE =
  'Each adjacent pair plays 400 matches per seat of the upper level, with the same reply lag the browser has (one tick late); Elo steps come from ladderToElo with Pip anchored at 1000. Marlow runs Vesper\'s network under Medium limits, so the Vesper v Marlow step measures the limits (reaction time, mallet speed and acceleration, hand noise), not a different brain.'

export function buildPuckRegistry(input: PuckPublishInput): Registry {
  const artifacts: Record<string, string> = {}
  const hashes: Record<string, string> = {}
  const levels: Registry['levels'] = {}
  const measured: Registry['measured'] = {}
  const unpublished: NonNullable<Registry['unpublished']> = {}
  const unpublishedConfig: NonNullable<Registry['unpublishedConfig']> = {}
  const gateLevels: Record<string, unknown> = {}
  const elo = ladderToElo(input.pairs.map((p) => ({ lower: p.lower, upper: p.upper, score: p.score })), { level: 'easy', elo: 1000 })
  const sources = new Map<string, number>()

  for (const level of LEVELS_ORDER) {
    const li = input.levels[level]
    const existing = input.existing.levels[level]?.config ?? input.existing.unpublishedConfig?.[level] ?? {}
    const mallet = LEVEL_MALLET[level]
    const hands = { delayMs: Math.round((LEVEL_LIMITS.puck[level].delayFrames * 1000) / 60), malletSpeed: mallet.speed, malletAccel: mallet.accel, targetNoise: mallet.targetNoise }
    if (!li) {
      unpublished[level] = 'in training: not measured'
      unpublishedConfig[level] = { ...existing, ...hands }
      continue
    }
    const m = li.measure
    const verdict = levelVerdict(level, li, input.pairs)
    const gate = gatePuck(level, m.rows)
    gateLevels[level] = {
      bots: m.rows.map((r) => ({ bot: r.bot, wins: r.wins, draws: r.draws, losses: r.losses, score: round6(r.score), lower: round6(wilson(r.wins + r.draws / 2, r.games)[0]), bar: PUCK_BARS[level][r.bot] ?? null, bySeat: { '0': seatDetail(r.bySeat['0']), '1': seatDetail(r.bySeat['1']) } })),
      botLimits: m.botHands === 'human' ? 'human-hands' : level === 'champion' ? input.championBots : 'human',
      botDelayFrames: m.botDelay,
      replyLagTicks: m.lag,
      onnxParity: li.parity ?? null,
      source: li.model?.source ?? null,
      step: li.model?.step ?? null,
      compliance: m.compliance,
      lanes: { counts: m.lanes.counts, shareMax: round6(m.lanes.shareMax), entropyBits: round6(m.lanes.entropyBits) },
      // Only the statement ships: the registry is bundled into every page, and the rows behind it live in the run output and plan notes.
      c2: { statement: level === 'easy' ? c2StatementScripted(m.c2, PERSONA[level]) : c2Statement(m.c2, PERSONA[level], li.control?.c2, { gatePassed: verdict.passed }) },
      ...(li.slower ? { slowerHuman: { botDelayFrames: li.slower.botDelay, bots: li.slower.rows.map((r) => ({ bot: r.bot, wins: r.wins, draws: r.draws, losses: r.losses, score: round6(r.score), lower: round6(wilson(r.wins + r.draws / 2, r.games)[0]), bySeat: { '0': seatDetail(r.bySeat['0']), '1': seatDetail(r.bySeat['1']) } })), passesBars: gatePuck(level, li.slower.rows).passed } } : {}),
      ...(li.lag2 ? { twoTickLag: { replyLagTicks: li.lag2.lag, bots: li.lag2.rows.map((r) => ({ bot: r.bot, wins: r.wins, draws: r.draws, losses: r.losses, score: round6(r.score), bySeat: { '0': seatDetail(r.bySeat['0']), '1': seatDetail(r.bySeat['1']) } })), passesBars: gatePuck(level, li.lag2.rows).passed } } : {}),
    }
    if (verdict.passed && gate.weakest) {
      const w = gate.weakest
      const siteElo = elo[level]
      if (siteElo === undefined) throw new Error(`${level} passed the gate but has no site Elo: the ladder is incomplete`)
      if (li.model) {
        const name = li.model.artifact.split('/').pop()!
        artifacts[name] = li.model.artifact
        hashes[name] = sha256(li.model.absolute)
        sources.set(li.model.source, li.model.step)
      }
      const [lo, hi] = wilson(w.result.wins + w.result.draws / 2, w.result.games)
      levels[level] = {
        version: 'v1',
        config: { ...existing, ...hands, ...(li.model ? { model: li.model.artifact.split('/').pop()!, observation: 'v1', obsFeatures: 23, sampling: 'policy samples', replyLagTicks: m.lag } : { scripted: true }) },
      }
      measured[level] = {
        metric: `score vs scripted ${w.bot} bot (weakest seat of the weakest gate bot)`,
        value: round6(w.result.score),
        ci95: [round6(lo), round6(hi)],
        n: w.result.games,
        opponents: m.botHands === 'human' ? `scripted ${Object.keys(PUCK_BARS[level]).join(', ')} bots on the rule mallet (speed 6, acceleration 120, what a person gets in the browser) after a ${m.botDelay}-frame reaction` : level === 'champion' && input.championBots === 'live' ? 'scripted bots that see the live game' : `scripted ${Object.keys(PUCK_BARS[level]).join(', ')} bots under the same limits and delayed view`,
        siteElo: round6(siteElo),
        measuredAt: input.now,
        harness: harnessRuntime(),
        commit: input.commit,
      }
    } else {
      unpublished[level] = `in training: ${verdict.failures.join('; ')}`
      unpublishedConfig[level] = { ...existing, ...hands }
    }
  }
  const reg: Registry = {
    game: 'puck',
    champion: 'v1',
    versions: [
      {
        version: 'v1',
        parent: null,
        createdAt: input.now,
        promotedAt: Object.keys(levels).length ? input.now : null,
        status: Object.keys(levels).length ? 'measured' : 'preview',
        artifacts,
        sha256: hashes,
        trainedSteps: [...sources.values()].reduce((n, x) => n + x, 0),
        humanMatchesUsed: 0,
        gate: {
          rule: `400 matches per bot on each seat, ${input.championBots === 'human-hands' ? 'bots on human hands (the rule mallet the person gets in the browser, a human reaction delay)' : `bots under the level's mallet limits and reaction time (Champion: ${input.championBots === 'live' ? 'bots that see the live game' : 'bots under the same 150 ms limits'})`}; the agent's reply lands one tick late, as in the browser worker; a level publishes when the Wilson 95% lower bound clears the bar against every bot on each seat, its mallet stays within its caps, and it beats the level below from both seats`,
          matches: SEAT_GAMES * 2,
          levels: gateLevels,
          ladder: { pairs: input.pairs.map((p) => ({ lower: p.lower, upper: p.upper, score: round6(p.score), n: p.n, lowerBound95: p.lowerBound95, bySeat: { '0': seatDetail(p.bySeat['0']), '1': seatDetail(p.bySeat['1']) } })), note: LADDER_NOTE },
        },
      },
    ],
    levels,
    measured,
    unpublished,
    unpublishedConfig,
    learnsFromHumans: false,
  }
  return parseRegistry(reg)
}

/** Rows as kept next to the registry (packages/agents/eval/puck/<level>.json), the shape registry-rows.test.ts compares against. */
export const evalRows = (rows: BotRow[]): BotRow[] => rows

export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T
export const fileExists = existsSync
