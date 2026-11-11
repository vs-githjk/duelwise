import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import type { PuckBotKind } from '@duelwise/core/src/games/puck/bots'
import { observe, stepState } from '@duelwise/core/src/games/puck/core'
import { HARD_CAP_FRAMES, LEVEL_MALLET, MALLET_R, NO_INPUT, PHASE, PUCK_EVENTS, RULE_MALLET_SPEED } from '@duelwise/core/src/games/puck/constants'
import { zoneYHi, zoneYLo } from '@duelwise/core/src/games/puck/physics'
import { peopleHands, peopleHandsLevel, type PeopleProfile } from '@duelwise/core/src/games/puck/seat-hands'
import { createState } from '@duelwise/core/src/games/puck/state'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import type { Level } from '@duelwise/core/src/product'
import type { PreviewAgent } from '../agent-types'
import { createGameAgent as createNetAgent } from '../puck/agent'
import { createBotAgent } from '../puck/pip'
import { liveObs } from '../puck/view'
import { writeStdoutAndExit } from './drain'
import { wilson } from './ladder'

// Air hockey measurement (P11). The browser plays an ONNX agent through a worker, so its reply lands one tick after the decision
// (up to two at 30 fps, P8 review); this harness plays the same agent code (packages/agents/src/puck/agent.ts, onnxruntime-web)
// against scripted bots and against other levels, applies each net seat's reply `lag` ticks late, and records, per seat, what
// the compliance test, the lane cap and claim C2 (nothing eases off) need. Scripted bots play under the level's own hands
// (mallet limits, target noise, minimum hold) and reaction time; Champion's gate bots may see the live game (the plan's strict gate).

export const PUCK_BOTS = ['random', 'striker', 'goalie', 'banker', 'shadow'] as const
export const LEVELS_ORDER: readonly Level[] = ['easy', 'medium', 'hard', 'champion']

/** Wilson 95% lower-bound bars per level and bot, per seat, 400 matches each (plan Agents table). */
export const PUCK_BARS: Record<Level, Record<string, number>> = {
  easy: { random: 0.85, striker: 0.35, goalie: 0.35 },
  medium: { random: 0.9, striker: 0.5, goalie: 0.5 },
  hard: { random: 0.95, striker: 0.6, goalie: 0.6, banker: 0.6, shadow: 0.6 },
  champion: { striker: 0.75, goalie: 0.75, banker: 0.75, shadow: 0.75 },
}
export const SEAT_GAMES = 400

export type SeatSpec =
  | { type: 'net'; level: Level; model: string; lag: number; maskScore?: boolean }
  | { type: 'bot'; kind: PuckBotKind; level: Level; delay: number; hands?: BotHands }

/**
 * Whose mallet a scripted bot moves. 'level' (the default, the old measure mode) is the level's own mallet limits and target noise.
 * 'human' is what the person in the browser gets: the rule mallet (speed 6, default acceleration, seat limits null), with the cleanest
 * hands of any level (Champion's target noise and minimum hold), so the bot is no clumsier than a good person at a mouse.
 */
export type BotHands = 'level' | 'human' | PeopleProfile

/** The people profile a hands mode stands for ('human' is the strong profile, today's human-hands mode), or null for the level's own hands. */
export const profileOf = (hands: BotHands | undefined): PeopleProfile | null => (hands === undefined || hands === 'level' ? null : hands === 'human' ? 'strong' : hands)
/**
 * A scripted bot at a level's hands, or on people's hands (human = strong, or a beginner, average or strong profile: rule mallet, that profile's
 * noise and hold); `delay` frames behind the live game (0 sees it live; on a profile it defaults to the profile's own reaction time).
 */
export const botSpec = (kind: PuckBotKind, level: Level, delay?: number, hands?: BotHands): SeatSpec => {
  const profile = profileOf(hands)
  return { type: 'bot', kind, level, delay: delay ?? (profile ? peopleHands(profile).delayFrames : LEVEL_LIMITS.puck[level].delayFrames), ...(profile ? { hands } : {}) } as SeatSpec
}
/** The mallet limits a seat plays under in the sim: null is the rule mallet. */
const malletOf = (spec: SeatSpec) => (spec.type === 'bot' && profileOf(spec.hands) ? null : LEVEL_MALLET[spec.level])
/** Pip, the scripted Easy opponent: a bot with its own level hands. */
export const pipSpec = (): SeatSpec => botSpec('pip', 'easy')
/** `maskScore` hides the score from the network (its two score features read 0 to 0): the twin used as claim C2's control. */
export const netSpec = (level: Level, model: string, lag = 1, maskScore = false): SeatSpec => ({ type: 'net', level, model, lag, ...(maskScore ? { maskScore } : {}) })
/** The positions of the two score features in the seat's view (view.ts obsFromSeen). */
export const SCORE_FEATURES = [8, 9] as const

