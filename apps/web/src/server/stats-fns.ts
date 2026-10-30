import { visibleRegistry } from '../lib/strength-gates'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServerFn } from '@tanstack/react-start'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { validateRegistry, type Registry } from '@duelwise/agents/src/registry'
import { getServerDb } from './server-db'
import { getSessionUser } from './caller'
import { isOwner } from './telemetry'
import { notTrainedSentence, pretrainingSentence, recordsTrainable, visibleJobs } from '../lib/honest-copy'
import {
  getGameStats,
  learnsFromHumansFor,
  parseSupervisor,
  summariseRegistry,
  withRegistryRuns,
  type GameStats,
  type JobRow,
  type RegistrySummary,
  type Tally,
} from './stats'

// Registry JSON ships inside the bundle (the same way matches.ts reads it). adapters.json is T24's
// file; until it exists every game reads "not yet".
const FILES = import.meta.glob('../../../../packages/agents/registry/*.json', { eager: true, import: 'default' }) as Record<string, unknown>

export function fileFor(name: string): unknown {
  return Object.entries(FILES).find(([path]) => path.endsWith(`/${name}.json`))?.[1] ?? null
}

export function registryFor(game: GameId): Registry | null {
  const raw = fileFor(game)
  return raw && validateRegistry(raw).ok ? visibleRegistry(raw as Registry) : null
}

/** True when the game's records are stored trainable, so a flag-off row there is the player's own opt-out. */
export function gameRecordsTrainable(game: GameId): boolean {
  return recordsTrainable(game, registryFor(game))
}

/** The privacy page sentence on which games are not used for training, from the registries. */
export const getNotTrainedSentence = createServerFn({ method: 'GET' }).handler(async (): Promise<string> => {
  const regs: Partial<Record<GameId, Registry | null>> = {}
  for (const g of Object.keys(PRODUCT.games) as GameId[]) regs[g] = registryFor(g)
  return notTrainedSentence(regs)
})

/** Last logged training step of a job, from the tail of its metrics.jsonl. Undefined when there is none. */
function lastStep(dir: string, name: string): number | undefined {
  try {
    const lines = readFileSync(join(dir, name, 'metrics.jsonl'), 'utf8').trimEnd().split('\n')
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i--) {
      const step = (JSON.parse(lines[i]!) as { step?: unknown }).step
      if (typeof step === 'number' && Number.isFinite(step)) return step
    }
  } catch {}
  return undefined
}

function finishedAt(dir: string, name: string): number | undefined {
  try {
    const t = (JSON.parse(readFileSync(join(dir, name, 'state.json'), 'utf8')) as { finishedAt?: unknown }).finishedAt
    return typeof t === 'number' && Number.isFinite(t) ? t : undefined
  } catch {
    return undefined
  }
}

/** <common root>/runs/status.json, read-only. DUELWISE_RUNS_DIR overrides the folder. Null when unavailable (for example on Vercel). */
function readSupervisor(): JobRow[] | null {
  try {
    let dir = process.env.DUELWISE_RUNS_DIR
    if (!dir) {
      const git = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      dir = join(resolve(process.cwd(), git, '..'), 'runs')
    }
    const base = dir
    return parseSupervisor(JSON.parse(readFileSync(join(base, 'status.json'), 'utf8'))).map((j) => {
      if (!/^[a-z0-9-]+$/.test(j.name)) return j
      const steps = lastStep(base, j.name)
      const done = j.state === 'DONE' ? finishedAt(base, j.name) : undefined
      return { ...j, ...(steps !== undefined ? { steps } : {}), ...(done !== undefined ? { finishedAt: done } : {}) }
    })
  } catch {
    return null
  }
}

export interface OverviewRow {
  game: GameId
  version: string | null
  vsHard: { last7: Tally; previous7: Tally }
  publishedCount: number
  /** The one rule: this game's matches are used for training (registry learnsFromHumans). */
  learns: boolean
  lastRun: { challenger: string; promoted: boolean } | null
}

export interface AgentsView {
  game: GameId
  overview: OverviewRow[]
  stats: GameStats
  registry: RegistrySummary
  /** The one rule: this game's matches are used for training (registry learnsFromHumans). */
  learns: boolean
  /** A separate fact: a promoted version already used human matches (adapters.json). */
  hasLearned: boolean
  /** Null when the supervisor's status file is not readable here. */
  jobs: JobRow[] | null
  /** True only for the owner; training jobs are internal and are hidden from everyone else. */
  owner: boolean
  /** Which levels learned from human games before launch, read from the registry; null when none did. */
  pretraining: string | null
}

const GAMES = Object.keys(PRODUCT.games) as GameId[]

export const getAgentsView = createServerFn({ method: 'GET' })
  .validator((d: unknown) => {
    const game = (d as { game?: unknown } | null)?.game
    if (typeof game !== 'string' || !Object.prototype.hasOwnProperty.call(PRODUCT.games, game)) throw new Error('unknown game')
    return { game: game as GameId }
  })
  .handler(async ({ data }): Promise<AgentsView> => {
    const { db } = await getServerDb()
    const owner = isOwner(await getSessionUser(), { OWNER_EMAILS: process.env.OWNER_EMAILS })
    const now = new Date()
    const adapters = fileFor('adapters')
    const overview: OverviewRow[] = []
    let stats: GameStats | null = null
    for (const g of GAMES) {
      const gLearns = gameRecordsTrainable(g)
      const s = withRegistryRuns(g === data.game ? await getGameStats(db, g, now, undefined, gLearns) : await getGameStats(db, g, now, 2, gLearns), registryFor(g))
      if (g === data.game) stats = s
      const reg = summariseRegistry(registryFor(g))
      overview.push({
        game: g,
        version: reg.version,
        vsHard: s.vsHard,
        publishedCount: reg.publishedCount,
        learns: gameRecordsTrainable(g),
        lastRun: s.runs[0] ? { challenger: s.runs[0].challenger, promoted: s.runs[0].promoted } : null,
      })
    }
    return {
      game: data.game,
      overview,
      stats: stats!,
      registry: summariseRegistry(registryFor(data.game)),
      learns: gameRecordsTrainable(data.game),
      hasLearned: learnsFromHumansFor(adapters, data.game),
      jobs: visibleJobs(readSupervisor(), owner),
      owner,
      pretraining: pretrainingSentence(registryFor(data.game)),
    }
  })
