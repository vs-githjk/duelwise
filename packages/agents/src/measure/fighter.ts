import { peopleGatedFor } from './a9-apply'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ladderToElo } from '@duelwise/core/src/elo'
import type { Level } from '@duelwise/core/src/product'
import type { LimiterConfig } from '@duelwise/core/src/limiter'
import { DelayedStates, LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { createBot, FIGHTER_BOT_KINDS, type BotKind } from '@duelwise/core/src/games/fighter/bots'
import { buildObs } from '@duelwise/core/src/games/fighter/encode'
import { fighterCore, stepPacked } from '@duelwise/core/src/games/fighter/core'
import { agentInputLagFor } from '@duelwise/core/src/games/fighter/constants'
import { N_BUTTONS, N_DIRS, packInput } from '@duelwise/core/src/games/fighter/input'
import { copyState, createState, PHASE, type FighterState } from '@duelwise/core/src/games/fighter/state'
import { makeRng } from '@duelwise/core/src/rng'
import { createGameAgent, PRACTICE_MODELS } from '../fighter/agent'
import { parseRegistry, writeRegistry, type Registry } from '../registry'
import { harnessRuntime } from './harness'
import { separationFailures, wilson } from './ladder'
import { FighterSeatInput, InputLag, seatView, viewDue } from '../fighter/view'

// Fighter measurement (T25): recorded games for the limiter compliance check, and the gate and registry
// helpers `publish` uses. The publish gate measures the served runtime against the scripted bots.

export const MINUTE_FRAMES = 3600

export interface SeatRecord {
  /** Held input after the limiter, one entry per decision: [frame, dir, btn]. */
  decisions: Array<[number, number, number]>
  /** Frames between each decision and the frame of the view it read (read from the view the agent served to its own model). */
  lags: number[]
  /** The same, without the first `delayFrames` frames of each round (the limiter serves its oldest view while the delay has not elapsed). */
  lagsAfterWarmup: number[]
  /** Frames at which a new press was accepted. */
  pressFrames: number[]
}

export interface RecordedGame {
  seed: number
  frames: number
  /** The seat that won the match, null for a draw or when the frame cap ended it. */
  winner: 0 | 1 | null
  seats: [SeatRecord, SeatRecord]
}

export interface SeatPlan {
  level: Level
  bytes: Uint8Array
  /** Negative probes only: build the agent with this limiter instead of its level's. The schedule stays the level's. */
  limits?: LimiterConfig
}

export function medianLag(lags: number[]): number {
  if (lags.length === 0) return NaN
  const s = [...lags].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** Most presses inside any 3600-frame window. `frames` must be ascending. */
export function maxPressesPerMinute(frames: number[]): number {
  let best = 0
  let lo = 0
  for (let hi = 0; hi < frames.length; hi++) {
    while (frames[hi]! - frames[lo]! >= MINUTE_FRAMES) lo++
    best = Math.max(best, hi - lo + 1)
  }
  return best
}

/** The R15 press rule for the fighter: a direction that differs from the held one and is not neutral, or a button that is newly down. */
export function isPress(prev: readonly number[], next: readonly number[]): boolean {
  return (next[0] !== 0 && next[0] !== prev[0]) || (next[1] !== 0 && next[1] !== prev[1])
}

const emptySeat = (): SeatRecord => ({ decisions: [], lags: [], lagsAfterWarmup: [], pressFrames: [] })

/** Plays one match between two real agents and records, per seat, what the limiter let through and how old the view was. */
export async function recordGame(a: SeatPlan, b: SeatPlan, seed: number, maxFrames = 60 * 60 * 6): Promise<RecordedGame> {
  const plans = [a, b] as const
  // The lag is read from the view the agent itself served to its model (onObserve), not from a copy of its limiter.
  const observed = [-1, -1]
  const agents = await Promise.all(plans.map((p, seat) => createGameAgent(p.level, { seat: seat as 0 | 1, modelBytes: p.bytes, limits: p.limits, onObserve: (f: number) => { observed[seat] = f } } as never)))
  const cfgs = plans.map((p) => LEVEL_LIMITS.fighter[p.level])
  const seats: [SeatRecord, SeatRecord] = [emptySeat(), emptySeat()]
  const held: number[][] = [[0, 0], [0, 0]]
  // LC1: both seats are agents, so both hold a decision from the frame the env's lag for this seed says (the page's and the trainer's rule).
  const inputs = [new InputLag(), new InputLag()] as const
  const lagFrames = agentInputLagFor(seed)
  agents.forEach((ag) => ag.reset(seed))
  const s: FighterState = createState(seed)
  let anchor = -1
  let frames = 0
  try {
    while (s.matchOver === 0 && frames < maxFrames) {
      if (s.phase === PHASE.FIGHT) {
        if (anchor < 0) anchor = s.frame
        for (const seat of [0, 1] as const) {
          const due = viewDue(s.frame, anchor, cfgs[seat]!.delayFrames)
          if (!due.capture && !due.decide) continue
          observed[seat] = -1
          const next = await agents[seat]!.act(seatView(s, seat), { frame: s.frame, anchor })
          if (!due.decide) continue
          if (observed[seat]! < 0) throw new Error('the agent decided without serving a view')
          const lag = s.frame - observed[seat]!
          const rec = seats[seat]!
          rec.lags.push(lag)
          if (s.frame - anchor >= cfgs[seat]!.delayFrames) rec.lagsAfterWarmup.push(lag)
          if (isPress(held[seat]!, next)) rec.pressFrames.push(s.frame)
          held[seat] = [next[0]!, next[1]!]
          inputs[seat]!.decide(s.frame, packInput({ dir: next[0]!, btn: next[1]! }), lagFrames)
          rec.decisions.push([s.frame, next[0]!, next[1]!])
        }
      } else {
        // The limiter keeps the held input across rounds, so the press bookkeeping does too.
        anchor = -1
      }
      const f = s.phase === PHASE.FIGHT
      stepPacked(s, f ? inputs[0]!.at(s.frame) : 0, f ? inputs[1]!.at(s.frame) : 0)
      frames++
    }
  } finally {
    agents.forEach((ag) => ag.dispose())
  }
  const result = fighterCore.result(s)
  return { seed, frames, winner: (result?.winner ?? null) as 0 | 1 | null, seats }
}

/**
 * A seat that proposes a random input at every decision for `frames` frames, through the same FighterSeatInput
 * the agent uses. Returns the frames at which a press was accepted (the cap must hold in every minute).
 */
export function stressPresses(cfg: LimiterConfig, frames: number, seed: number): number[] {
  const hands = new FighterSeatInput(cfg, 0)
  hands.reset(seed)
  const rng = makeRng(seed)
  let held: number[] = [0, 0]
  const presses: number[] = []
  for (let f = 0; f < frames; f += 4) {
    const next = hands.choose(Math.floor(rng.float() * N_DIRS), Math.floor(rng.float() * N_BUTTONS), f)
    if (isPress(held, next)) presses.push(f)
    held = next
  }
  return presses
}

// ---------------------------------------------------------------------------------------------------------------
// Publish: ladder for site Elo, the R15 gate, the registry.

export interface BotRow {
  bot: string
  games: number
  wins: number
  draws: number
  losses: number
  score: number
  ci95: [number, number]
  /** The learner's result on each seat. */
  bySeat?: Record<'0' | '1', { games: number; wins: number; draws: number; losses: number; score: number }>
}

/** Plays the served agent against a bot using the environment's bot view and limiter rules. */
export async function servedBotGame(plan: SeatPlan, kind: BotKind, seat: 0 | 1, seed: number): Promise<0 | 0.5 | 1> {
  const botSeat = (1 - seat) as 0 | 1
  const cfg = LEVEL_LIMITS.fighter[plan.level]
  const agent = await createGameAgent(plan.level, { seat, modelBytes: plan.bytes })
  const hands = new FighterSeatInput(cfg, botSeat)
  hands.reset(seed)
  agent.reset(seed)
  const bot = createBot(kind, ((seed + 104729 * (botSeat + 1)) >>> 0) + FIGHTER_BOT_KINDS.indexOf(kind))
  const history = new DelayedStates<FighterState>(cfg.delayFrames, () => createState(0), copyState)
  const lag = new InputLag()
  const s = createState(seed)
  let anchor = -1
  let botHeld = 0
  try {
    while (!s.matchOver && s.frame < 60 * 60 * 8) {
      if (s.phase === PHASE.FIGHT) {
        if (anchor < 0) { anchor = s.frame; history.clear(); hands.startRound() }
        const due = viewDue(s.frame, anchor, cfg.delayFrames)
        if (due.capture) history.record(s.frame, s)
        if (due.capture || due.decide) {
          const a = await agent.act(seatView(s, seat), { frame: s.frame, anchor })
          if (due.decide) lag.decide(s.frame, packInput({ dir: a[0]!, btn: a[1]! }), agentInputLagFor(seed))
        }
        if (due.decide) {
          const view = buildObs(plan.level === 'champion' ? s : history.view(s.frame).state, botSeat)
          const action = bot.act(view)
          hands.mirrored = view.mirrored
          const held = hands.choose(action % N_DIRS, Math.floor(action / N_DIRS), s.frame)
          botHeld = packInput({ dir: held[0], btn: held[1] })
        }
        const ai = lag.at(s.frame)
        stepPacked(s, seat === 0 ? ai : botHeld, seat === 0 ? botHeld : ai)
      } else { anchor = -1; stepPacked(s, 0, 0) }
    }
    if (!s.matchOver) throw new Error(`served bot match exceeded frame cap: ${plan.level} vs ${kind}, seat ${seat}, seed ${seed}`)
    const winner = fighterCore.result(s)?.winner ?? null
    return winner === null ? 0.5 : winner === seat ? 1 : 0
  } finally { agent.dispose() }
}

export async function measureServedBots(plan: SeatPlan, gamesPerSeat = GATE_MATCHES): Promise<BotRow[]> {
  const rows: BotRow[] = []
  for (const kind of Object.keys(BARS[plan.level]) as BotKind[]) {
    const bySeat = {} as NonNullable<BotRow['bySeat']>
    for (const seat of [0, 1] as const) {
      let wins = 0, draws = 0
      for (let i = 0; i < gamesPerSeat; i++) {
        const result = await servedBotGame(plan, kind, seat, 1000 + i)
        if (result === 1) wins++
        else if (result === 0.5) draws++
      }
      bySeat[seat] = { games: gamesPerSeat, wins, draws, losses: gamesPerSeat - wins - draws, score: (wins + draws * 0.5) / gamesPerSeat }
    }
    const wins = bySeat[0].wins + bySeat[1].wins, draws = bySeat[0].draws + bySeat[1].draws
    const games = gamesPerSeat * 2
    rows.push({ bot: kind, games, wins, draws, losses: games - wins - draws, score: (wins + draws * 0.5) / games, ci95: wilson(wins + draws * 0.5, games), bySeat })
  }
  return rows
}

/** R15 publish bars: Wilson 95% lower bounds over 400 matches per bot. Champion plays bots that see the live game. */
export const BARS: Record<Level, Record<string, number>> = {
  easy: { rushdown: 0.35, turtle: 0.35, random: 0.85 },
  medium: { rushdown: 0.5, turtle: 0.5, random: 0.9 },
  // R30: Hard and Champion must also beat the judge's loops (zoner, throwloop, backwalk); Easy and Medium have no exploit bar.
  // KC1 (tinderbox-r2): and the crouch-light loop, the sweep spam and the range fireball. LC1 (tinderbox-r3): and the throw tapped at its own cadence.
  hard: { rushdown: 0.6, turtle: 0.6, random: 0.95, zoner: 0.6, throwloop: 0.6, backwalk: 0.6, pokeloop: 0.6, sweepspam: 0.6, fireball: 0.6, fireball25: 0.6, throwtap: 0.6 },
  champion: { rushdown: 0.75, turtle: 0.75, zoner: 0.75, throwloop: 0.75, backwalk: 0.75, pokeloop: 0.75, sweepspam: 0.75, fireball: 0.75, fireball25: 0.75, throwtap: 0.75 },
}

/** Champion may not trail Hard against any loop they are both gated on by more than this many points (tinderbox-r2: Champion lost the crouch loop 30/30 where Hard lost 22/30). */
export const CHAMPION_TRAIL_MARGIN = 0.02

/** The reason Champion fails the "Champion is at least Hard" rule, or null. Compares per-bot scores of the two levels' rows on the bots both have a bar for. */
export function championTrailsHard(hard: BotRow[], champion: BotRow[], bars: Record<Level, Record<string, number>> = BARS): string | null {
  const trails: string[] = []
  for (const bot of Object.keys(bars.champion)) {
    if (bars.hard[bot] === undefined) continue
    const h = hard.find((r) => r.bot === bot)
    const c = champion.find((r) => r.bot === bot)
    if (!h || !c) continue
    if (c.score < h.score - CHAMPION_TRAIL_MARGIN) trails.push(`${bot} ${c.score.toFixed(3)} vs Hard ${h.score.toFixed(3)}`)
  }
  return trails.length ? `Champion trails Hard against ${trails.join(', ')}` : null
}

export const GATE_MATCHES = 400

export interface GateVerdict {
  passed: boolean
  /** The bot with the lowest lower bound, the one the registry's measured block reports. */
  weakest: BotRow
  failures: string[]
}

/** Applies the bars to a level's rows (rows for bots without a bar are ignored). Missing bots, or fewer than 400 matches, fail. */
export function gateLevel(level: Level, rows: BotRow[], bars: Record<Level, Record<string, number>> = BARS, perSeat = false, seatGames = GATE_MATCHES / 2): GateVerdict {
  const failures: string[] = []
  let weakest: BotRow | null = null
  const lowerOf = (r: Pick<BotRow, 'wins' | 'draws' | 'games'>): number => wilson(r.wins + 0.5 * r.draws, r.games)[0]
  for (const [bot, bar] of Object.entries(bars[level])) {
    const row = rows.find((r) => r.bot === bot)
    if (!row) {
      failures.push(`no measurement against ${bot}`)
      continue
    }
    if (row.games < GATE_MATCHES) failures.push(`${bot}: ${row.games} matches, the gate needs ${GATE_MATCHES}`)
    const lower = lowerOf(row)
    if (lower < bar) failures.push(`${bot}: ${row.wins + row.draws * 0.5} of ${row.games}, Wilson lower bound ${lower.toFixed(4)} is below ${bar}`)
    if (!perSeat) {
      if (!weakest || lower < lowerOf(weakest)) weakest = row
      continue
    }
    // Per seat: the page seats the AI on one seat, so each seat must clear the bar by itself, and the claim rests on the weakest seat of the weakest bot.
    if (!row.bySeat) {
      failures.push(`${bot}: no per-seat measurement (rows must include bySeat)`)
      continue
    }
    for (const seat of ['0', '1'] as const) {
      const s = row.bySeat[seat]
      if (s.games < seatGames) failures.push(`${bot} on seat ${seat}: ${s.games} matches, the gate needs ${seatGames} per seat`)
      const sl = lowerOf(s)
      if (sl < bar) failures.push(`${bot} on seat ${seat}: ${s.wins} wins, ${s.draws} draws of ${s.games}, Wilson lower bound ${sl.toFixed(4)} is below ${bar}`)
      const seatRow: BotRow = { bot: `${bot}`, games: s.games, wins: s.wins, draws: s.draws, losses: s.losses, score: s.score, ci95: [0, 1] }
      if (!weakest || sl < lowerOf(weakest)) weakest = seatRow
    }
  }
  return { passed: failures.length === 0 && weakest !== null, weakest: weakest ?? rows[0]!, failures }
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const round6 = (x: number) => Math.round(x * 1e6) / 1e6
const seatDetail = (s: { games: number; wins: number; draws: number; losses: number; score: number }) => ({ games: s.games, wins: s.wins, draws: s.draws, losses: s.losses, score: round6(s.score), lower: round6(wilson(s.wins + 0.5 * s.draws, s.games)[0]) })

export interface PublishInput {
  /** Per level: bot gate rows. The fighter publisher measures these with the served agent. */
  rows: Partial<Record<Level, BotRow[]>>
  /** Where each published level's ONNX lives, repo-relative, and the training provenance. */
  models: Partial<Record<Level, { artifact: string; absolute: string; source: string; step: number; obsFeatures: number }>>
  /** Site Elo of every level that has a chain back to the Easy anchor. */
  elo: Partial<Record<Level, number>>
  /** Lowest-level rows the unpublished levels explain themselves with. */
  gatedSnapshot: Partial<Record<Level, boolean>>
  servedPractice?: Partial<Record<Level, true>>
  /** Levels that passed the scripted-bot gate but fail the Levels rule (head-to-head against the level below): the reason each is "in training". */
  levelFailures?: Partial<Record<Level, string>>
  commit: string
  now: string
  trainedSteps: number
  /** Recorded into the gate block when given: the adjacent-level ladder pairs and anything a reader needs to interpret the Elo. */
  ladder?: unknown
  /**
   * Easy and Medium levels whose people test is in band: the ruling of Nov 10 18:52 has the people panel and the ladder decide them, so the scripted-bot
   * bars do not publish or hold back the level (the rows are still measured and recorded, and the Levels rule still applies). Hard and Champion never get this.
   */
  peopleGated?: Partial<Record<Level, true>>
}

/** Only Easy and Medium may be gated by their people test instead of the scripted-bot bars (ruling Nov 10 18:52). */
export const PEOPLE_GATED_LEVELS: readonly Level[] = ['easy', 'medium']

/** What differs between the games' registries (the fighter's and the arena's share this builder). */
export interface GameGate {
  game: 'fighter' | 'arena'
  bars: Record<Level, Record<string, number>>
  /** Input width of a v2 model (the observation plus the own-input extras). */
  v2Features: number
  /** The scripted bots, for the registry text. */
  botNames: string
  /** The gate needs each seat to clear every bar on its own (the arena seats the AI on one seat). */
  perSeat?: boolean
  seatGames?: number
  verdict?: (level: Level, rows: BotRow[]) => GateVerdict
}

export function buildFighterRegistry(input: PublishInput): Registry {
  return buildGameRegistry({ game: 'fighter', bars: BARS, v2Features: 162, perSeat: true, seatGames: GATE_MATCHES, botNames: 'rushdown, turtle, random, zoner, throwloop, backwalk, pokeloop, sweepspam, fireball, throwtap and fireball25' }, input)
}

/** Builds a game's registry: a level with a passing gate is published and measured, every other level is "in training" with the reason. */
export function buildGameRegistry(g: GameGate, input: PublishInput): Registry {
  const artifacts: Record<string, string> = {}
  const hashes: Record<string, string> = {}
  const levels: Registry['levels'] = {}
  const measured: Registry['measured'] = {}
  const unpublished: NonNullable<Registry['unpublished']> = {}
  const gate: Record<string, unknown> = { rule: g.perSeat ? `R15: ${g.seatGames ?? GATE_MATCHES / 2} matches per bot on each seat, bots under the same limits and delayed view; a level publishes when the Wilson 95% lower bound clears the bar against every bot on each seat by itself` : 'R15: 400 matches per bot, learner on both seats, bots under the same limits and delayed view; a level publishes when the Wilson 95% lower bound clears the bar against every bot', matches: g.perSeat ? (g.seatGames ?? GATE_MATCHES / 2) * 2 : GATE_MATCHES, levels: {} as Record<string, unknown> }
  if (input.ladder !== undefined) gate.ladder = input.ladder
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
    const rows = input.rows[level]
    const model = input.models[level]
    const verdict = rows ? (g.verdict ? g.verdict(level, rows) : gateLevel(level, rows, g.bars, g.perSeat === true, g.seatGames)) : null
    // Only a level that misses its bars takes the exemption; one that clears them is published on them and carries no flag.
    const exempt = verdict !== null && !verdict.passed && input.peopleGated?.[level] === true && PEOPLE_GATED_LEVELS.includes(level)
    const passes = Boolean(verdict?.passed) || exempt
    const detail = rows?.map((r) => ({ bot: r.bot, wins: r.wins, draws: r.draws, losses: r.losses, score: round6(r.score), lower: round6(wilson(r.wins + 0.5 * r.draws, r.games)[0]), bar: g.bars[level][r.bot] ?? null, ...(r.bySeat ? { bySeat: { '0': seatDetail(r.bySeat['0']), '1': seatDetail(r.bySeat['1']) } } : {}) }))
    ;(gate.levels as Record<string, unknown>)[level] = { bots: detail ?? null, source: model?.source ?? null, step: model?.step ?? null, ...(exempt ? { peopleGated: true } : {}) }
    if (passes && model && input.levelFailures?.[level]) {
      unpublished[level] = input.levelFailures[level]!
    } else if (passes && model && input.gatedSnapshot[level]) {
      const siteElo = input.elo[level]
      if (siteElo === undefined) throw new Error(`${level} passed the gate and is a gated snapshot but has no site Elo: it was not laddered by the Levels rule`)
      const name = model.artifact.split('/').pop()!
      artifacts[name] = model.artifact
      hashes[name] = sha256(model.absolute)
      levels[level] = { version: 'v1', config: { model: name, observation: model.obsFeatures === g.v2Features ? 'v2' : 'v1', obsFeatures: model.obsFeatures, sampling: 'policy samples' } }
      const w = verdict!.weakest
      const [lo, hi] = wilson(w.wins + 0.5 * w.draws, w.games)
      measured[level] = {
        metric: g.perSeat ? `score vs scripted ${w.bot} bot (weakest seat of the weakest gate bot)` : `score vs scripted ${w.bot} bot (weakest of the gate bots)`,
        value: round6(w.score),
        ci95: [round6(lo), round6(hi)],
        n: w.games,
        opponents: level === 'champion' ? 'scripted bots that see the live game' : `scripted ${g.botNames} bots under the same limits and delayed view${exempt ? ' (recorded, not a publish bar: this level is gated by its people test and the ladder)' : ''}`,
        siteElo: round6(siteElo),
        measuredAt: input.now,
        harness: harnessRuntime(),
        commit: input.commit,
      }
    } else if (model && verdict && !verdict.passed && input.servedPractice?.[level]) {
      if (g.game === 'fighter') {
        const name = model.artifact.split('/').pop()!
        artifacts[name] = model.artifact
        hashes[name] = sha256(model.absolute)
      }
      const levelFailure = input.levelFailures?.[level]
      unpublished[level] = `in training: ${verdict.failures.join('; ')}${levelFailure ? `; ${levelFailure}` : ''}. Practice serves the ${model.source} snapshot.`
    } else if (!model || !input.gatedSnapshot[level]) {
      // KC3: the reason names only the bots the final checkpoint actually failed, never one it cleared.
      const last = verdict ? (verdict.failures.length > 0 ? ` Final checkpoint measured: ${verdict.failures.join('; ')}.` : ' Final checkpoint measured: it clears every bar, but it was not a gated snapshot.') : ''
      unpublished[level] = `in training: no snapshot cleared the scripted-bot gate during training, so ${level} is not published.${last}`
    } else {
      unpublished[level] = `in training: ${verdict ? verdict.failures.join('; ') : 'not measured'}`
    }
  }
  const reg: Registry = {
    game: g.game,
    champion: 'v1',
    versions: [
      {
        version: 'v1',
        parent: null,
        createdAt: input.now,
        promotedAt: input.now,
        status: 'measured',
        artifacts,
        sha256: hashes,
        trainedSteps: input.trainedSteps,
        humanMatchesUsed: 0,
        gate,
      },
    ],
    levels,
    measured,
    unpublished,
    learnsFromHumans: false,
  }
  return parseRegistry(reg)
}

/** Plays `games` matches of the upper level against the lower level with seats swapping each game: the upper level's points. */
export async function playPairPoints(lower: SeatPlan, upper: SeatPlan, games: number): Promise<number> {
  let points = 0
  for (let i = 0; i < games; i++) {
    const upperSeat = ((i >> 1) % 2) as 0 | 1
    const g = await recordGame(upperSeat === 0 ? upper : lower, upperSeat === 0 ? lower : upper, 1000 + i)
    points += g.winner === null ? 0.5 : g.winner === upperSeat ? 1 : 0
  }
  return points
}

export async function ladderElo(plans: Record<Level, SeatPlan>, games: number): Promise<{ elo: Partial<Record<Level, number>>; pairs: Array<{ lower: Level; upper: Level; score: number; n: number }> }> {
  const order: Level[] = ['easy', 'medium', 'hard', 'champion']
  const pairs: Array<{ lower: Level; upper: Level; score: number; n: number }> = []
  for (let i = 0; i + 1 < order.length; i++) {
    const [lower, upper] = [order[i]!, order[i + 1]!]
    const points = await playPairPoints(plans[lower], plans[upper], games)
    pairs.push({ lower, upper, score: points / games, n: games })
  }
  return { elo: ladderToElo(pairs, { level: 'easy', elo: 1000 }), pairs }
}

export { writeRegistry }

// ---------------------------------------------------------------------------------------------------------------
// CLI:  bun packages/agents/src/measure/fighter.ts behavior [--trace]
//   Reports seeded idle, held-input and fresh-attack repetition statistics, with optional frame traces.
//   bun packages/agents/src/measure/fighter.ts publish --evals <dir> --scratch <dir> [--games 400]
//   <dir>/{easy,medium,hard,champion}.json  training diagnostics identify levels to measure (a level with no file is not published)
//   <scratch>/{easy,medium,hard,champion}.onnx  copies of the model each level serves (PRACTICE_MODELS)
// The published models are read from apps/web/public/agents/fighter/v1/. Writes packages/agents/registry/fighter.json and the served rows to packages/agents/eval/fighter/.

/** Levels held back at publish: Champion trailing Hard against a loop (KC1), or any upper level whose ladder pair did not separate (95% lower bound above 0.5). */
export function fighterLevelFailures(trail: string | null, pairs: Array<{ lower: Level; upper: Level; score: number; n: number }>): Partial<Record<Level, string>> | undefined {
  const out: Partial<Record<Level, string>> = {}
  if (trail) out.champion = trail
  for (const [level, text] of Object.entries(separationFailures(pairs)) as Array<[Level, string]>) out[level] = out[level] ? `${out[level]}; ${text}` : text
  const entries = Object.entries(out) as Array<[Level, string]>
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries.map(([l, t]) => [l, `did not pass our strength test yet: ${t}`])) as Partial<Record<Level, string>>
}

export function readFailedLevels(argv: string[], readRows: (path: string) => BotRow[]): Partial<Record<Level, BotRow[]>> {
  const failed: Partial<Record<Level, BotRow[]>> = {}
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--failed') continue
    const value = argv[++index] ?? ''
    const separator = value.indexOf('=')
    const level = value.slice(0, separator) as Level
    const path = value.slice(separator + 1)
    if (separator < 1 || !path || !['easy', 'medium', 'hard', 'champion'].includes(level)) throw new Error('--failed must be level=rows-file')
    if (failed[level]) throw new Error(`duplicate --failed ${level}`)
    const measured = readRows(path)
    if (gateLevel(level, measured, BARS, true, GATE_MATCHES).passed) throw new Error(`--failed ${level} passed the gate`)
    failed[level] = measured
  }
  return failed
}

