import { readFileSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { ACTION_NVEC_V2, badHead } from '@duelwise/core/src/games/arena/actions'
import { arenaCore, createState, stepPacked } from '@duelwise/core/src/games/arena/core'
import { unpackInput, type ArenaInput } from '@duelwise/core/src/games/arena/input'
import { PHASE, type ArenaState } from '@duelwise/core/src/games/arena/state'
import { WEAPONS } from '@duelwise/core/src/games/arena/weapons'
import { LEVEL_LIMITS, type LimiterConfig } from '@duelwise/core/src/limiter'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import { createGameAgent, type ArenaReply, type ArenaTick } from '../arena/agent'
import { ArenaSeatInput, buyIdle, seatView, viewDue } from '../arena/view'
import { writeRegistry, type Registry } from '../registry'
import { buildGameRegistry, GATE_MATCHES, gateLevel, type BotRow, type GameGate, type PublishInput } from './fighter'
import { wilson } from './ladder'

// Arena measurement (T26): recorded games for the limiter compliance check, and the gate and registry helpers
// `publish` uses. The scripted-bot win rates (R15) come from training/trainer/ppo/eval_bots.py --game arena, which
// plays the bots under the same limits and delayed view the env trains with; this file turns them into the registry.

const UNITS_PER_DEG = 8192 / 360
const FRAME_SKIP = 4

export interface ArenaSeatRecord {
  /** Held input after the limiter, one entry per decision: [frame, move, flag bits]. */
  decisions: Array<[number, number, number]>
  /** Frames between each decision and the frame of the view it read (read from the view the agent served to its own model). */
  lags: number[]
  /** The same, without the first `delayFrames` frames of each buy or live phase (the limiter serves its oldest view while the delay has not elapsed). */
  lagsAfterWarmup: number[]
  /** Frames at which the sim received a new press (see PressMeter). */
  pressFrames: number[]
  /** The per-frame turn [yaw, pitch] the agent applied at each live decision, in angle units. */
  aim: Array<[number, number]>
}

export interface ArenaRecordedGame {
  seed: number
  frames: number
  winner: 0 | 1 | null
  seats: [ArenaSeatRecord, ArenaSeatRecord]
}

export interface ArenaSeatPlan {
  level: Level
  bytes: Uint8Array
  /** Negative probes only: build the agent with this limiter instead of its level's. The schedule stays the level's. */
  limits?: LimiterConfig
}

const emptySeat = (): ArenaSeatRecord => ({ decisions: [], lags: [], lagsAfterWarmup: [], pressFrames: [], aim: [] })
const flagBits = (i: ArenaInput): number => i.walk + 2 * i.crouch + 4 * i.jump + 8 * i.fire + 16 * i.reload

/**
 * Counts presses in the stream of inputs the sim receives, frame by frame, independently of the limiter's own
 * bookkeeping: a new non-neutral move, or a button that goes from up to down (a semi-automatic trigger that is
 * released and pulled again counts every pull). Round-end frames carry no input and are skipped, as the held
 * input survives them.
 */
export class PressMeter {
  private move = 0
  private flags = 0
  feed(packed: number): boolean {
    const i = unpackInput(packed)
    const f = flagBits(i)
    const press = (i.move !== 0 && i.move !== this.move) || (f & ~this.flags) !== 0
    this.move = i.move
    this.flags = f
    return press
  }
}

/** The largest per-frame turn the config lets through before noise (Infinity for no limit). Mirrors HumanLimiter.aim. */
export function aimCap(cfg: LimiterConfig): number {
  const rate = cfg.aimRateDegPerSec
  return rate === null || rate === undefined ? Infinity : Math.floor((rate / 60) * UNITS_PER_DEG)
}

/** Plays one match between two real agents and records, per seat, what the limiter let through and how old the view was. */
export async function recordArenaGame(a: ArenaSeatPlan, b: ArenaSeatPlan, seed: number, maxFrames = 60 * 60 * 6): Promise<ArenaRecordedGame> {
  const plans = [a, b] as const
  // The lag is read from the view the agent itself served to its model (onObserve), not from a copy of its limiter.
  const observed = [-1, -1]
  const agents = await Promise.all(plans.map((p, seat) => createGameAgent(p.level, { seat: seat as 0 | 1, modelBytes: p.bytes, limits: p.limits, onObserve: (f: number) => { observed[seat] = f } })))
  const delays = plans.map((p) => LEVEL_LIMITS.arena[p.level].delayFrames)
  const seats: [ArenaSeatRecord, ArenaSeatRecord] = [emptySeat(), emptySeat()]
  const meters = [new PressMeter(), new PressMeter()]
  const queue: number[][] = [[], []]
  const rest = [0, 0]
  agents.forEach((ag) => ag.reset(seed))
  const s: ArenaState = createState(seed)
  let anchor = s.frame
  let phase: number = s.phase
  let frames = 0
  try {
    while (s.matchOver === 0 && frames < maxFrames) {
      if (s.phase !== phase) {
        phase = s.phase
        anchor = s.frame
      }
      for (const seat of [0, 1] as const) {
        const due = viewDue(s.frame, anchor, delays[seat]!, s.phase)
        if (!due.capture && !due.decide) continue
        observed[seat] = -1
        const tick: ArenaTick = { frame: s.frame, anchor, phase: s.phase, weapon: s.players[seat]!.weapon }
        const r = (await agents[seat]!.act(seatView(s, seat), tick)) as ArenaReply
        if (r[2] !== 1) continue
        if (observed[seat]! < 0) throw new Error('the agent decided without serving a view')
        queue[seat] = [r[0]]
        rest[seat] = r[1]
        const lag = s.frame - observed[seat]!
        const rec = seats[seat]!
        const input = unpackInput(r[0])
        rec.lags.push(lag)
        if (s.frame - anchor >= delays[seat]!) rec.lagsAfterWarmup.push(lag)
        rec.decisions.push([s.frame, input.move, flagBits(input)])
        if (s.phase === PHASE.LIVE) rec.aim.push([input.yaw, input.pitch])
      }
      const idle = buyIdle(s.frame, anchor, s.phase)
      const inputs = [0, 1].map((seat) => (s.phase === PHASE.ROUND_END || idle ? 0 : (queue[seat]!.shift() ?? rest[seat]!)))
      // The meter skips the frames the sim idles a seat (the round end and the rest of a buy phase): the limiter keeps the held input across them, as
      // the env does, so pressing it again when the seat's turn comes back is not a new press by the agent.
      if (s.phase !== PHASE.ROUND_END && !idle) for (const seat of [0, 1]) if (meters[seat]!.feed(inputs[seat]!)) seats[seat]!.pressFrames.push(s.frame)
      stepPacked(s, inputs[0]!, inputs[1]!)
      frames++
    }
  } finally {
    agents.forEach((ag) => ag.dispose())
  }
  const result = arenaCore.result(s)
  return { seed, frames, winner: (result?.winner ?? null) as 0 | 1 | null, seats }
}

/**
 * A seat that proposes random action heads at every decision for `frames` frames, through the same ArenaSeatInput
 * the agent uses, holding one weapon (semi-automatic or automatic) throughout: swapping weapons while the trigger is held
 * hands the sim a fresh press the limiter never saw, at most one per swap. Returns the frames at which the sim received
 * a press (PressMeter) and, as a cross-check, the most presses the limiter itself reports inside its window.
 */
export function stressArenaPresses(cfg: LimiterConfig, frames: number, seed: number, automatic = false): { presses: number[]; windowMax: number } {
  const hands = new ArenaSeatInput(cfg, 0)
  hands.reset(seed)
  const rng = makeRng(seed)
  const meter = new PressMeter()
  const presses: number[] = []
  let windowMax = 0
  const cap = cfg.apmCap!
  const weapon = WEAPONS.findIndex((w) => w.auto === (automatic ? 1 : 0))
  for (let f = 0; f < frames; f += FRAME_SKIP) {
    const heads = new Int32Array(ACTION_NVEC_V2.length)
    for (let d = 0; d < heads.length; d++) heads[d] = Math.floor(rng.float() * ACTION_NVEC_V2[d]!)
    if (badHead(heads, 0) >= 0) continue
    const [first, later] = hands.decide(heads, f, PHASE.LIVE, weapon)
    if (meter.feed(first)) presses.push(f)
    for (let k = 1; k < FRAME_SKIP; k++) if (meter.feed(later)) presses.push(f + k)
    windowMax = Math.max(windowMax, Math.round(cap * (1 - hands.limiter.status(f).slotsLeft)))
  }
  return { presses, windowMax }
}

// ---------------------------------------------------------------------------------------------------------------
// Publish: ladder for site Elo, the R15 gate, the registry.

/**
 * R15 publish bars (Wilson 95% lower bounds over 400 matches per bot). R30 adds the human-proxy bots peeker, strafe and
 * holdangle, and the bots now aim from their own live state with only their view of the opponent delayed (env.ts).
 * Champion plays bots that see the live game.
 */
export const ARENA_BARS: Record<Level, Record<string, number>> = {
  easy: { rusher: 0.35, holder: 0.35, random: 0.85, peeker: 0.35, strafe: 0.35, holdangle: 0.35 },
  medium: { rusher: 0.5, holder: 0.5, random: 0.9, peeker: 0.5, strafe: 0.5, holdangle: 0.5 },
  hard: { rusher: 0.6, holder: 0.6, random: 0.95, peeker: 0.6, strafe: 0.6, holdangle: 0.6 },
  champion: { rusher: 0.75, holder: 0.75, peeker: 0.75, strafe: 0.75, holdangle: 0.75 },
}

/**
 * Why the arena levels are paired against the next published level below, and what the seats do to the ladder. Measured
 * (not a universal claim): hard against hard, seat 0 won 64 of 64 matches in the Python env and 20 of 20 in the TypeScript
 * harness; with the published easy.onnx on seat 0 and hard.onnx on seat 1, seeds 2000 to 2005 gave seat 0 two wins and
 * seat 1 four, and with hard on seat 0 it gave seat 0 six of six. Seat 0 is strongly favoured between near-equal policies, so the
 * seat-swapped head-to-head score of a pair of snapshots sits near 0.5 unless the upper one is clearly stronger.
 */
export const LADDER_NOTE =
  'Seat 0 is strongly favoured in policy-versus-policy arena matches (hard vs hard: seat 0 won 64 of 64 in the training env and 20 of 20 in the harness; easy on seat 0 vs hard on seat 1 over seeds 2000 to 2005: seat 0 won 2, seat 1 won 4; hard on seat 0 won 6 of 6). The Levels rule (stronger level scores above 50% with a 95% Wilson lower bound, seats swapped each game) is therefore applied against the next published level below, and a level that does not clear it is not published.'

/** Recorded when no level cleared the scripted-bot gate, so nothing was laddered. */
export const NO_LADDER_NOTE =
  'Not measured: no level cleared the scripted-bot gate (R30: the bots aim from their own live state and include a peeker, a strafer and an angle holder), so no site Elo is published.'

export interface ArenaLadderPair {
  lower: Level
  upper: Level
  /** The upper level's score over `n` seat-swapped matches. */
  score: number
  n: number
}

/** The 95% Wilson lower bound of the upper level's score in a pair. */
export const pairLowerBound = (p: Pick<ArenaLadderPair, 'score' | 'n'>): number => wilson(p.score * p.n, p.n)[0]

/**
 * The Levels rule (Global Constraints): going up the ladder, a level that passed the scripted-bot gate is published only if
 * its seat-swapped head-to-head score against the highest level already published has a Wilson lower bound above 0.5.
 * A level that fails is "in training" with the reason, and the next candidate is paired against the same published level
 * below it. The lowest candidate is the anchor. `playPair` returns the upper level's points over `games` matches.
 */
export async function applyLevelsRule(
  candidates: readonly Level[],
  playPair: (lower: Level, upper: Level, games: number) => Promise<number>,
  games: number,
): Promise<{ published: Level[]; pairs: ArenaLadderPair[]; failures: Partial<Record<Level, string>> }> {
  const published: Level[] = []
  const pairs: ArenaLadderPair[] = []
  const failures: Partial<Record<Level, string>> = {}
  for (const upper of candidates) {
    const lower = published[published.length - 1]
    if (!lower) {
      published.push(upper)
      continue
    }
    const points = await playPair(lower, upper, games)
    const pair: ArenaLadderPair = { lower, upper, score: points / games, n: games }
    pairs.push(pair)
    const lb = pairLowerBound(pair)
    if (lb > 0.5) published.push(upper)
    else failures[upper] = `in training: ${upper} does not beat ${lower}: scored ${points} of ${games} head to head with the seats swapped, Wilson lower bound ${lb.toFixed(4)} is not above 0.5 (seat 0 is strongly favoured between arena policies, see gate.ladder.note)`
  }
  return { published, pairs, failures }
}

/** Site Elo along the published chain: the first level is the anchor, each next level adds 400 log10(s / (1 - s)) of its pair score. */
export function chainElo(published: readonly Level[], pairs: readonly ArenaLadderPair[], anchor: number): Partial<Record<Level, number>> {
  const elo: Partial<Record<Level, number>> = {}
  published.forEach((level, i) => {
    if (i === 0) {
      elo[level] = anchor
      return
    }
    const pair = pairs.find((p) => p.upper === level && p.lower === published[i - 1])
    if (!pair) throw new Error(`chainElo: no pair for ${level} against ${published[i - 1]}`)
    const s = Math.min(0.999, Math.max(0.001, pair.score))
    elo[level] = elo[published[i - 1]!]! + 400 * Math.log10(s / (1 - s))
  })
  return elo
}

export const gateArenaLevel = (level: Level, rows: BotRow[]) => {
  const verdict = gateLevel(level, rows, ARENA_BARS, true, GATE_MATCHES)
  if (level === 'easy') {
    const proxy = rows.find((row) => row.bot === 'human-proxy')
    if (!proxy || proxy.games < GATE_MATCHES || proxy.losses / proxy.games < 0.3) {
      verdict.failures.push('Easy needs at least 400 matches and 30% losses against human-proxy')
      verdict.passed = false
    }
  }
  return verdict
}

export const ARENA_GATE: GameGate = { game: 'arena', bars: ARENA_BARS, v2Features: 90, botNames: 'rusher, holder, peeker, strafe, holdangle and random', perSeat: true, seatGames: GATE_MATCHES, verdict: gateArenaLevel }

/** A registry never carries a machine path: a snapshot path under the common root becomes repo-relative. */
export function relativeSource(source: string, root: string): string {
  if (!isAbsolute(source)) return source
  const rel = relative(root, source)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`snapshot path is outside the common root: ${source}`)
  return rel.split(sep).join('/')
}

