import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { GameId, Level } from '@duelwise/core/src/product'
import { parseRegistry, writeRegistry, type Registry } from '../registry'
import { withGameCeiling, type PeopleEstimate } from './people'

// A9: applies the retune the people measurements staged, through this script and never by hand.
//   bun a9-apply.ts tables   rewrites the level tables in code (four/agent.ts, fleet/levels.ts, slack/levels.ts) and the stored algorithm labels
//                            in the fleet and slack registries from packages/agents/eval/people/<game>.staged.json. Idempotent.
//   bun a9-apply.ts people   writes each published level's `people` block into the game's registry, copied from the eval file that measured it
//                            (the run a staged level came from, else the run labelled `current`; Hold'em: the default match length; realtime: the level's final measurement).
// The registry's ladder, gate and Elo come from each game's own publish script, never from here. Run `tables`, commit, publish, then `people`.

const ROOT = resolve(import.meta.dir, '../../../..')
const PEOPLE_DIR = join(ROOT, 'packages/agents/eval/people')
const REGISTRY_DIR = join(ROOT, 'packages/agents/registry')

export const TURN_GAMES = ['chess', 'four', 'holdem', 'word', 'fleet', 'slack', 'penalty'] as const
export const REALTIME_GAMES = ['fighter', 'arena', 'puck'] as const
export const ALL_GAMES = [...TURN_GAMES, ...REALTIME_GAMES] as const
export const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']
/** Hold'em's default match length in hands (apps/web/src/games/holdem/length.ts); its bands are stated for the default length (D3, ruling Nov 10 17:25). */
export const HOLDEM_DEFAULT_HANDS = 10

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

interface TurnRun {
  label: string
  levels?: Partial<Record<Level, { config: Record<string, unknown>; estimate: PeopleEstimate }>>
  byLength?: Record<string, Partial<Record<Level, { estimate: PeopleEstimate; config?: Record<string, unknown> }>>>
}
interface TurnFile { runs: TurnRun[] }
interface RealtimeFile { levels: Partial<Record<Level, { estimate: PeopleEstimate }>> }
export type StagedFile = Partial<Record<Level, { fromRun?: string; override?: Record<string, unknown>; config?: Record<string, unknown> }>>

export interface PeopleSource {
  /** Repo-relative eval file the block was copied from. */
  file: string
  /** The run (turn games), the match length (Hold'em) or `final` (realtime games). */
  run: string
  estimate: PeopleEstimate
  /** The settings that measurement played, where the file records them. */
  config?: Record<string, unknown>
}

export const stagedPath = (game: string): string => join(PEOPLE_DIR, `${game}.staged.json`)
export const readStaged = (game: string): StagedFile => (existsSync(stagedPath(game)) ? readJson<StagedFile>(stagedPath(game)) : {})

type Best = { value: number; ci95: [number, number]; by: string }

/**
 * The game's ceiling: the highest score against the average test player of any settings measured for it, shipped or tried (every run in the eval file,
 * every level, plus the separate ceiling measurements). A "most we could tune it to" line may rest on nothing less. Hold'em reads the default match length.
 * Null for a game with no eval file or no run.
 */
export function gameBest(game: GameId, dir: string = PEOPLE_DIR): Best | null {
  const file = join(dir, `${game}.json`)
  if (!existsSync(file) || (REALTIME_GAMES as readonly string[]).includes(game)) return null
  const data = readJson<TurnFile & { runs: Array<TurnRun & { ceilings?: Record<string, { value: number; ci95: [number, number]; n: number }> }> }>(file)
  let best: Best | null = null
  const take = (value: number, ci95: [number, number], by: string): void => {
    if (!best || value > best.value) best = { value, ci95: [ci95[0], ci95[1]], by }
  }
  for (const run of data.runs) {
    const cells = game === 'holdem' ? run.byLength?.[String(HOLDEM_DEFAULT_HANDS)] : run.levels
    for (const [level, cell] of Object.entries(cells ?? {})) {
      const avg = cell?.estimate.panel.average
      if (avg) take(avg.value, avg.ci95, `${avg.n} games of the best settings we measured (${run.label}, ${level}) against the average test player`)
    }
    if (game !== 'holdem') for (const c of Object.values(run.ceilings ?? {})) take(c.value, c.ci95, `${c.n} games of the best settings we measured (${run.label}, champion) against the average test player`)
  }
  return best
}