async function publishMain(argv: string[]): Promise<void> {
  const arg = (name: string) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined)
  const evals = arg('evals')
  const scratch = arg('scratch')
  if (argv[0] !== 'publish' || !evals || !scratch) throw new Error('usage: fighter.ts publish --evals <dir> --scratch <dir> [--games 400]')
  const { existsSync } = await import('node:fs')
  const { execSync } = await import('node:child_process')
  const { join, resolve } = await import('node:path')
  const root = resolve(import.meta.dir, '../../../..')
  const servedPath = (level: Level) => `apps/web/public/${PRACTICE_MODELS[level]}`
  const read = async (p: string) => new Uint8Array(await Bun.file(p).arrayBuffer())
  const rows: PublishInput['rows'] = {}
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
    const path = join(evals, `${level}.json`)
    if (existsSync(path)) rows[level] = JSON.parse(readFileSync(path, 'utf8')) as BotRow[]
  }
  // Read before any measurement so a missing sources file fails in seconds, not after the ladder.
  const meta = JSON.parse(readFileSync(join(evals, 'sources.json'), 'utf8')) as Record<string, { source: string; step: number; obsFeatures: number }>
  const failed = readFailedLevels(argv, (path) => JSON.parse(readFileSync(path, 'utf8')) as BotRow[])
  Object.assign(rows, failed)
  // Python rows are training diagnostics only. Gate and published scores must use the served model and action layer.
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
    if (rows[level]) rows[level] = await measureServedBots({ level, bytes: await read(join(root, servedPath(level))) })
  }
  const games = Number(arg('games') ?? GATE_MATCHES)
  if (arg('reuse-ladder')) throw new Error('R50 requires a fresh ladder for all four levels')
  // R50 requires the ladder even when every bot gate fails.
  const anyPasses = true
  const previous = arg('reuse-ladder') ? parseRegistry(JSON.parse(readFileSync(arg('reuse-ladder')!, 'utf8'))) : null
  const oldGate = previous?.versions[0]?.gate as { ladder?: { pairs: Array<{ lower: Level; upper: Level; score: number; n: number }> } } | undefined
  if (previous && !oldGate?.ladder?.pairs) throw new Error('previous registry has no ladder pairs')
  if (previous && previous.versions[0]?.sha256['hard.onnx'] !== sha256(join(root, servedPath('hard')))) throw new Error('Hard artifact differs from previous registry')
  if (!previous) {
    for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
      const candidate = await read(join(scratch, `${level}.onnx`))
      if (!Buffer.from(candidate).equals(Buffer.from(await read(join(root, servedPath(level)))))) throw new Error(`${level} ladder model differs from the model it serves`)
    }
  }
  const { elo, pairs } = previous
    ? { elo: Object.fromEntries(Object.entries(previous.measured).filter(([, value]) => value?.siteElo !== undefined).map(([level, value]) => [level, value!.siteElo!])) as Partial<Record<Level, number>>, pairs: oldGate!.ladder!.pairs.filter((pair) => pair.upper !== 'champion') }
    : anyPasses
    ? await ladderElo(
        {
          easy: { level: 'easy', bytes: await read(join(scratch, 'easy.onnx')) },
          medium: { level: 'medium', bytes: await read(join(scratch, 'medium.onnx')) },
          hard: { level: 'hard', bytes: await read(join(scratch, 'hard.onnx')) },
          champion: { level: 'champion', bytes: await read(join(scratch, 'champion.onnx')) },
        },
        games,
      )
    : { elo: {}, pairs: [] }
  const failedSource = arg('failed-source')
  if (failedSource) {
    const levels = Object.keys(failed) as Level[]
    if (levels.length !== 1) throw new Error('--failed-source requires exactly one --failed level')
    const level = levels[0]!
    const source = JSON.parse(readFileSync(failedSource, 'utf8')) as { source: string; step: number; obsFeatures?: number }
    meta[level] = { ...source, obsFeatures: source.obsFeatures ?? 162 }
  }
  const models: PublishInput['models'] = {}
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
    // A level with no source (no gated snapshot of it) has no model entry, so it is reported as "no snapshot cleared the gate", not "not measured".
    if (!meta[level]) continue
    models[level] = { artifact: servedPath(level), absolute: join(root, servedPath(level)), ...meta[level] }
  }
  // KC1: Champion must not trail Hard against a loop; a Champion that does is not published even if it clears its bars.
  const trail = rows.hard && rows.champion ? championTrailsHard(rows.hard, rows.champion) : null
  const reg = buildFighterRegistry({
    rows,
    models,
    servedPractice: Object.fromEntries(Object.keys(failed).map((level) => [level, true])),
    levelFailures: fighterLevelFailures(trail, pairs),
    elo,
    gatedSnapshot: { easy: true, medium: true, hard: true, champion: true },
    peopleGated: peopleGatedFor('fighter'),
    commit: execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(),
    now: new Date().toISOString(),
    trainedSteps: [...new Map(Object.values(meta).map((m) => [m.source, m.step])).values()].reduce((n, step) => n + step, 0),
    ladder: !anyPasses
      ? { pairs: [], note: 'Not measured: no level passed the scripted-bot gate (R30 exploit bars), so no site Elo is published.' }
      : {
      pairs: pairs.map((p) => ({ ...p, lowerBound: round6(wilson(p.score * p.n, p.n)[0]) })),
      note: previous ? 'Historical ladder results reused from the prior registry, not re-measured. The former Champion pair is omitted because Practice Champion changed.' : 'Seat-swapped head to head, each upper level against the level below. Site Elo is anchored at 1000 on Easy and chained up; Easy, Medium and Hard use the served Hard network and Champion its own, each with its own limits.',
    },
  })
  if (previous) for (const level of Object.keys(reg.measured) as Level[]) {
    if (previous.measured[level]) reg.measured[level] = previous.measured[level]
  }
  await writeRegistry(join(root, 'packages/agents/registry/fighter.json'), reg)
  // Keep the served rows next to the registry: registry-rows.test.ts checks every published row against these files.
  for (const [level, levelRows] of Object.entries(rows)) await Bun.write(join(root, `packages/agents/eval/fighter/${level}.json`), `${JSON.stringify(levelRows, null, 2)}\n`)
  await Bun.write(join(root, 'packages/agents/eval/fighter/sources.json'), `${JSON.stringify(meta, null, 2)}\n`)
  console.log(JSON.stringify({ pairs, elo, published: Object.keys(reg.levels), unpublished: reg.unpublished }, null, 2))
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === 'behavior') {
    const { behavior } = await import('./fighter-behavior')
    for (const level of ['easy', 'medium', 'hard', 'champion'] as const)
      for (const opponent of ['passive', 'hold-back'] as const)
        for (let seed = 7000; seed < 7004; seed++)
          console.log(JSON.stringify(await behavior(level, opponent, seed, args.includes('--trace'))))
  } else await publishMain(args)
}