export interface StateTally {
  frames: number
  shots: number
  goalsFor: number
  goalsAgainst: number
  /** Live frames the puck spent in the opponent's half. */
  oppHalf: number
}
export const STATES = ['ahead', 'level', 'behind'] as const
const emptyTally = (): StateTally => ({ frames: 0, shots: 0, goalsFor: 0, goalsAgainst: 0, oppHalf: 0 })

export interface SeatRecord {
  /** By score state at the start of the tick: ahead, level, behind (the seat's goals minus the other seat's). */
  states: [StateTally, StateTally, StateTally]
  /** Strikes by lane, in the seat's own view: left bank, straight, right bank. */
  lanes: [number, number, number]
  /** Histogram of reaction time in frames (decision frame minus the frame of the view read), index 0..LAG_BINS-1, clamped. */
  lagHist: number[]
  peakSpeed: number
  peakAccel: number
}
export interface MatchRecord {
  seed: number
  frames: number
  winner: 0 | 1 | null
  score: [number, number]
  seats: [SeatRecord, SeatRecord]
}
const LAG_BINS = 64
const CONTACT_MARGIN = 0.25
const EDGE_MARGIN = 0.11
/** A strike leaves the mallet faster than this toward the other goal (W/s), and one contact counts once (frames). */
const STRIKE_SPEED = 1.5
const STRIKE_GAP = 6
const emptySeat = (): SeatRecord => ({ states: [emptyTally(), emptyTally(), emptyTally()], lanes: [0, 0, 0], lagHist: new Array<number>(LAG_BINS).fill(0), peakSpeed: 0, peakAccel: 0 })

const bytesCache = new Map<string, Uint8Array>()
const bytesOf = (path: string): Uint8Array => {
  let b = bytesCache.get(path)
  if (!b) bytesCache.set(path, (b = new Uint8Array(readFileSync(path))))
  return b
}

/** Wraps a seat's reply so it lands `lag` ticks after it was made (the worker): the ring is full of NO_INPUT at first. */
export class ReplyLag {
  private readonly ring: number[]
  private at = 0
  constructor(readonly lag: number) {
    this.ring = new Array<number>(lag).fill(NO_INPUT)
  }
  /** Takes the reply made this tick; returns the one that lands this tick. */
  push(code: number): number {
    if (this.lag === 0) return code
    const out = this.ring[this.at]!
    this.ring[this.at] = code
    this.at = (this.at + 1) % this.lag
    return out
  }
}

/** The lane a shot leaves down, from the puck's velocity in the shooter's own view (the shadow bot's thresholds). */
export function laneOf(vx: number, vy: number): 0 | 1 | 2 {
  const r = vx / vy
  return r < -0.35 ? 0 : r > 0.35 ? 2 : 1
}

/** 0 ahead, 1 level, 2 behind, from the goal difference. */
export const stateIndex = (diff: number): 0 | 1 | 2 => (diff > 0 ? 0 : diff === 0 ? 1 : 2)

async function makeAgent(spec: SeatSpec, seat: 0 | 1, rec: SeatRecord): Promise<{ agent: PreviewAgent; lag: ReplyLag | null; isNet: boolean; maskScore: boolean }> {
  if (spec.type === 'net') {
    const delay = LEVEL_LIMITS.puck[spec.level].delayFrames
    const agent = await createNetAgent(spec.level, {
      seat,
      modelBytes: bytesOf(spec.model),
      onDecision: (t) => {
        if (t.frame >= delay) rec.lagHist[Math.min(LAG_BINS - 1, t.frame - t.viewFrame)]!++
      },
    })
    return { agent, lag: new ReplyLag(spec.lag), isNet: true, maskScore: spec.maskScore === true }
  }
  const delay = spec.delay
  const agent = await createBotAgent(spec.kind, profileOf(spec.hands) ? peopleHandsLevel(profileOf(spec.hands)!) : spec.level, {
    seat,
    delayFrames: spec.delay,
    onView: (frame, viewFrame) => {
      if (frame >= delay) rec.lagHist[Math.min(LAG_BINS - 1, frame - viewFrame)]!++
    },
  })
  return { agent, lag: null, isNet: false, maskScore: false }
}