export const buildArenaRegistry = (input: PublishInput): Registry => buildGameRegistry(ARENA_GATE, input)

/** Plays `games` matches of the upper level against the lower level with seats swapping each game: the upper level's points. */
export async function playArenaPairPoints(lower: ArenaSeatPlan, upper: ArenaSeatPlan, games: number): Promise<number> {
  let points = 0
  for (let i = 0; i < games; i++) {
    const upperSeat = (i % 2) as 0 | 1
    const g = await recordArenaGame(upperSeat === 0 ? upper : lower, upperSeat === 0 ? lower : upper, 1000 + i)
    points += g.winner === null ? 0.5 : g.winner === upperSeat ? 1 : 0
  }
  return points
}

export { GATE_MATCHES, writeRegistry }

// ---------------------------------------------------------------------------------------------------------------
// CLI:  bun packages/agents/src/measure/arena.ts publish --evals <dir> --scratch <dir> [--games 400] [--hold <level>=<reason>]...
//   --hold keeps a level that passed the training gate unpublished with the given reason (KC3: the shipped agent, played by the browser-side
//   harness in arena-fairness.test.ts, must also clear the bars; a level it fails is held back even if the Python gate passed it).
//   <dir>/{easy,medium,hard,champion}.json  eval_bots.py output (a level with no file is not published)
//   <dir>/sources.json                       {level: {source, step, obsFeatures}} for the published levels
//   <scratch>/<level>.onnx                  ladder anchor for a level that is not published yet (never served); optional
// The published models are read from apps/web/public/agents/arena/v1/. Writes packages/agents/registry/arena.json.

