import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { PEOPLE_PROFILES, type PeopleProfile } from '@duelwise/core/src/people-hands'
import type { Level } from '@duelwise/core/src/product'
import { wilson } from './ladder'
import { estimatePeople, loadBaseline, type PeopleEstimate, type Proxy, type ProxyScore } from './people'

// A4: the people panel for the real-time games whose agents are measured by the training env (Tinderbox, Coldstore). Each test player is a scripted
// bot on a people profile (core/src/people-hands.ts); the panel's score for a profile is the agent's points over every one of the game's person-like
// styles, equal games each. The matches run in the same env the agent trains in (trainer.ppo.eval_bots with a `kind@profile` bot), so a number here is
// the number the trainer sees.

export interface EvalRow {
  bot: string
  games: number
  wins: number
  draws: number
  losses: number
  score: number
  bySeat?: Record<'0' | '1', { games: number; wins: number; draws: number; losses: number; score: number }>
}

export interface PanelResult {
  panel: Record<Proxy, ProxyScore>
  /** Each profile's wins, draws and losses over all styles, and the score on each of the agent's seats, so a reader can recount. */
  tallies: Record<Proxy, { games: number; wins: number; draws: number; losses: number; bySeat: Record<'0' | '1', number>; byBot: Record<string, number> }>
}

const points = (r: Pick<EvalRow, 'wins' | 'draws'>): number => r.wins + r.draws / 2

/** The row of a kind on a profile (`rushdown@average`) or a plain kind. Throws when the evaluation is missing one, so a panel is never quietly short. */
function need(rows: EvalRow[], name: string): EvalRow {
  const r = rows.find((x) => x.bot === name)
  if (!r) throw new Error(`panel: no result for ${name}`)
  return r
}

/** The agent's panel score per profile from eval_bots rows named `<kind>@<profile>`. */
export function panelFromRows(rows: EvalRow[], kinds: readonly string[]): PanelResult {
  const panel = {} as Record<Proxy, ProxyScore>
  const tallies = {} as PanelResult['tallies']
  for (const profile of PEOPLE_PROFILES) {
    const mine = kinds.map((k) => need(rows, `${k}@${profile}`))
    const games = mine.reduce((n, r) => n + r.games, 0)
    const pts = mine.reduce((n, r) => n + points(r), 0)
    const seat = (s: '0' | '1'): number => {
      const g = mine.reduce((n, r) => n + (r.bySeat?.[s].games ?? 0), 0)
      return g ? mine.reduce((n, r) => n + (r.bySeat ? r.bySeat[s].score * r.bySeat[s].games : 0), 0) / g : NaN
    }
    panel[profile] = { value: games ? pts / games : 0, ci95: wilson(pts, games), n: games }
    tallies[profile] = {
      games,
      wins: mine.reduce((n, r) => n + r.wins, 0),
      draws: mine.reduce((n, r) => n + r.draws, 0),
      losses: mine.reduce((n, r) => n + r.losses, 0),
      bySeat: { '0': seat('0'), '1': seat('1') },
      byBot: Object.fromEntries(mine.map((r) => [r.bot, r.score])),
    }
  }
  return { panel, tallies }
}

/** The old gate's number for the same styles: the agent against the plain bots, which play under the level's own limits (live view at Champion). */
export function gateStyleScore(rows: EvalRow[], kinds: readonly string[]): ProxyScore {
  const mine = kinds.map((k) => need(rows, k))
  const games = mine.reduce((n, r) => n + r.games, 0)
  const pts = mine.reduce((n, r) => n + points(r), 0)
  return { value: games ? pts / games : 0, ci95: wilson(pts, games), n: games }
}

export interface EvalJob {
  game: 'fighter' | 'arena'
  ckpt: string
  level: Level
  bots: string[]
  /** Matches per bot, split evenly over both seats. */
  games: number
}

/** Runs trainer.ppo.eval_bots (niced, from this checkout) and parses its rows. */
export function runEval(root: string, job: EvalJob): EvalRow[] {
  const r = spawnSync('nice', ['-n', '10', resolve(root, 'scripts/py'), '-m', 'trainer.ppo.eval_bots', '--game', job.game, '--level', job.level, '--ckpt', job.ckpt, '--games', String(job.games), '--bots', job.bots.join(',')], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (r.status !== 0) throw new Error(`eval_bots failed (${r.status}) for ${job.game} ${job.level}`)
  return JSON.parse(r.stdout) as EvalRow[]
}

export interface PreRead {
  game: 'fighter' | 'arena'
  level: Level
  ckpt: string
  panel: PanelResult
  gateStyle: ProxyScore
  estimate: PeopleEstimate
}

/** One level of the pre-read: the panel and the gate-style bots, 'games' matches per bot. */
export function preRead(root: string, game: 'fighter' | 'arena', level: Level, ckpt: string, kinds: readonly string[], games: number, proxies: Record<Proxy, string>, baselinePath: string): PreRead {
  const bots = [...PEOPLE_PROFILES.flatMap((p: PeopleProfile) => kinds.map((k) => `${k}@${p}`)), ...kinds]
  const rows = runEval(root, { game, ckpt, level, bots, games })
  const panel = panelFromRows(rows, kinds)
  const real = loadBaseline(baselinePath).get(`${game}/${level}`) ?? null
  return { game, level, ckpt, panel, gateStyle: gateStyleScore(rows, kinds), estimate: estimatePeople(panel.panel, real, 0, level, { proxies }) }
}

export function writeJson(path: string, value: unknown): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
/** One markdown row: level, gate-style score, the three panel scores, the weighted estimate and its band verdict. */
export function tableRow(r: PreRead): string {
  const p = r.estimate.panel
  const e = r.estimate
  const real = e.real ? `${pct(e.real.value)} (${e.real.n})` : 'under the minimum'
  return `| ${r.game} ${r.level} | ${pct(r.gateStyle.value)} | ${pct(p.beginner.value)} | ${pct(p.average.value)} | ${pct(p.strong.value)} | ${pct(e.estimate)} (${pct(e.ci95[0])} to ${pct(e.ci95[1])}) | ${pct(e.band.low)} to ${pct(e.band.high)} | ${e.verdict} | ${real} |`
}
export const TABLE_HEAD = '| level | old gate styles (level limits) | beginner | average | strong | people estimate 30/50/20 | band | verdict | real matches |\n|---|---|---|---|---|---|---|---|---|'