/** Plays one match; both seats are recorded. Hands (mallet limits) come from each seat's level. */
export async function playRecorded(specs: [SeatSpec, SeatSpec], seed: number): Promise<MatchRecord> {
  const recs: [SeatRecord, SeatRecord] = [emptySeat(), emptySeat()]
  const made = await Promise.all([makeAgent(specs[0], 0, recs[0]), makeAgent(specs[1], 1, recs[1])])
  try {
    made.forEach((m, seat) => m.agent.reset(seed, seat as 0 | 1))
    const s = createState(seed, { limits: [malletOf(specs[0]), malletOf(specs[1])] })
    const inputs: [number, number] = [NO_INPUT, NO_INPUT]
    const pv = [0, 0, 0, 0]
    const preDist = [9, 9]
    const lastStrike = [-100, -100]
    while (s.matchOver === 0 && s.frame < HARD_CAP_FRAMES) {
      const live = s.phase === PHASE.LIVE
      const before = [s.score[0], s.score[1]] as const
      const shotsBefore = [s.stats[1]!, s.stats[7]!] as const
      const idx = [stateIndex(before[0] - before[1]), stateIndex(before[1] - before[0])] as const
      for (const seat of [0, 1] as const) {
        const m = made[seat]!
        let code: number
        if (m.isNet) {
          const obs = liveObs(s, seat)
          if (m.maskScore) for (const f of SCORE_FEATURES) obs[f] = 0
          code = (await m.agent.act(obs, { frame: s.frame }))[0]!
        } else {
          code = (await m.agent.act(observe(s, seat)))[0]!
        }
        inputs[seat] = m.lag ? m.lag.push(code) : code
      }
      for (let k = 0; k < 2; k++) {
        pv[k * 2] = s.m[k]!.vx
        pv[k * 2 + 1] = s.m[k]!.vy
        preDist[k] = Math.hypot(s.m[k]!.x - s.px, s.m[k]!.y - s.py)
      }
      stepState(s, inputs)
      for (const seat of [0, 1] as const) {
        const r = recs[seat]
        const t = r.states[idx[seat]]
        const mal = s.m[seat]!
        r.peakSpeed = Math.max(r.peakSpeed, Math.hypot(mal.vx, mal.vy))
        // A wall, a zone line or the puck stops the mallet dead ("the mallet stops at contact"): a halt, not a push, so those ticks
        // (the mallet within EDGE_MARGIN of a boundary, a margin of one tick of top speed, or the puck within CONTACT_MARGIN of it at either end of the tick) are not acceleration.
        const stopped = mal.x <= MALLET_R + EDGE_MARGIN || mal.x >= 1 - MALLET_R - EDGE_MARGIN || mal.y <= zoneYLo(seat) + EDGE_MARGIN || mal.y >= zoneYHi(seat) - EDGE_MARGIN
        const near = Math.min(Math.hypot(mal.x - s.px, mal.y - s.py), preDist[seat]!) < CONTACT_MARGIN
        if (!stopped && !near) r.peakAccel = Math.max(r.peakAccel, Math.hypot(mal.vx - pv[seat * 2]!, mal.vy - pv[seat * 2 + 1]!) * 60)
        if (live) {
          t.frames++
          if (seat === 0 ? s.py >= 1 : s.py < 1) t.oppHalf++
        }
        t.goalsFor += s.score[seat]! - before[seat]
        t.goalsAgainst += s.score[1 - seat]! - before[1 - seat]
        const shots = s.stats[seat * 6 + PUCK_EVENTS.shot - 1]! - shotsBefore[seat]
        if (shots > 0) t.shots += shots
        // A strike: the seat's mallet has just hit the puck and it leaves fast toward the other goal. The lane is the angle it leaves with in the
        // seat's own view (left bank, straight, right bank), so a bank shot counts. The sim's `shot` event is only a direct line at the mouth, which
        // is nearly always straight, so lanes are not read from it.
        if (s.lastTouch === seat && s.touchFrame === s.frame - 1 && s.frame - lastStrike[seat]! >= STRIKE_GAP) {
          const sign = seat === 0 ? 1 : -1
          if (s.pvy * sign > STRIKE_SPEED) {
            r.lanes[laneOf(s.pvx * sign, s.pvy * sign)]++
            lastStrike[seat] = s.frame
          }
        }
      }
    }
    return { seed, frames: s.frame, winner: s.winner === 0 ? 0 : s.winner === 1 ? 1 : null, score: [s.score[0], s.score[1]], seats: recs }
  } finally {
    made.forEach((m) => m.agent.dispose())
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs: games dealt over child processes (the ladder budget allows at most 2); results merge in game order.

export interface Job {
  /** One game each: the seats' specs and the seed. */
  games: Array<{ specs: [SeatSpec, SeatSpec]; seed: number }>
}

const CHILD = fileURLToPath(import.meta.url)

function runChild(games: Job['games']): Promise<MatchRecord[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, 'worker'], { stdio: ['pipe', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`puck worker exited with code ${code}`))
      try {
        resolve(JSON.parse(out) as MatchRecord[])
      } catch (e) {
        reject(e)
      }
    })
    child.stdin.end(JSON.stringify(games))
  })
}