async function publishMain(argv: string[]): Promise<void> {
  const arg = (name: string) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined)
  const evals = arg('evals')
  const scratch = arg('scratch')
  if (argv[0] !== 'publish' || !evals || !scratch) throw new Error('usage: arena.ts publish --evals <dir> --scratch <dir> [--games 400]')
  const { existsSync } = await import('node:fs')
  const { execSync } = await import('node:child_process')
  const { join, resolve } = await import('node:path')
  const root = resolve(import.meta.dir, '../../../..')
  const v1 = join(root, 'apps/web/public/agents/arena/v1')
  const read = async (p: string) => new Uint8Array(await Bun.file(p).arrayBuffer())
  const rows: PublishInput['rows'] = {}
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
    const path = join(evals, `${level}.json`)
    if (existsSync(path)) rows[level] = JSON.parse(readFileSync(path, 'utf8')) as BotRow[]
  }
  const { commonRoot } = await import('../../../../scripts/paths')
  const common = commonRoot(root)
  const meta = JSON.parse(readFileSync(join(evals, 'sources.json'), 'utf8')) as Record<string, { source: string; step: number; obsFeatures: number }>
  for (const m of Object.values(meta)) m.source = relativeSource(m.source, common)
  const plans: Partial<Record<Level, ArenaSeatPlan>> = {}
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
    const file = existsSync(join(v1, `${level}.onnx`)) ? join(v1, `${level}.onnx`) : join(scratch, `${level}.onnx`)
    if (existsSync(file)) plans[level] = { level, bytes: await read(file) }
  }
  // Only a level that cleared the scripted-bot gate, from a snapshot saved by the gate (runs/<run>/gated/), is a candidate.
  const isGated = (source: string) => /[/\\]gated[/\\]/.test(source)
  const held: Partial<Record<Level, string>> = {}
  argv.forEach((a, i) => {
    if (a !== '--hold') return
    const [level, ...reason] = (argv[i + 1] ?? '').split('=')
    if (!['easy', 'medium', 'hard', 'champion'].includes(level ?? '') || reason.length === 0) throw new Error('usage: --hold <level>=<reason>')
    held[level as Level] = `in training: ${reason.join('=')}`
  })
  const candidates = (['easy', 'medium', 'hard', 'champion'] as const).filter((l) => {
    const m = meta[l]
    return Boolean(m && plans[l] && rows[l] && gateArenaLevel(l, rows[l]!).passed && isGated(m.source) && !held[l])
  })
  const games = Number(arg('games') ?? GATE_MATCHES)
  const ruled = await applyLevelsRule(candidates, (lower, upper, g) => playArenaPairPoints(plans[lower]!, plans[upper]!, g), games)
  const elo = chainElo(ruled.published, ruled.pairs, 1000)
  const models: PublishInput['models'] = {}
  const gatedSnapshot: PublishInput['gatedSnapshot'] = {}
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
    const m = meta[level]
    if (!m) continue
    models[level] = { artifact: `apps/web/public/agents/arena/v1/${level}.onnx`, absolute: join(v1, `${level}.onnx`), ...m }
    gatedSnapshot[level] = isGated(m.source)
  }
  const pairs = ruled.pairs.map((p) => ({ ...p, lowerBound95: Math.round(pairLowerBound(p) * 1e6) / 1e6 }))
  const reg = buildArenaRegistry({
    rows,
    models,
    elo,
    gatedSnapshot,
    levelFailures: { ...ruled.failures, ...held },
    commit: execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(),
    now: new Date().toISOString(),
    trainedSteps: ruled.published.reduce((n, l) => n + meta[l]!.step, 0),
    ladder: candidates.length ? { pairs, note: LADDER_NOTE } : { pairs: [], note: NO_LADDER_NOTE },
  })
  await writeRegistry(join(root, 'packages/agents/registry/arena.json'), reg)
  console.log(JSON.stringify({ pairs, elo, published: Object.keys(reg.levels), unpublished: reg.unpublished }, null, 2))
}

if (import.meta.main) await publishMain(process.argv.slice(2))
