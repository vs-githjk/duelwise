import type { Level } from '@duelwise/core/src/product'
import type { Registry } from '@duelwise/agents/src/registry'

const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']
const MIN_SEAT_GAMES = 400
const obj = (x: unknown): Record<string, any> | null => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, any> : null

/** Wilson lower confidence bound for a score with draws counted as half a win. */
function lower(points: number, n: number): number {
  const z = 1.959964
  const p = points / n
  const z2 = z * z
  return (p + z2 / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n)
}

function seatPass(value: unknown, floor: number): boolean {
  const s = obj(value)
  if (!s) return false
  const n = s.games ?? s.n
  const points = s.points ?? (typeof s.wins === 'number' && typeof s.draws === 'number' ? s.wins + s.draws / 2 : undefined)
  const wins = s.wins
  const draws = s.draws
  const losses = s.losses
  const complete = [wins, draws, losses].every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0)
  if (complete && wins + draws + losses !== n) return false
  return Number.isInteger(n) && n >= MIN_SEAT_GAMES && typeof points === 'number' && Number.isFinite(points) && points >= 0 && points <= n && lower(points, n) > floor
}

function twoSeats(value: unknown, floor: number): boolean {
  if (Array.isArray(value)) {
    const a = value.find((s) => s?.seat === 0)
    const b = value.find((s) => s?.seat === 1)
    return value.length === 2 && seatPass(a, floor) && seatPass(b, floor)
  }
  const seats = obj(value)
  return Boolean(seats && seatPass(seats['0'], floor) && seatPass(seats['1'], floor))
}

/** R44: Hard against the 2-ply bot passes on a pooled score of at least 0.7 over 400 games and a score of at least 0.6 on each 200-game seat (not a Wilson bound). */
function twoPlyPass(gate: Record<string, any> | null | undefined): boolean {
  const seats = gate?.bySeat
  if (!gate || !Array.isArray(seats) || seats.length !== 2) return false
  if (gate.n !== 400 || typeof gate.points !== 'number' || gate.points / gate.n < 0.7) return false
  return [0, 1].every((seat) => {
    const row = seats.find((s: any) => s?.seat === seat)
    return Boolean(row) && row.n === 200 && typeof row.points === 'number' && row.points <= row.n && row.points / row.n >= 0.6
  })
}

/** A registry may show strength only when its recorded gate proves the required sample and Wilson bound on both seats. */
export function verifiedStrength(reg: Registry | null, level: Level): boolean {
  if (!reg?.levels?.[level] || !reg.measured?.[level]) return false
  const version = reg.versions.find((v) => v.version === reg.levels[level]?.version)
  const gate = obj(version?.gate)
  if (!gate) return false
  if (reg.game === 'fighter' || reg.game === 'arena') {
    const rows = obj(obj(gate.levels)?.[level])?.bots
    if (!Array.isArray(rows)) return false
    const expected = reg.game === 'fighter'
      ? (level === 'easy' || level === 'medium' ? ['random', 'rushdown', 'turtle'] : level === 'champion' ? ['rushdown', 'turtle', 'zoner', 'throwloop', 'backwalk', 'pokeloop', 'sweepspam', 'fireball', 'throwtap', 'fireball25'] : ['random', 'rushdown', 'turtle', 'zoner', 'throwloop', 'backwalk', 'pokeloop', 'sweepspam', 'fireball', 'throwtap', 'fireball25'])
      : (level === 'champion' ? ['rusher', 'holder', 'peeker', 'strafe', 'holdangle'] : ['random', 'rusher', 'holder', 'peeker', 'strafe', 'holdangle'])
    return expected.every((name) => {
      const row = rows.find((r: any) => r?.bot === name)
      const base = level === 'easy' ? 0.35 : level === 'medium' ? 0.5 : level === 'hard' ? 0.6 : 0.75
      const required = name === 'random' ? (level === 'easy' ? 0.85 : level === 'medium' ? 0.9 : 0.95) : base
      return row && typeof row.bar === 'number' && Number.isFinite(row.bar) && row.bar >= required && twoSeats(row.bySeat, row.bar)
    }) && ladderPairsPass(obj(gate.ladder)?.pairs, level)
  }
  if (reg.game === 'four') return fourPass(reg, level)
  if (reg.game === 'word') return wordPass(reg, level)
  if (reg.game === 'chess' || reg.game === 'holdem' || reg.game === 'fleet' || reg.game === 'slack') {
    if (!twoSeats(obj(gate.baseline)?.bySeat, 0.5)) return false
    const pairs = Array.isArray(gate.pairs) ? gate.pairs : []
    const index = LEVELS.indexOf(level)
    for (let i = 1; i <= index; i++) {
      const pair = pairs.find((p: any) => p?.lower === LEVELS[i - 1] && p?.upper === LEVELS[i])
      if (!pair || !twoSeats(pair.bySeat, 0.5)) return false
    }
    if (reg.game === 'chess' && index >= 2 && !twoPlyPass(obj(gate.twoPlyBot))) return false
    return true
  }
  return false
}