export async function playGames(job: Job, procs = 1): Promise<MatchRecord[]> {
  if (procs <= 1) {
    const out: MatchRecord[] = []
    for (const g of job.games) out.push(await playRecorded(g.specs, g.seed))
    return out
  }
  const parts = Array.from({ length: procs }, (_, p) => job.games.filter((_, i) => i % procs === p))
  const results = await Promise.all(parts.map((p) => (p.length ? runChild(p) : Promise.resolve([] as MatchRecord[]))))
  const merged: MatchRecord[] = []
  for (let i = 0; i < job.games.length; i++) merged.push(results[i % procs]![Math.floor(i / procs)]!)
  return merged
}

// ---------------------------------------------------------------------------------------------------------------
// Tallies

export interface SeatResult {
  games: number
  wins: number
  draws: number
  losses: number
  score: number
}
export interface BotRow {
  bot: string
  games: number
  wins: number
  draws: number
  losses: number
  score: number
  ci95: [number, number]
  bySeat: Record<'0' | '1', SeatResult>
}

const tallyResults = (outcomes: Array<0 | 0.5 | 1>): SeatResult => {
  const wins = outcomes.filter((o) => o === 1).length
  const draws = outcomes.filter((o) => o === 0.5).length
  const games = outcomes.length
  return { games, wins, draws, losses: games - wins - draws, score: games ? (wins + draws / 2) / games : 0 }
}
const outcome = (g: MatchRecord, seat: 0 | 1): 0 | 0.5 | 1 => (g.winner === null ? 0.5 : g.winner === seat ? 1 : 0)

export function rowOf(bot: string, bySeat: [SeatResult, SeatResult]): BotRow {
  const games = bySeat[0].games + bySeat[1].games
  const wins = bySeat[0].wins + bySeat[1].wins
  const draws = bySeat[0].draws + bySeat[1].draws
  return { bot, games, wins, draws, losses: games - wins - draws, score: (wins + draws / 2) / games, ci95: wilson(wins + draws / 2, games), bySeat: { '0': bySeat[0], '1': bySeat[1] } }
}

export interface Aggregate {
  states: [StateTally, StateTally, StateTally]
  lanes: [number, number, number]
  lagHist: number[]
  peakSpeed: number
  peakAccel: number
  games: number
}
export function emptyAggregate(): Aggregate {
  return { states: [emptyTally(), emptyTally(), emptyTally()], lanes: [0, 0, 0], lagHist: new Array<number>(LAG_BINS).fill(0), peakSpeed: 0, peakAccel: 0, games: 0 }
}
export function addSeat(a: Aggregate, r: SeatRecord): void {
  a.games++
  for (let i = 0; i < 3; i++) for (const k of Object.keys(a.states[i]!) as Array<keyof StateTally>) a.states[i]![k] += r.states[i]![k]
  for (let i = 0; i < 3; i++) a.lanes[i] += r.lanes[i]!
  for (let i = 0; i < LAG_BINS; i++) a.lagHist[i] += r.lagHist[i]!
  a.peakSpeed = Math.max(a.peakSpeed, r.peakSpeed)
  a.peakAccel = Math.max(a.peakAccel, r.peakAccel)
}
export function medianLag(hist: number[]): number {
  const total = hist.reduce((n, x) => n + x, 0)
  if (total === 0) return NaN
  let run = 0
  for (let i = 0; i < hist.length; i++) {
    run += hist[i]!
    if (run * 2 >= total) return i
  }
  return hist.length - 1
}
export function laneEntropy(lanes: readonly number[]): number {
  const n = lanes.reduce((a, b) => a + b, 0)
  if (n === 0) return 0
  return Math.max(0, -lanes.reduce((h, c) => (c > 0 ? h + (c / n) * Math.log2(c / n) : h), 0))
}

