import { existsSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { ACTION_WIDTH, EQUITY_VERSION, Abstraction, assertEquityVersion, COARSE, FINE, computeThresholds, tableSizeEstimate, type AbstractionConfig } from './abstraction'
import { holdemGame, type HoldemNode } from './holdem-game'
import { Mccfr, normalised, restoreSolver, serializeSolver } from './mccfr'
import { abstractionMeta, encodeTable, type TableEntry } from './table-format'

// Resumable external-sampling MCCFR for the abstracted hold'em game.
//
//   bun cfr-main.ts --abstraction coarse|fine --iterations N --snapshots a,b,c --out-dir /abs/dir
//                   [--ckpt-dir /abs/dir] [--seed S] [--resume] [--max-minutes M]
//                   [--ckpt-every-seconds 600] [--print-sizes]
//
// Writes <out-dir>/tables/iter-<N>.dwht at each snapshot count and <out-dir>/tables/final.dwht
// when it stops, checkpoints to <ckpt-dir>/state.bin, and touches $TRAINER_HEARTBEAT as it goes.
// Each iteration draws from its own seeded stream, so a resumed run continues exactly.

export const CONFIGS: Record<string, AbstractionConfig> = { coarse: COARSE, fine: FINE }
const THRESHOLD_SAMPLES: [number, number, number] = [20000, 40000, 40000]

export function buildTable(m: Mccfr<HoldemNode>, abs: Abstraction, note: string): Uint8Array {
  const entries: TableEntry[] = []
  for (const [key, node] of m.nodes) entries.push({ key, mask: node.mask, probs: normalised(node.sum, node.mask, ACTION_WIDTH) })
  return encodeTable(
    { abstraction: abstractionMeta(abs), iterations: m.iteration, note },
    entries,
  )
}

function atomicWrite(path: string, bytes: Uint8Array | string): void {
  const tmp = path + '.tmp-' + process.pid
  writeFileSync(tmp, bytes)
  renameSync(tmp, path)
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : undefined
}

function needAbs(label: string, p: string | undefined): string {
  if (!p || !isAbsolute(p)) throw new Error(label + ' must be an absolute path, got ' + String(p))
  return p
}

function touch(path: string | undefined): void {
  if (!path) return
  try {
    const now = new Date()
    if (existsSync(path)) utimesSync(path, now, now)
    else closeSync(openSync(path, 'w'))
  } catch {
    // A missing run directory must not kill training.
  }
}

export function main(argv: string[]): number {
  const cfgName = arg(argv, 'abstraction') ?? 'coarse'
  const config = CONFIGS[cfgName]
  if (!config) throw new Error('unknown abstraction ' + cfgName)
  if (argv.includes('--print-sizes')) {
    for (const c of Object.values(CONFIGS)) {
      const e = tableSizeEstimate(c)
      console.log(
        `${c.name}: buckets ${c.buckets.join('/')}; betting states per street ${e.states.join('/')}; ` +
          `infosets per street ${e.infosets.join('/')}; total ${e.total}; table about ${(e.bytes / 1e6).toFixed(2)} MB raw`,
      )
    }
    return 0
  }
  const runDir = needAbs('--out-dir', arg(argv, 'out-dir') ?? process.env.TRAINER_RUN_DIR)
  const ckptDir = needAbs('--ckpt-dir', arg(argv, 'ckpt-dir') ?? join(runDir, 'ckpt'))
  const tablesDir = join(runDir, 'tables')
  mkdirSync(ckptDir, { recursive: true })
  mkdirSync(tablesDir, { recursive: true })
  const total = Number(arg(argv, 'iterations') ?? 8_000_000)
  const snapshots = (arg(argv, 'snapshots') ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number)
    .filter((n) => n > 0 && n <= total)
    .sort((a, b) => a - b)
  const seed = Number(arg(argv, 'seed') ?? 14)
  const maxMs = Number(arg(argv, 'max-minutes') ?? Infinity) * 60_000
  const ckptEveryMs = Number(arg(argv, 'ckpt-every-seconds') ?? 600) * 1000
  const heartbeat = process.env.TRAINER_HEARTBEAT
  // Bucket cut points are computed once and kept, so every resume and every table agrees.
  const thrPath = join(runDir, `thresholds-${config.name}.json`)
  let thresholds: number[][] | undefined
  if (existsSync(thrPath)) {
    const stored = JSON.parse(readFileSync(thrPath, 'utf8')) as { equityVersion?: string; thresholds?: number[][] } | number[][]
    assertEquityVersion(`thresholds file ${thrPath}`, Array.isArray(stored) ? undefined : stored.equityVersion)
    thresholds = (stored as { thresholds: number[][] }).thresholds
  }
  if (!thresholds) {
    thresholds = computeThresholds(config, { samples: THRESHOLD_SAMPLES })
    atomicWrite(thrPath, JSON.stringify({ equityVersion: EQUITY_VERSION, thresholds }))
  }
  const abs = new Abstraction(config, thresholds)
  const m = new Mccfr(holdemGame(abs), { plus: true, linear: true })
  const ckptPath = join(ckptDir, 'state.bin')
  const verPath = join(ckptDir, 'state.equity')
  if (argv.includes('--resume') && existsSync(ckptPath)) {
    assertEquityVersion(`checkpoint ${ckptPath}`, existsSync(verPath) ? readFileSync(verPath, 'utf8').trim() : undefined)
    restoreSolver(m, new Uint8Array(readFileSync(ckptPath)))
    console.log(`holdem-cfr: resumed at iteration ${m.iteration} with ${m.nodes.size} infosets`)
  } else console.log(`holdem-cfr: fresh start (${config.name}, seed ${seed}, target ${total})`)

  const checkpoint = (): void => {
    atomicWrite(ckptPath, serializeSolver(m))
    atomicWrite(verPath, EQUITY_VERSION)
  }
  const snapshot = (name: string): void => {
    const note = `holdem-${config.name} seed ${seed} iteration ${m.iteration}`
    atomicWrite(join(tablesDir, name), buildTable(m, abs, note))
    console.log(`holdem-cfr: wrote ${name} at iteration ${m.iteration} (${m.nodes.size} infosets)`)
  }

  let stopping = false
  process.on('SIGTERM', () => {
    stopping = true
  })
  const started = Date.now()
  let lastCkpt = Date.now()
  let lastLog = Date.now()
  while (m.iteration < total && !stopping && Date.now() - started < maxMs) {
    const next = snapshots.find((s) => s > m.iteration) ?? total
    const chunk = Math.min(250, next - m.iteration, total - m.iteration)
    m.run(chunk, seed)
    touch(heartbeat)
    if (snapshots.includes(m.iteration)) {
      snapshot(`iter-${m.iteration}.dwht`)
      checkpoint()
      lastCkpt = Date.now()
    }
    if (Date.now() - lastCkpt >= ckptEveryMs) {
      checkpoint()
      lastCkpt = Date.now()
    }
    if (Date.now() - lastLog >= 60_000) {
      console.log(`holdem-cfr: iteration ${m.iteration}/${total}, ${m.nodes.size} infosets, ${Math.round((Date.now() - started) / 1000)} s`)
      lastLog = Date.now()
    }
    if (existsSync(join(runDir, 'STOP'))) stopping = true
  }
  checkpoint()
  snapshot('final.dwht')
  if (stopping) return 143
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
