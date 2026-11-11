// A5: measure a turn game's levels against the people panel and write the result into packages/agents/eval/people/<game>.json.
//   bun /abs/turn-people-run.ts <four|chess|slack|fleet|word|penalty> --label <name> [--levels easy,medium,hard,champion] [--per-seat 200] [--champion-per-seat 10]
//        [--override '{"medium":{"sims":8}}'] [--ceiling-games 2000 [--ceiling-all]] [--seed-base 11000000] [--procs 2]
// Each call appends one run to the file. The run labelled `current` (no override) is the pre-read of what ships today: it fixes the game's calibration
// (each level's panel estimate against its real matches in plan/retune/human-baseline.csv). A later run applies that calibration to its panel numbers, and
// drops a level's real matches when the run overrides that level (the real score belongs to the old settings). Nothing here edits the registry.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GameId, Level } from '@duelwise/core/src/product'
import type { ModuleRef } from './harness'
import { loadBaseline, PEOPLE_BANDS, type PeopleEstimate } from './people'
import { gameCalibration, levelPeople, measureAgainst, measureTurnPanel, pct, realCheck, writeJson, type LevelPeople, type RealCheck } from './turn-people'
import { PROXY_WORDS as CHESS_WORDS } from './chess-people'
import { PROXY_WORDS as FOUR_WORDS } from './four-people'
import { PROXY_WORDS as SLACK_WORDS } from './slack-people'
import { PROXY_WORDS as FLEET_WORDS } from './fleet-people'
import { PROXY_WORDS as WORD_WORDS } from './word-people'
import { PROXY_WORDS as PENALTY_WORDS } from './penalty-people'

const HERE = import.meta.dir
const REPO = join(HERE, '..', '..', '..', '..')

interface GameSetup {
  id: GameId
  core?: ModuleRef
  tested: string
  overrideEnv: string
  panelModule: string
  words: typeof CHESS_WORDS
  shipped: Record<string, unknown>
}

function setup(game: string): GameSetup {
  const reg = JSON.parse(readFileSync(join(REPO, 'packages', 'agents', 'registry', `${game}.json`), 'utf8')) as { levels: Record<string, { config: unknown }> }
  const shipped = Object.fromEntries(Object.entries(reg.levels).map(([k, v]) => [k, v.config]))
  if (game === 'four') {
    return { id: 'four', core: { module: join(HERE, 'four.ts'), export: 'createOpeningCore' }, tested: join(HERE, 'four-tried.ts'), overrideEnv: 'FOUR_PEOPLE_OVERRIDE', panelModule: join(HERE, 'four-people.ts'), words: FOUR_WORDS, shipped }
  }
  if (game === 'chess') {
    return { id: 'chess', core: { module: join(HERE, 'chess.ts'), export: 'createOpeningCore' }, tested: join(HERE, 'chess-tried.ts'), overrideEnv: 'CHESS_PEOPLE_OVERRIDE', panelModule: join(HERE, 'chess-people.ts'), words: CHESS_WORDS, shipped }
  }
  if (game === 'slack') {
    return { id: 'slack', core: { module: join(HERE, '..', 'slack', 'opening.ts'), export: 'createSlackOpeningCore' }, tested: join(HERE, 'slack-tried.ts'), overrideEnv: 'SLACK_PEOPLE_OVERRIDE', panelModule: join(HERE, 'slack-people.ts'), words: SLACK_WORDS, shipped }
  }
  if (game === 'fleet') return { id: 'fleet', tested: join(HERE, 'fleet-tried.ts'), overrideEnv: 'FLEET_PEOPLE_OVERRIDE', panelModule: join(HERE, 'fleet-people.ts'), words: FLEET_WORDS, shipped } as GameSetup
  if (game === 'word') return { id: 'word', tested: join(HERE, 'word-tried.ts'), overrideEnv: 'WORD_PEOPLE_OVERRIDE', panelModule: join(HERE, 'word-people.ts'), words: WORD_WORDS, shipped } as GameSetup
  if (game === 'penalty') return { id: 'penalty', core: { module: '@duelwise/core/src/games/penalty', export: 'createPenaltyCore' }, tested: join(HERE, 'penalty-tried.ts'), overrideEnv: 'PENALTY_PEOPLE_OVERRIDE', panelModule: join(HERE, 'penalty-people.ts'), words: PENALTY_WORDS, shipped }
  throw new Error(`turn-people-run: game must be four, chess, slack, fleet, word or penalty, got ${game}`)
}