export interface C2Row {
  state: (typeof STATES)[number]
  liveSeconds: number
  shots: number
  shotsPerMinute: number
  oppHalfShare: number
  goalsFor: number
  goalsAgainst: number
  /** Share of the goals scored in this state that the agent scored. */
  pointShare: number | null
}
/** Claim C2: what the agent does by score state, from its own seat in the measured games. */
export function c2Rows(a: Aggregate): C2Row[] {
  return a.states.map((t, i) => ({
    state: STATES[i]!,
    liveSeconds: Math.round(t.frames / 60),
    shots: t.shots,
    shotsPerMinute: t.frames ? Math.round((t.shots / (t.frames / 3600)) * 100) / 100 : 0,
    oppHalfShare: t.frames ? Math.round((t.oppHalf / t.frames) * 1000) / 1000 : 0,
    goalsFor: t.goalsFor,
    goalsAgainst: t.goalsAgainst,
    pointShare: t.goalsFor + t.goalsAgainst ? Math.round((t.goalsFor / (t.goalsFor + t.goalsAgainst)) * 1000) / 1000 : null,
  }))
}

/**
 * The one honest line the C2 numbers support. It never says the agent ignores the score: the trained net reads score features, so the
 * claim is only "no easing off". Shots by score state are confounded by the game itself (a scripted bot that never reads the score
 * shoots less when ahead too), so a network is compared with its own twin: the same network, the same games, with the score hidden
 * from it. It is said to ease off only if its ahead-to-level shot ratio is more than 0.15 below the twin's, or its share of play in
 * the opponent's half falls more than 0.05 further when ahead. Without a usable twin, or for a level that failed its gate, no claim is
 * made either way: "not measured for easing off".
 */
export function c2Statement(rows: C2Row[], name: string, twin?: C2Row[], opts: { gatePassed?: boolean } = {}): string {
  const [ahead, level, behind] = rows as [C2Row, C2Row, C2Row]
  const fmt = (r: C2Row) => `${r.shotsPerMinute.toFixed(1)}`
  const pct = (r: C2Row) => (r.pointShare === null ? 'n/a' : `${Math.round(r.pointShare * 100)}%`)
  const sample = `${ahead.shots + level.shots + behind.shots} shots`
  if (ahead.liveSeconds < 120 || level.liveSeconds < 120) return `${name}: too little play ahead or level to say (${sample} measured).`
  const ratio = (r: C2Row[]) => (r[1]!.shotsPerMinute ? r[0]!.shotsPerMinute / r[1]!.shotsPerMinute : 1)
  const base = twin && twin[0]!.liveSeconds >= 120 && twin[1]!.liveSeconds >= 120 ? twin : undefined
  if (!base || opts.gatePassed === false) return `${name}: not measured for easing off.`
  const easesOff = ratio(rows) < ratio(base) - 0.15 || ahead.oppHalfShare - level.oppHalfShare < base[0]!.oppHalfShare - base[1]!.oppHalfShare - 0.05
  const rates = `${fmt(ahead)} shots a minute ahead, ${fmt(level)} level${behind.liveSeconds >= 120 ? `, ${fmt(behind)} behind` : ''}`
  const against = `; the same network with the score hidden from it shot ${fmt(base[0]!)}, ${fmt(base[1]!)} and ${fmt(base[2]!)}`
  const points = `share of points won ${pct(ahead)} ahead, ${pct(level)} level, ${pct(behind)} behind`
  return easesOff
    ? `${name} attacked less when ahead than its score-hidden twin does (${rates}${against}); ${points}. The copy must not say it never eases off.`
    : `${name} showed no easing off: ${rates}${against}; ${points}, measured over ${sample} (the net does read the score; this is a measured rate, not a claim that it ignores it).`
}