/** The measurement that describes what a level plays after A9, or null when none exists. */
export function peopleSource(game: GameId, level: Level, dir: string = PEOPLE_DIR): PeopleSource | null {
  const file = join(dir, `${game}.json`)
  const rel = `packages/agents/eval/people/${game}.json`
  if (!existsSync(file)) return null
  if ((REALTIME_GAMES as readonly string[]).includes(game)) {
    const e = readJson<RealtimeFile>(file).levels[level]?.estimate
    return e ? { file: rel, run: 'final', estimate: e } : null
  }
  const data = readJson<TurnFile>(file)
  if (game === 'holdem') {
    const l = data.runs.find((r) => r.label === 'current')?.byLength?.[String(HOLDEM_DEFAULT_HANDS)]?.[level]
    return l ? { file: rel, run: `current, ${HOLDEM_DEFAULT_HANDS} hands`, estimate: judged(game, level, l.estimate, dir), ...(l.config ? { config: l.config } : {}) } : null
  }
  const stagedFile = join(dir, `${game}.staged.json`)
  const staged = existsSync(stagedFile) ? readJson<StagedFile>(stagedFile) : {}
  const label = staged[level]?.fromRun ?? 'current'
  const l = data.runs.find((r) => r.label === label)?.levels?.[level]
  return l ? { file: rel, run: label, estimate: judged(game, level, l.estimate, dir), config: l.config } : null
}

/** A ceiling verdict as measured is re-judged against the game's best settings (see gameBest); every other verdict is untouched. */
function judged(game: GameId, level: Level, e: PeopleEstimate, dir: string): PeopleEstimate {
  return e.verdict === 'ceiling' ? withGameCeiling(e, level, gameBest(game, dir)) : e
}

/**
 * The Easy and Medium levels of a game whose people test is in band: the ruling of Nov 10 18:52 has the people panel and the ladder decide those two
 * levels, so a publisher may record the scripted-bot rows without holding the level to their bars. Hard and Champion are never in this set.
 */
export function peopleGatedFor(game: GameId, dir: string = PEOPLE_DIR): Partial<Record<Level, true>> {
  const out: Partial<Record<Level, true>> = {}
  for (const level of ['easy', 'medium'] as Level[]) if (peopleSource(game, level, dir)?.estimate.verdict === 'in-band') out[level] = true
  return out
}

// ---- tables ----

const ts = (v: unknown): string => {
  if (typeof v === 'string') return `'${v}'`
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  throw new Error(`a9-apply: cannot write ${JSON.stringify(v)} into a level table`)
}
const fields = (o: Record<string, unknown>, order: string[]): string => order.filter((k) => o[k] !== undefined).map((k) => `${k}: ${ts(o[k])}`).join(', ')

/** Replaces the single line `  <level>: { ... },` inside the table that starts at `export const <name>`. Throws when the line is not there exactly once. */
export function replaceLevelLine(src: string, table: string, level: Level, line: string): string {
  const start = src.indexOf(`export const ${table}`)
  if (start < 0) throw new Error(`a9-apply: no table ${table}`)
  const end = src.indexOf('\n}', start)
  const body = src.slice(start, end)
  const re = new RegExp(`^  ${level}: \\{.*\\},$`, 'm')
  if (!re.test(body)) throw new Error(`a9-apply: ${table} has no one-line ${level} entry`)
  return src.slice(0, start) + body.replace(re, line) + src.slice(end)
}

/** The algorithm label a Crosscurrent search level carries in the registry: its depth is in the name, so it cannot drift from the config. */
export const slackLabel = (c: { depth: number; mobility: boolean }): string => `search-${c.depth}-ply${c.mobility ? '-mobility' : ''}`
/** Stormglass labels name the hunt (random, checkerboard or map) and what follows a hit. */
export function fleetLabel(c: { hunt: string; target: string; followRate: number }): string {
  if (c.target === 'follow') return `${c.hunt === 'map' ? 'map-hunt' : c.hunt}-with-follow`
  const rate = c.followRate < 1 ? 'half-' : ''
  return `${c.hunt === 'map' ? 'map-hunt' : c.hunt}-with-${rate}${c.target}`
}

function writeIfChanged(path: string, next: string): boolean {
  const prev = readFileSync(path, 'utf8')
  if (prev === next) return false
  writeFileSync(path, next)
  return true
}

