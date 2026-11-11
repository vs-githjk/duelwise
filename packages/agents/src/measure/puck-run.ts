import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { wilson } from './ladder'
import { OBS_FEATURES } from '../puck/view'
import { OrtSession } from '../runtime/ort-session'
import type { Level } from '@duelwise/core/src/product'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { writeRegistry, parseRegistry, type Registry } from '../registry'
import { buildPuckRegistry, type ChampionBots, type LevelInput } from './puck-publish'
import type { PuckBotKind } from '@duelwise/core/src/games/puck/bots'
import { measurePanel, panelEstimate } from './puck-people'
import { PEOPLE_PROFILES, peopleHands, type PeopleProfile } from '@duelwise/core/src/games/puck/seat-hands'
import { botSpec, LEVELS_ORDER, measureBots, measurePair, netSpec, pipSpec, PUCK_BARS, PUCK_BOTS, SEAT_GAMES, type BotRow, type LevelMeasure, type PairResult, type SeatSpec } from './puck'

// CLI for the puck measurement (P11). Run it niced; every command takes absolute paths.
//
//   bun puck-run.ts gate  --level L --model <onnx|pip> --out F.json [--lag 1] [--bots live|human|human-hands] [--hands beginner|average|strong] [--games 400] [--procs 2] [--md FILE] [--label NAME]
//   bun puck-run.ts people --level L --model <onnx|pip> --out F.json [--games 100] [--lag 1] [--procs 2] [--md FILE] [--label NAME]   the agent against the beginner, average and strong test players (games per seat), with the weighted estimate
//   bun puck-run.ts sweep --level L --model <onnx|pip> --delays 9,12,15,18 --out F.json [--lag 1] [--matches 50] [--procs 2] [--md FILE] [--label NAME]   a net against the mouse bot on human hands, per reaction delay
//   bun puck-run.ts pair  --lower-level L --lower-model <onnx|pip> --upper-level L --upper-model <onnx> --out F.json [--lag 1] [--games 400] [--procs 2] [--md FILE]
//   bun puck-run.ts parity --onnx F.onnx --ckpt SNAP.pt          ORT against torch on real observations (the P9 parity test), one published model
//   bun puck-run.ts publish --results DIR --champion A|B --registry OUT.json --existing IN.json [--evals DIR]
//
// `gate` plays each scripted bot (the level's bars) 400 times on each seat. --bots human puts the bots under the level's own delay (Champion's
// default is live: the plan's strict gate); lower levels always use their own delay. --bots human-hands is the Nov 10 re-measure: the bots move
// the rule mallet the person gets in the browser (speed 6, acceleration 120) after --bot-delay frames (default 12, a person's 200 ms), the agent keeps its level's hands.
// 'mouse' may be named in --names as an extra row (it has no bar). The agent's reply lands --lag ticks late (the browser worker).

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined)
const need = (name: string): string => {
  const v = flag(name)
  if (!v) throw new Error(`missing --${name}`)
  return v
}
const abs = (p: string): string => {
  if (!p.startsWith('/')) throw new Error(`pass an absolute path, not ${p}`)
  return p
}
const stamp = (): string => new Date().toLocaleTimeString('en-GB', { hour12: false })

function mdLine(file: string | undefined, line: string): void {
  console.log(line)
  if (file) appendFileSync(file, line + '\n')
}

function specOf(level: Level, model: string, lag: number): SeatSpec {
  // bot:<kind> is a scripted bot at the level's hands (a score-blind control).
  if (model.startsWith('bot:')) return botSpec(model.slice(4) as PuckBotKind, level)
  // --mask-score hides the score from the network: its twin, claim C2's control.
  return model === 'pip' ? pipSpec() : netSpec(level, abs(model), lag, argv.includes('--mask-score'))
}

/** --hands names the people profile the bots play on under --bots human-hands; without it, 'human' (the strong profile, delay 12). */
function handsFlag(): 'human' | PeopleProfile {
  const h = flag('hands') ?? 'human'
  if (h !== 'human' && !PEOPLE_PROFILES.includes(h as PeopleProfile)) throw new Error(`unknown --hands ${h}`)
  return h as 'human' | PeopleProfile
}