interface Run {
  /** Per level, the agent's score against the average test player alone over --ceiling-games games (the strongest settings the code has). */
  ceilings?: Partial<Record<Level, { value: number; ci95: [number, number]; n: number; by: string }>>
  label: string
  at: string
  override: Record<string, unknown> | null
  perSeat: Record<string, number>
  seedBase: number
  levels: Partial<Record<Level, LevelPeople>>
  /** Whether the panel is contradicted by the real matches of the levels this run did not change. */
  realCheck?: RealCheck
}
interface EvalFile {
  game: string
  baseline: string
  note: string
  calibration: number | null
  calibrationFrom: string | null
  runs: Run[]
}

const args = process.argv.slice(2)
const game = args[0] ?? ''
const flag = (n: string): string | undefined => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined)
const g = setup(game)
const label = flag('--label')
if (!label) throw new Error('turn-people-run: --label is required')
const levels = (flag('--levels') ?? 'easy,medium,hard,champion').split(',') as Level[]
const perSeat = Number(flag('--per-seat') ?? 200)
const champPerSeat = Number(flag('--champion-per-seat') ?? 10)
const seedBase = Number(flag('--seed-base') ?? 11_000_000)
const procs = Math.min(2, Number(flag('--procs') ?? 2))
const ceilingGames = Number(flag('--ceiling-games') ?? 0)
/** --ceiling-all: the Champion's score against the average test player is the ceiling for every level whose band it cannot reach (nothing the code has does better), not for Champion alone. */
const ceilingAll = args.includes('--ceiling-all')
const overrideRaw = flag('--override')
const override = overrideRaw ? (JSON.parse(overrideRaw) as Record<string, unknown>) : null
if (overrideRaw) process.env[g.overrideEnv] = overrideRaw
if (game === 'chess' && !process.env.CHESS_NODE_BUDGET) process.env.CHESS_NODE_BUDGET = String(JSON.parse(readFileSync(join(REPO, 'packages', 'agents', 'registry', 'chess.json'), 'utf8')).levels.champion.config.measuredNodeBudget)

const outPath = flag('--out') ?? join(REPO, 'packages', 'agents', 'eval', 'people', `${game}.json`)
const file: EvalFile = existsSync(outPath)
  ? (JSON.parse(readFileSync(outPath, 'utf8')) as EvalFile)
  : { game, baseline: 'plan/retune/human-baseline.csv (production, 2026-11-10)', note: 'Written by measure/turn-people-run.ts only. A run labelled current is the pre-read of today\'s settings; its panel-vs-real gap is the calibration every later run uses.', calibration: null, calibrationFrom: null, runs: [] }

const BASELINE = flag('--baseline') ?? join(REPO, 'plan', 'retune', 'human-baseline.csv')
const base = loadBaseline(BASELINE)
const run: Run = { label, at: new Date().toISOString(), override, perSeat: {}, seedBase, levels: {} }
const isCurrent = label === 'current'