/** Pip is a script that never reads the score, so its rates by score state show only what the game does. */
export function c2StatementScripted(rows: C2Row[], name: string): string {
  const [ahead, level, behind] = rows as [C2Row, C2Row, C2Row]
  const f = (r: C2Row) => r.shotsPerMinute.toFixed(1)
  return `${name} is a script that never reads the score: ${f(ahead)} shots a minute ahead, ${f(level)} level, ${f(behind)} behind is what the game does to the shot rate (the control for the trained levels).`
}

export interface LevelMeasure {
  level: Level
  lag: number
  botDelay: number
  botHands: BotHands
  gamesPerSeat: number
  rows: BotRow[]
  aggregate: Aggregate
  c2: C2Row[]
  /** The same by scripted opponent, so a mix of strong and weak bots cannot hide or fake an easing off. */
  c2ByBot: Record<string, C2Row[]>
  lanes: { counts: [number, number, number]; shareMax: number; entropyBits: number }
  compliance: { medianLagFrames: number; delayFrames: number; peakSpeed: number; speedCap: number; peakAccel: number; accelCap: number }
}

/** The agent (a net, or Pip) at `level` against each scripted bot, `games` per seat, bots under the level's hands and `botDelay`. */
export async function measureBots(agent: SeatSpec, bots: readonly string[], opts: { games: number; botDelay: number; botHands?: BotHands; seedBase?: number; procs?: number; onRow?: (row: BotRow) => void }): Promise<LevelMeasure> {
  const level = agent.level
  const aggregate = emptyAggregate()
  const rows: BotRow[] = []
  const c2ByBot: Record<string, C2Row[]> = {}
  for (const [bi, bot] of bots.entries()) {
    const games: Job['games'] = []
    for (const seat of [0, 1] as const) {
      for (let i = 0; i < opts.games; i++) {
        const seed = (opts.seedBase ?? 100_000) + bi * 100_000 + seat * 50_000 + i
        const foe = botSpec(bot as PuckBotKind, level, opts.botDelay, opts.botHands)
        games.push({ specs: seat === 0 ? [agent, foe] : [foe, agent], seed })
      }
    }
    const recs = await playGames({ games }, opts.procs ?? 1)
    const botAgg = emptyAggregate()
    const bySeat = [0, 1].map((seat) => {
      const mine = recs.filter((_, i) => games[i]!.specs[seat] === agent)
      const outs = mine.map((g) => outcome(g, seat as 0 | 1))
      for (const g of mine) {
        addSeat(aggregate, g.seats[seat]!)
        addSeat(botAgg, g.seats[seat]!)
      }
      return tallyResults(outs)
    }) as [SeatResult, SeatResult]
    c2ByBot[bot] = c2Rows(botAgg)
    const row = rowOf(bot, bySeat)
    rows.push(row)
    opts.onRow?.(row)
  }
  const shots = aggregate.lanes.reduce((a, b) => a + b, 0)
  return {
    level,
    lag: agent.type === 'net' ? agent.lag : 0,
    botDelay: opts.botDelay,
    botHands: opts.botHands ?? 'level',
    gamesPerSeat: opts.games,
    rows,
    aggregate,
    c2: c2Rows(aggregate),
    c2ByBot,
    lanes: { counts: aggregate.lanes, shareMax: shots ? Math.max(...aggregate.lanes) / shots : 0, entropyBits: laneEntropy(aggregate.lanes) },
    compliance: { medianLagFrames: medianLag(aggregate.lagHist), delayFrames: LEVEL_LIMITS.puck[level].delayFrames, peakSpeed: aggregate.peakSpeed, speedCap: LEVEL_MALLET[level].speed, peakAccel: aggregate.peakAccel, accelCap: LEVEL_MALLET[level].accel },
  }
}

/** What the compliance test checks over recorded games: reaction no faster than the delay, mallet speed and acceleration within the level's caps (Champion's speed within the rule cap). */
export function complianceFailures(level: Level, a: Pick<Aggregate, 'lagHist' | 'peakSpeed' | 'peakAccel'>): string[] {
  const failures: string[] = []
  const delay = LEVEL_LIMITS.puck[level].delayFrames
  const median = medianLag(a.lagHist)
  if (!(median >= delay)) failures.push(`${level}: median reaction ${median} frames is below the ${delay}-frame delay`)
  const hist = a.lagHist
  const early = hist.slice(0, delay).reduce((n, x) => n + x, 0)
  if (early > 0) failures.push(`${level}: ${early} decisions read a view fresher than ${delay} frames`)
  const cap = LEVEL_MALLET[level]
  const ruleCap = level === 'champion' ? RULE_MALLET_SPEED : cap.speed
  if (a.peakSpeed > Math.min(cap.speed, ruleCap) + 1e-6) failures.push(`${level}: peak mallet speed ${a.peakSpeed.toFixed(3)} is above ${cap.speed}`)
  if (a.peakAccel > cap.accel + 1e-4) failures.push(`${level}: peak mallet acceleration ${a.peakAccel.toFixed(2)} is above ${cap.accel}`)
  return failures
}