async function gate(): Promise<void> {
  const level = need('level') as Level
  const lag = Number(flag('lag') ?? 1)
  const games = Number(flag('games') ?? SEAT_GAMES)
  const procs = Number(flag('procs') ?? 2)
  const label = flag('label') ?? level
  const md = flag('md')
  const botLimits = (flag('bots') ?? (level === 'champion' ? 'live' : 'human')) as 'live' | 'human' | 'human-hands'
  if (!['live', 'human', 'human-hands'].includes(botLimits)) throw new Error(`unknown --bots ${botLimits}`)
  const botDelay = botLimits === 'live' ? 0 : botLimits === 'human-hands' ? Number(flag('bot-delay') ?? peopleHands(handsFlag() === 'human' ? 'strong' : (handsFlag() as PeopleProfile)).delayFrames) : LEVEL_LIMITS.puck[level].delayFrames
  const bots = flag('names') ? flag('names')!.split(',') : Object.keys(PUCK_BARS[level])
  for (const b of bots) if (!PUCK_BOTS.includes(b as never) && b !== 'mouse') throw new Error(`unknown bot ${b}`)
  const agent = specOf(level, need('model'), lag)
  const t0 = Date.now()
  const result = await measureBots(agent, bots, {
    games,
    botDelay,
    botHands: botLimits === 'human-hands' ? handsFlag() : 'level',
    procs,
    onRow: (row: BotRow) => {
      for (const seat of ['0', '1'] as const) {
        const s = row.bySeat[seat]
        const lower = wilson(s.wins + s.draws / 2, s.games)[0]
        const bar = PUCK_BARS[level][row.bot]
        mdLine(md, `| ${stamp()} | ${label} ${agent.type === 'net' ? `lag${lag}` : 'scripted (same tick)'} bots:${botLimits}${botLimits === 'human-hands' ? `@${botDelay}f` : ''} | ${row.bot} | ${seat} | ${s.games} | ${(s.score * 100).toFixed(1)}% (${s.wins}-${s.draws}-${s.losses}) | ${lower.toFixed(3)} | ${bar ?? '-'} | ${bar === undefined ? '-' : lower >= bar ? 'pass' : 'FAIL'} |`)
      }
    },
  })
  writeFileSync(abs(need('out')), JSON.stringify({ ...result, label, botLimits, botDelay, model: need('model'), seconds: Math.round((Date.now() - t0) / 1000) }, null, 1) + '\n')
  console.log(`done ${label} in ${Math.round((Date.now() - t0) / 1000)} s`)
}

/** A net (or Pip) against the scripted mouse bot on human hands, once per reaction delay, `matches` in all (half on each seat). */
async function sweep(): Promise<void> {
  const level = need('level') as Level
  const lag = Number(flag('lag') ?? 1)
  const matches = Number(flag('matches') ?? 50)
  const procs = Number(flag('procs') ?? 2)
  const label = flag('label') ?? level
  const md = flag('md')
  const agent = specOf(level, need('model'), lag)
  const points: Array<{ delay: number; ms: number; matches: number; wins: number; draws: number; losses: number; score: number; ci95: [number, number]; goalsFor: number; goalsAgainst: number }> = []
  for (const delay of need('delays').split(',').map(Number)) {
    const r = await measureBots(agent, ['mouse'], { games: Math.ceil(matches / 2), botDelay: delay, botHands: 'human', procs, seedBase: 900_000 })
    const row = r.rows[0]!
    const goals = r.aggregate.states.reduce((a, t) => [a[0]! + t.goalsFor, a[1]! + t.goalsAgainst], [0, 0])
    const p = { delay, ms: Math.round((delay * 1000) / 60), matches: row.games, wins: row.wins, draws: row.draws, losses: row.losses, score: row.score, ci95: row.ci95, goalsFor: goals[0]!, goalsAgainst: goals[1]! }
    points.push(p)
    mdLine(md, `| ${label} | ${delay} frames (${p.ms} ms) | ${p.matches} | ${p.wins}-${p.draws}-${p.losses} | ${(p.score * 100).toFixed(1)}% | ${p.ci95[0].toFixed(3)} to ${p.ci95[1].toFixed(3)} | ${p.goalsFor}-${p.goalsAgainst} |`)
  }
  writeFileSync(abs(need('out')), JSON.stringify({ label, level, lag, points }, null, 1) + '\n')
}

/** The agent against each panel test player (beginner, average, strong), `games` per seat, and the weighted estimate against the level's band. */
async function people(): Promise<void> {
  const level = need('level') as Level
  const lag = Number(flag('lag') ?? 1)
  const games = Number(flag('games') ?? 100)
  const procs = Number(flag('procs') ?? 2)
  const label = flag('label') ?? level
  const agent = specOf(level, need('model'), lag)
  const t0 = Date.now()
  const result = await measurePanel(agent, { games, procs })
  const est = panelEstimate(agent, result)
  for (const proxy of PEOPLE_PROFILES) {
    const t = result.tallies[proxy]
    mdLine(flag('md'), `| ${stamp()} | ${label} people ${proxy} | ${t.games} | ${t.wins}-${t.draws}-${t.losses} | ${(result.panel[proxy].value * 100).toFixed(1)}% | seat0 ${(t.bySeat['0'] * 100).toFixed(1)}% seat1 ${(t.bySeat['1'] * 100).toFixed(1)}% |`)
  }
  mdLine(flag('md'), `| ${stamp()} | ${label} weighted estimate | ${(est.estimate * 100).toFixed(1)}% (${(est.ci95[0] * 100).toFixed(1)} to ${(est.ci95[1] * 100).toFixed(1)}) | band ${(est.band.low * 100).toFixed(0)} to ${(est.band.high * 100).toFixed(0)} | ${est.verdict} |`)
  writeFileSync(abs(need('out')), JSON.stringify({ label, level, lag, gamesPerSeat: games, ...result, estimate: est, seconds: Math.round((Date.now() - t0) / 1000) }, null, 1) + '\n')
  console.log(`done ${label} people in ${Math.round((Date.now() - t0) / 1000)} s: estimate ${est.estimate.toFixed(3)} (${est.verdict})`)
}