let sharedCeiling: PeopleEstimate['ceiling'] | undefined
if (ceilingAll && ceilingGames > 0 && levels.includes('champion')) {
  const r = await measureAgainst({ game: g.id, core: g.core, tested: { level: 'champion', module: g.tested }, panelModule: g.panelModule, perSeat: Math.ceil(ceilingGames / 2), procs, seedBase }, 'average', 7)
  run.ceilings = { champion: { value: r.score.value, ci95: r.score.ci95, n: r.score.n, by: 'champion settings (the strongest the code has) against the average test player' } }
  sharedCeiling = { value: r.score.value, ci95: r.score.ci95, by: `${r.score.n} games of the champion settings against the average test player` }
  console.error(`${game} champion [${label}] ceiling vs average ${pct(r.score.value)} over ${r.score.n}`)
}
for (const level of levels) {
  const per = level === 'champion' ? champPerSeat : perSeat
  run.perSeat[level] = per
  const result = await measureTurnPanel({ game: g.id, core: g.core, tested: { level, module: g.tested }, panelModule: g.panelModule, perSeat: per, procs, seedBase })
  const changed = Boolean(override && Object.prototype.hasOwnProperty.call(override, level))
  const real = changed ? null : (base.get(`${game}/${level}`) ?? null)
  const config = changed ? { ...(g.shipped[level] as object), ...(override![level] as object) } : g.shipped[level]
  const cal = isCurrent ? 0 : (file.calibration ?? 0)
  let ceiling: PeopleEstimate['ceiling'] | undefined = sharedCeiling
  if (ceilingGames > 0 && level === 'champion' && !sharedCeiling) {
    // The strongest settings the code has are the shipped Champion's (or this run's override of it); it plays the average test player alone.
    const r = await measureAgainst({ game: g.id, core: g.core, tested: { level, module: g.tested }, panelModule: g.panelModule, perSeat: Math.ceil(ceilingGames / 2), procs, seedBase }, 'average', 7)
    run.ceilings = { ...run.ceilings, [level]: { value: r.score.value, ci95: r.score.ci95, n: r.score.n, by: 'champion settings (the strongest the code has) against the average test player' } }
    ceiling = { value: r.score.value, ci95: r.score.ci95, by: `${r.score.n} games of the champion settings against the average test player` }
    console.error(`${game} ${level} [${label}] ceiling vs average ${pct(r.score.value)} over ${r.score.n}`)
  }
  run.levels[level] = levelPeople(level, config, result, real, cal, g.words)
  if (ceiling && run.levels[level]!.estimate.calibrated < run.levels[level]!.estimate.band.low && ceiling.value < run.levels[level]!.estimate.band.low) run.levels[level] = levelPeople(level, config, result, real, cal, g.words, ceiling)
  const e = run.levels[level]!.estimate
  const p = e.panel
  console.error(`${game} ${level} [${label}] beginner ${pct(p.beginner.value)} average ${pct(p.average.value)} strong ${pct(p.strong.value)} -> panel ${pct(e.estimate)} calibrated ${pct(e.calibrated)} ${e.verdict} (band ${pct(e.band.low)} to ${pct(e.band.high)}) real ${e.real ? `${pct(e.real.value)} n${e.real.n}` : 'none'}`)
}
if (isCurrent) {
  const done = Object.values(run.levels).filter((l): l is LevelPeople => Boolean(l)).map((l) => ({ level: l.level, estimate: l.estimate as PeopleEstimate }))
  file.calibration = gameCalibration(game, done, BASELINE)
  file.calibrationFrom = `${label} (${done.map((d) => d.level).join(', ')})`
  // Re-derive the current run's own calibrated numbers now that the calibration is known.
  for (const l of Object.values(run.levels)) {
    if (!l) continue
    const c = run.ceilings?.[l.level] ?? (ceilingAll ? run.ceilings?.champion : undefined)
    const ceiling = c && c.value < PEOPLE_BANDS[l.level].low ? { value: c.value, ci95: c.ci95, by: l.estimate.ceiling?.by ?? c.by } : undefined
    run.levels[l.level] = levelPeople(l.level, l.config, l.result, base.get(`${game}/${l.level}`) ?? null, file.calibration, g.words, ceiling)
  }
  console.error(`calibration ${(file.calibration * 100).toFixed(2)} points`)
}
{
  const unchanged = Object.values(run.levels).filter((l): l is LevelPeople => Boolean(l) && !(override && Object.prototype.hasOwnProperty.call(override, l.level)))
  if (unchanged.length) run.realCheck = realCheck(game, unchanged.map((l) => ({ level: l.level, estimate: l.estimate as PeopleEstimate })), BASELINE)
}
file.runs = [...file.runs.filter((r) => r.label !== label), run]
writeJson(outPath, file)
// --stage: record the levels this run overrides as the settings A9 should publish (never applied here). One file per game, one entry per level.
if (args.includes('--stage') && override) {
  const stagedPath = outPath.replace(/\.json$/, '.staged.json')
  const staged = existsSync(stagedPath) ? (JSON.parse(readFileSync(stagedPath, 'utf8')) as Record<string, unknown>) : {}
  for (const level of levels) {
    const l = run.levels[level]
    if (l && Object.prototype.hasOwnProperty.call(override, level)) staged[level] = { fromRun: label, override: override[level], config: l.config, verdict: l.estimate.verdict, calibrated: l.estimate.calibrated, panel: l.estimate.estimate, perSeat: run.perSeat[level] }
  }
  writeJson(stagedPath, staged)
}
process.exit(0)