export async function applyTables(root: string = ROOT): Promise<string[]> {
  const changed: string[] = []
  const regPath = (g: string): string => join(root, 'packages/agents/registry', `${g}.json`)
  const staged = (g: string): StagedFile => {
    const p = join(root, 'packages/agents/eval/people', `${g}.staged.json`)
    return existsSync(p) ? readJson<StagedFile>(p) : {}
  }

  // Four in a Row: the simulation count and temperature are the whole lever.
  {
    const path = join(root, 'packages/agents/src/four/agent.ts')
    let src = readFileSync(path, 'utf8')
    for (const level of ['easy', 'medium'] as Level[]) {
      const c = staged('four')[level]?.config
      if (!c) continue
      const temp = c.temperature === 0.15 ? 'EASY_TEMPERATURE' : ts(c.temperature)
      src = replaceLevelLine(src, 'FOUR_LEVELS', level, `  ${level}: { model: ${ts(c.model)}, sims: ${ts(c.sims)}, temperature: ${temp}${c.tactics ? ', tactics: true' : ''} },`)
    }
    if (writeIfChanged(path, src)) changed.push('four/agent.ts')
  }
  // Stormglass.
  {
    const path = join(root, 'packages/agents/src/fleet/levels.ts')
    let src = readFileSync(path, 'utf8')
    const names: Record<string, string> = { easy: 'Pip', medium: 'Marlow' }
    for (const level of ['easy', 'medium'] as Level[]) {
      const c = staged('fleet')[level]?.config as { hunt: string; target: string; followRate: number } | undefined
      if (!c) continue
      src = replaceLevelLine(src, 'FLEET_LEVELS', level, `  ${level}: { name: '${names[level]}', ${fields(c, ['hunt', 'target', 'followRate'])} },`)
    }
    if (writeIfChanged(path, src)) changed.push('fleet/levels.ts')
    const reg = JSON.parse(readFileSync(regPath('fleet'), 'utf8')) as Registry
    for (const level of ['easy', 'medium'] as Level[]) {
      const c = staged('fleet')[level]?.config as { hunt: string; target: string; followRate: number } | undefined
      const entry = reg.levels[level]
      if (!c || !entry) continue
      entry.config = { algorithm: fleetLabel(c), hunt: c.hunt, target: c.target, followRate: c.followRate }
    }
    await writeRegistry(regPath('fleet'), reg)
  }
  // Crosscurrent: the table is the config; the registry keeps only the algorithm label, which names the depth.
  {
    const path = join(root, 'packages/agents/src/slack/levels.ts')
    let src = readFileSync(path, 'utf8')
    const reg = JSON.parse(readFileSync(regPath('slack'), 'utf8')) as Registry
    for (const level of ['medium'] as Level[]) {
      const c = staged('slack')[level]?.config as { kind: string; depth: number; mobility: boolean; noise: number } | undefined
      if (!c) continue
      src = replaceLevelLine(src, 'SLACK_LEVELS', level, `  ${level}: { ${fields(c, ['kind', 'depth', 'mobility', 'noise'])} },`)
      const entry = reg.levels[level]
      if (entry) entry.config = { ...entry.config, algorithm: slackLabel(c) }
    }
    if (writeIfChanged(path, src)) changed.push('slack/levels.ts')
    await writeRegistry(regPath('slack'), reg)
  }
  return changed
}

// ---- people blocks ----

export interface AppliedRow { file: string; run: string }

/** Writes the people block into every published level of one registry. Returns what it used, for plan notes. */
export async function applyPeople(game: GameId, root: string = ROOT): Promise<Record<string, AppliedRow>> {
  const path = join(root, 'packages/agents/registry', `${game}.json`)
  const reg = parseRegistry(JSON.parse(readFileSync(path, 'utf8')))
  const used: Record<string, AppliedRow> = {}
  for (const level of LEVELS) {
    const m = reg.measured[level]
    if (!reg.levels[level] || !m) continue
    const src = peopleSource(game, level, join(root, 'packages/agents/eval/people'))
    if (!src) throw new Error(`a9-apply: ${game} ${level} is published but has no people measurement`)
    m.people = src.estimate
    used[level] = { file: src.file, run: src.run }
  }
  await writeRegistry(path, reg)
  return used
}

if (import.meta.main) {
  const cmd = process.argv[2]
  if (cmd === 'tables') {
    console.log('changed:', (await applyTables()).join(', ') || 'nothing')
  } else if (cmd === 'people') {
    const only = process.argv[3]
    const games = only ? [only as GameId] : (ALL_GAMES as readonly GameId[])
    for (const g of games) console.log(g, JSON.stringify(await applyPeople(g)))
  } else {
    console.error('usage: a9-apply.ts tables | people [game]')
    process.exit(2)
  }
}