/** Realtime ladder: only pairs whose upper level is at or below the level count; a pair without bySeat is accepted on its recorded Wilson lower bound. */
export function ladderPairsPass(pairs: unknown, level: Level): boolean {
  if (pairs === undefined || pairs === null) return true
  if (!Array.isArray(pairs)) return false
  const index = LEVELS.indexOf(level)
  return pairs.every((raw: unknown) => {
    const pair = obj(raw)
    const upper = LEVELS.indexOf(pair?.upper)
    if (!pair || upper < 0) return false
    if (upper > index) return true
    if (pair.bySeat !== undefined) return twoSeats(pair.bySeat, 0.5)
    const bound = pair.lowerBound95 ?? pair.lowerBound
    return typeof bound === 'number' && bound > 0.5
  })
}

const FOUR_MIN_GAMES = 100
const FOUR_CHALLENGER_MIN_GAMES = 400

function pooledPass(row: unknown, minGames: number): boolean {
  const r = obj(row)
  if (!r || !Number.isInteger(r.n) || r.n < minGames || typeof r.points !== 'number' || r.points < 0 || r.points > r.n) return false
  return lower(r.points, r.n) > 0.5
}

/** Four in a Row publishers: v1 pooled baseline and adjacent pairs (n>=100, Wilson lower bound above 0.5); a later champion version passes its challenger gate (n>=400, score>=0.55, bound above 0.5). */
function fourPass(reg: Registry, level: Level): boolean {
  const index = LEVELS.indexOf(level)
  const v1 = obj(reg.versions.find((v) => v.version === 'v1')?.gate)
  const served = reg.levels[level]!.version
  if (!v1 || !pooledPass(v1.baseline, FOUR_MIN_GAMES)) return false
  const pairs = Array.isArray(v1.pairs) ? v1.pairs : []
  for (let i = 1; i <= index; i++) {
    const pair = pairs.find((p: any) => p?.lower === LEVELS[i - 1] && p?.upper === LEVELS[i])
    if (!pair || pair.passed === false || !pooledPass(pair, FOUR_MIN_GAMES)) return false
  }
  const seat = obj(v1.siteSeat)
  const replay = obj(v1.replay)
  const greedy = obj(v1.greedy)
  // The publisher aborts when any of these fails; the champion of its ladder is the live one it records.
  if (!seat || seat.passed !== true || !Number.isInteger(seat.games) || typeof seat.points !== 'number' || !(lower(seat.points, seat.games) > 0.5)) return false
  if (!replay || replay.passed !== true || !(replay.humanWins < replay.limit)) return false
  if (!greedy || greedy.passed !== true || greedy.notWins !== 0) return false
  if (served === 'v1') return true
  if (v1.championVersion !== served) return false
  const g = obj(reg.versions.find((v) => v.version === served)?.gate)
  return Boolean(g && g.passed === true && pooledPass(g, FOUR_CHALLENGER_MIN_GAMES) && g.points / g.n >= 0.55)
}

/** Word Duel publisher: each level averages fewer guesses than the level below with non-overlapping 95 percent intervals, over every answer word. */
function wordPass(reg: Registry, level: Level): boolean {
  const index = LEVELS.indexOf(level)
  const gate = obj(reg.versions.find((v) => v.version === reg.levels[level]!.version)?.gate)
  const words = gate?.answerWords
  if (!Number.isInteger(words)) return false
  for (let i = 0; i <= index; i++) {
    const m = obj(reg.measured[LEVELS[i]!])
    if (!m || m.n !== words || !Array.isArray(m.ci95) || m.ci95.length !== 2 || m.ci95.some((x: unknown) => typeof x !== 'number')) return false
    if (i > 0) {
      const below = obj(reg.measured[LEVELS[i - 1]!])
      if (!below || !Array.isArray(below.ci95) || !(m.ci95[1] < below.ci95[0]) || typeof m.value !== 'number' || typeof below.value !== 'number' || !(m.value < below.value)) return false
    }
  }
  return true
}

/** A presentation copy with unverified strength withheld; the original still identifies the model actually played. */
export function visibleRegistry(reg: Registry): Registry {
  const out = structuredClone(reg)
  out.unpublished ??= {}
  out.unpublishedConfig ??= {}
  for (const level of LEVELS) {
    if (verifiedStrength(reg, level)) continue
    if (out.levels[level]) out.unpublishedConfig[level] = out.levels[level]!.config
    delete out.levels[level]
    delete out.measured[level]
    out.unpublished[level] = 'stays in training until the per-seat strength gate is verified'
  }
  return out
}