async function pair(): Promise<void> {
  const lag = Number(flag('lag') ?? 1)
  const games = Number(flag('games') ?? SEAT_GAMES)
  const procs = Number(flag('procs') ?? 2)
  const lower = specOf(need('lower-level') as Level, need('lower-model'), lag)
  const upper = specOf(need('upper-level') as Level, need('upper-model'), lag)
  const t0 = Date.now()
  const r = await measurePair(lower, upper, { games, procs })
  const md = flag('md')
  for (const seat of ['0', '1'] as const) {
    const s = r.bySeat[seat]
    const lb = wilson(s.wins + s.draws / 2, s.games)[0]
    mdLine(md, `| ${stamp()} | ladder ${r.upper} v ${r.lower} lag${lag} | ${r.upper} | ${seat} | ${s.games} | ${(s.score * 100).toFixed(1)}% (${s.wins}-${s.draws}-${s.losses}) | ${lb.toFixed(3)} | 0.5 | ${lb > 0.5 ? 'pass' : 'FAIL'} |`)
  }
  writeFileSync(abs(need('out')), JSON.stringify(r, null, 1) + '\n')
  console.log(`done ${r.upper} v ${r.lower} in ${Math.round((Date.now() - t0) / 1000)} s, score ${r.score.toFixed(3)}`)
}

/** ORT (the browser path) against torch on the parity observations of the P9 test, for one exported model. */
async function parity(): Promise<void> {
  const onnx = abs(need('onnx'))
  const ckpt = abs(need('ckpt'))
  const root = resolve(import.meta.dir, '../../../..')
  const fixture = JSON.parse(readFileSync(join(root, 'packages/agents/test-fixtures/puck-parity.json'), 'utf8')) as { obs: number[][] }
  const dir = dirname(onnx)
  const tmp = join(dir, `.parity-${process.pid}`)
  mkdirSync(tmp, { recursive: true })
  writeFileSync(join(tmp, 'obs.json'), JSON.stringify({ obs: fixture.obs }))
  const py = join(process.env.HOME!, '.local/share/duelwise-export-venv/bin/python')
  execSync(`${py} ${join(root, 'packages/agents/fixtures/puck-dump-weights.py')} --ckpt ${ckpt} --out ${join(tmp, 'w.json')} --obs ${join(tmp, 'obs.json')} --logits ${join(tmp, 'l.json')}`, { env: { ...process.env, PYTHONPATH: join(root, 'training') }, stdio: 'inherit' })
  const logits = (JSON.parse(readFileSync(join(tmp, 'l.json'), 'utf8')) as { logits: number[][][] }).logits
  const session = await OrtSession.create(new Uint8Array(readFileSync(onnx)))
  let worst = 0
  for (let i = 0; i < fixture.obs.length; i++) {
    const out = Object.values(await session.run(session.inputNames[0]!, Float32Array.from(fixture.obs[i]!), [1, OBS_FEATURES]))
    for (const h of [0, 1] as const) for (let j = 0; j < logits[h]![i]!.length; j++) worst = Math.max(worst, Math.abs(out[h]![j]! - logits[h]![i]![j]!))
  }
  await session.dispose()
  execSync(`rm -rf ${tmp}`)
  console.log(JSON.stringify({ onnx, ckpt, observations: fixture.obs.length, worstAbsDiff: worst, tolerance: 1e-5, pass: worst <= 1e-5 }))
  if (!(worst <= 1e-5)) process.exit(2)
}