export interface PairResult {
  lower: Level
  upper: Level
  /** The upper level's score over `n` games, seats swapped (half each). */
  score: number
  n: number
  lowerBound95: number
  bySeat: Record<'0' | '1', SeatResult>
  /** Upper and lower reaction and speed compliance in these games, from the seat records. */
  upperLanes: [number, number, number]
}

/** The upper spec against the lower spec, `games` per seat of the upper one. */
export async function measurePair(lower: SeatSpec, upper: SeatSpec, opts: { games: number; seedBase?: number; procs?: number }): Promise<PairResult> {
  const games: Job['games'] = []
  for (const seat of [0, 1] as const) {
    for (let i = 0; i < opts.games; i++) {
      const seed = (opts.seedBase ?? 700_000) + seat * 50_000 + i
      games.push({ specs: seat === 0 ? [upper, lower] : [lower, upper], seed })
    }
  }
  const recs = await playGames({ games }, opts.procs ?? 1)
  const lanes: [number, number, number] = [0, 0, 0]
  const bySeat = [0, 1].map((seat) => {
    const mine = recs.filter((_, i) => games[i]!.specs[seat] === upper)
    for (const g of mine) for (let l = 0; l < 3; l++) lanes[l] += g.seats[seat]!.lanes[l]!
    return tallyResults(mine.map((g) => outcome(g, seat as 0 | 1)))
  }) as [SeatResult, SeatResult]
  const wins = bySeat[0].wins + bySeat[1].wins
  const draws = bySeat[0].draws + bySeat[1].draws
  const n = bySeat[0].games + bySeat[1].games
  return { lower: lower.level, upper: upper.level, score: (wins + draws / 2) / n, n, lowerBound95: Math.round(wilson(wins + draws / 2, n)[0] * 1e6) / 1e6, bySeat: { '0': bySeat[0], '1': bySeat[1] }, upperLanes: lanes }
}

/** Gate verdict for a level's rows against its bars, each seat by itself (the page seats the AI on one side). */
export function gatePuck(level: Level, rows: BotRow[], seatGames = SEAT_GAMES): { passed: boolean; failures: string[]; weakest: { bot: string; seat: '0' | '1'; result: SeatResult; lower: number } | null } {
  const failures: string[] = []
  let weakest: { bot: string; seat: '0' | '1'; result: SeatResult; lower: number } | null = null
  for (const [bot, bar] of Object.entries(PUCK_BARS[level])) {
    const row = rows.find((r) => r.bot === bot)
    if (!row) {
      failures.push(`no measurement against ${bot}`)
      continue
    }
    for (const seat of ['0', '1'] as const) {
      const s = row.bySeat[seat]
      if (s.games < seatGames) failures.push(`${bot} on seat ${seat}: ${s.games} matches, the gate needs ${seatGames} per seat`)
      const lower = wilson(s.wins + s.draws / 2, s.games)[0]
      if (lower < bar) failures.push(`${bot}: ${s.wins + s.draws / 2} of ${s.games}, Wilson lower bound ${lower.toFixed(4)} on seat ${seat} is below ${bar}`)
      if (!weakest || lower < weakest.lower) weakest = { bot, seat, result: s, lower }
    }
  }
  return { passed: failures.length === 0 && weakest !== null, failures, weakest }
}

// ---------------------------------------------------------------------------------------------------------------
// Worker entry: reads games as JSON on stdin, prints MatchRecord[] as JSON.

async function readStdin(): Promise<string> {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  return text
}

if (import.meta.main && process.argv[2] === 'worker') {
  const games = JSON.parse(await readStdin()) as Job['games']
  const out: MatchRecord[] = []
  for (const g of games) out.push(await playRecorded(g.specs, g.seed))
  writeStdoutAndExit(JSON.stringify(out))
}