/** Records which snapshot a level's model was exported from (repo-relative under the common root, never a machine path). */
async function source(): Promise<void> {
  const file = abs(need('out'))
  const snap = abs(need('snap'))
  const { commonRoot } = await import('../../../../scripts/paths')
  const common = commonRoot(resolve(import.meta.dir, '../../../..'))
  const rel = snap.startsWith(common + '/') ? snap.slice(common.length + 1) : null
  if (!rel) throw new Error(`snapshot ${snap} is outside the common root ${common}`)
  const step = Number(/-(\d+)\.pt$/.exec(snap)?.[1])
  if (!Number.isInteger(step)) throw new Error(`cannot read the step from ${snap}`)
  const all: Sources = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Sources) : {}
  for (const level of need('levels').split(',')) all[level] = { source: rel, step, absolute: abs(need('onnx')), artifact: need('artifact') }
  writeFileSync(file, JSON.stringify(all, null, 1) + '\n')
}

interface Sources {
  [level: string]: { source: string; step: number; absolute: string; artifact: string }
}

async function publish(): Promise<void> {
  const results = abs(need('results'))
  // H: the human-hands re-measure (every level's file is <level>.json, the slower-person run <level>.d18.json).
  const outcome = need('champion') as 'A' | 'B' | 'H'
  const championBots: ChampionBots = outcome === 'A' ? 'live' : outcome === 'B' ? 'human' : 'human-hands'
  const root = resolve(import.meta.dir, '../../../..')
  const sources = JSON.parse(readFileSync(join(results, 'sources.json'), 'utf8')) as Sources
  const read = <T>(name: string): T | null => (existsSync(join(results, name)) ? (JSON.parse(readFileSync(join(results, name), 'utf8')) as T) : null)
  const levels: Partial<Record<Level, LevelInput>> = {}
  for (const level of LEVELS_ORDER) {
    const name = level === 'champion' && outcome !== 'H' ? `champion.${outcome}` : level
    const measure = read<LevelMeasure>(`${name}.json`)
    if (!measure) continue
    const src = sources[level]
    const parityFile = src && level !== 'easy' ? `${src.absolute}.parity.json` : null
    levels[level] = { control: read<LevelMeasure>(`${name}.twin.json`) ?? undefined, parity: parityFile && existsSync(parityFile) ? (() => { const p = JSON.parse(readFileSync(parityFile, 'utf8').trim().split('\n').pop()!) as { worstAbsDiff: number; tolerance: number; observations: number; pass: boolean }; return { worstAbsDiff: p.worstAbsDiff, tolerance: p.tolerance, observations: p.observations, pass: p.pass } })() : undefined, measure, lag2: read<LevelMeasure>(`${name}.lag2.json`) ?? undefined, slower: outcome === 'H' ? read<LevelMeasure>(`${name}.d18.json`) ?? undefined : undefined, model: level === 'easy' || !src ? null : { artifact: src.artifact, absolute: src.absolute, source: src.source, step: src.step } }
  }
  const pairs: PairResult[] = []
  for (const upper of ['medium', 'hard', 'champion'] as const) {
    const p = read<PairResult>(`pair-${upper}.json`)
    if (p) pairs.push(p)
  }
  const existing = parseRegistry(JSON.parse(readFileSync(abs(need('existing')), 'utf8')))
  const reg: Registry = buildPuckRegistry({ levels, pairs, existing, championBots, now: new Date().toISOString(), commit: execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim() })
  await writeRegistry(abs(need('registry')), reg)
  // Models of the published levels go where the registry says (--models: a repo root; default this repo). Outcome B points it at a staging dir.
  const modelsRoot = flag('models') ? abs(flag('models')!) : root
  for (const [level] of Object.entries(reg.levels)) {
    const src = sources[level]
    if (!src || level === 'easy') continue
    mkdirSync(dirname(join(modelsRoot, src.artifact)), { recursive: true })
    copyFileSync(src.absolute, join(modelsRoot, src.artifact))
  }
  const evals = flag('evals')
  if (evals) {
    mkdirSync(abs(evals), { recursive: true })
    for (const level of LEVELS_ORDER) {
      const li = levels[level]
      if (!li) continue
      const file = level === 'champion' && outcome === 'B' ? 'champion.B.json' : `${level}.json`
      writeFileSync(join(evals, file), JSON.stringify(li.measure.rows, null, 1) + '\n')
    }
  }
  console.log(JSON.stringify({ published: Object.keys(reg.levels), unpublished: reg.unpublished, measured: Object.fromEntries(Object.entries(reg.measured).map(([k, m]) => [k, { value: m.value, n: m.n, siteElo: m.siteElo }])) }, null, 1))
}

if (import.meta.main) {
  const cmd = argv[0]
  if (cmd === 'gate') await gate()
  else if (cmd === 'pair') await pair()
  else if (cmd === 'people') await people()
  else if (cmd === 'sweep') await sweep()
  else if (cmd === 'parity') await parity()
  else if (cmd === 'publish') await publish()
  else if (cmd === 'source') await source()
  else throw new Error('usage: puck-run.ts gate|people|pair|parity|publish|source')
}

