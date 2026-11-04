/**
 * Launch smoke test.
 *
 *   bun run smoke                                   local production build on a throwaway database
 *   bun run smoke -- --url https://<site>           GET only: every route plus the auth health endpoint
 *   bun run smoke -- --url https://<site> --allow-write   adds one POST of junk bytes to /api/finish
 *
 * Local mode never opens Vidyut's dev database or any DATABASE_URL: the built server runs with
 * DUELWISE_DB=memory and an environment built from scratch, and the handler check uses a fresh
 * PGlite directory under the system temp folder.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { cpSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { makeRng } from '@duelwise/core/src/rng'
import { PRODUCT } from '@duelwise/core/src/product'
import { migrateDb } from '../apps/web/src/db/migrate'
import * as schema from '../apps/web/src/db/schema'
import { finishMatchHandler, startMatchHandler } from '../apps/web/src/server/match-handlers'
import { makeServerAgent } from '../apps/web/src/server/agent-models'
import { serverVerifyAgent } from '../apps/web/src/server/verify-agent'

export interface SmokeOptions {
  url: string | undefined
  allowWrite: boolean
}

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const ROOT = resolve(import.meta.dir, '..')

export function parseArgs(argv: string[]): SmokeOptions {
  let url: string | undefined
  let allowWrite = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--url') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error('--url needs a value, for example --url https://your-site.vercel.app')
      url = v
    } else if (a === '--allow-write') allowWrite = true
    else throw new Error(`unknown argument ${a}`)
  }
  return { url, allowWrite }
}

/** Every page the site serves, one per game where the page is per game (the URL uses the game's slug). */
export function smokeRoutes(): string[] {
  const slugs = Object.values(PRODUCT.games).map((g) => g.slug)
  return ['/', '/play', '/privacy', '/terms', '/settings', '/signin', ...slugs.flatMap((g) => [`/play/${g}`, `/agents/${g}`, `/leaderboard/${g}`])]
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

export interface UrlSmokeOptions {
  allowWrite: boolean
  fetchFn?: typeof fetch
}

/** Hits a running site. GET only unless allowWrite; the one write is a POST of junk bytes that must be refused with 400. */
export async function runUrlSmoke(baseUrl: string, opts: UrlSmokeOptions): Promise<Check[]> {
  const base = new URL(baseUrl)
  if (base.protocol !== 'https:' && !isLocalHost(base.hostname)) throw new Error(`refusing ${baseUrl}: a deployed site must be https`)
  const origin = base.origin
  // Every request says it is a test run (the dw_test marker), so the owner page counts it as test traffic, never as a player.
  const rawFetch = opts.fetchFn ?? fetch
  const doFetch = ((input: RequestInfo | URL, init?: RequestInit) => rawFetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), 'x-dw-test': '1' } })) as typeof fetch
  const checks: Check[] = []

  for (const path of smokeRoutes()) {
    const name = `GET ${path}`
    try {
      const res = await doFetch(origin + path, { method: 'GET', redirect: 'manual' })
      const type = res.headers.get('content-type') ?? ''
      const ok = res.status === 200 && type.includes('text/html')
      checks.push({ name, ok, detail: ok ? '200 html' : `status ${res.status}, content-type ${type || 'none'}` })
    } catch (e) {
      checks.push({ name, ok: false, detail: errText(e) })
    }
  }

  try {
    const res = await doFetch(`${origin}/api/auth/ok`, { method: 'GET' })
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null
    const ok = res.status === 200 && body?.ok === true
    checks.push({ name: 'GET /api/auth/ok', ok, detail: ok ? 'auth is mounted' : `status ${res.status}` })
  } catch (e) {
    checks.push({ name: 'GET /api/auth/ok', ok: false, detail: errText(e) })
  }

  if (!opts.allowWrite) {
    checks.push({ name: 'POST /api/finish', ok: true, detail: 'skipped (pass --allow-write to send one junk upload; it creates a guest row)' })
    return checks
  }
  try {
    const res = await doFetch(`${origin}/api/finish`, { method: 'POST', body: new Uint8Array(24).fill(7), headers: { 'content-type': 'application/octet-stream' } })
    const ok = res.status === 400
    checks.push({ name: 'POST /api/finish', ok, detail: ok ? 'junk upload refused with 400' : `expected 400, got ${res.status}` })
  } catch (e) {
    checks.push({ name: 'POST /api/finish', ok: false, detail: errText(e) })
  }
  return checks
}

/** Plays a whole Four in a Row game on the real core. The human moves randomly in the seat the server issued (a random side) and the other seat is the server's actual Easy agent. */
async function playFour(matchId: string, seed: number, humanSeat: 0 | 1): Promise<MatchRecordV1> {
  const rng = makeRng(seed ^ 0x9e37)
  const agentSeat = (1 - humanSeat) as 0 | 1
  const agent = await makeServerAgent('four', 'easy', agentSeat, null)
  agent.reset(seed, agentSeat)
  let s = fourCore.init(seed)
  const actions: MatchRecordV1['actions'] = []
  let tick = 0
  try {
    while (!fourCore.terminal(s)) {
      const seat = fourCore.toAct(s)[0]!
      const action = seat === humanSeat
        ? fourCore.legal(s, seat)[rng.int(fourCore.legal(s, seat).length)]!
        : (await agent.act(fourCore.observe(s, seat), s))[0]
      if (action === undefined) throw new Error('the Four agent returned no action')
      actions.push([tick, seat, fourCore.encodeAction(action)])
      s = fourCore.step(s, seat === 0 ? [action, null] : [null, action])
      tick++
    }
  } finally {
    agent.dispose()
  }
  const now = new Date().toISOString()
  return {
    schema: 1, matchId, game: 'four', coreVersion: fourCore.version,
    agent: { version: 'v1', level: 'easy' }, seed, humanSeat, actions,
    result: fourCore.result(s)!, finalHash: fourCore.hash(s),
    startedAt: now, endedAt: now, device: 'desktop', input: 'mouse', trainingAllowed: true,
  }
}

/** The match path without HTTP: start, play, upload, replay validation, and the stored row, on a fresh PGlite directory. */
export async function runHandlerSmoke(): Promise<Check[]> {
  const checks: Check[] = []
  const dir = await mkdtemp(join(tmpdir(), 'duelwise-smoke-'))
  const client = new PGlite(join(dir, 'pg'))
  try {
    const db = drizzle(client, { schema })
    try {
      await migrateDb(db)
      checks.push({ name: 'migrations apply to a temp PGlite dir', ok: true, detail: dir })
    } catch (e) {
      checks.push({ name: 'migrations apply to a temp PGlite dir', ok: false, detail: errText(e) })
      return checks
    }

    const guestId = crypto.randomUUID()
    await db.insert(schema.guest).values({ id: guestId })
    const who = { guestId }
    const started = await startMatchHandler(db, { game: 'four', level: 'easy', sides: 1 }, who)
    const sb = started.body as { matchId?: string; seed?: number; humanSeat?: 0 | 1 }
    const startedOk = started.status === 200 && typeof sb.matchId === 'string' && typeof sb.seed === 'number'
    checks.push({ name: 'start a four match', ok: startedOk, detail: startedOk ? `match ${sb.matchId}` : `status ${started.status}` })
    if (!startedOk) return checks

    const rec = await playFour(sb.matchId!, sb.seed!, sb.humanSeat ?? 0)
    const finished = await finishMatchHandler(db, encodeRecord(rec), who, { verifyAgent: serverVerifyAgent({ NODE_ENV: 'production' }) })
    const fb = finished.body as { valid?: boolean; reason?: string }
    const finishedOk = finished.status === 200 && fb.valid === true
    checks.push({ name: 'finish it with a replayable record and the real agent check', ok: finishedOk, detail: finishedOk ? `${rec.actions.length} actions replayed and checked` : `status ${finished.status}, ${fb.reason ?? 'invalid'}` })

    const row = (await db.select().from(schema.match).where(eq(schema.match.id, sb.matchId!)))[0]
    const rowOk = row?.status === 'finished' && row.recordValid === true && row.finishedAt !== null && (row.record?.length ?? 0) > 0
    checks.push({ name: 'database row is finished and valid', ok: rowOk, detail: rowOk ? `${row!.record!.length} byte record stored` : `row: ${JSON.stringify(row ? { status: row.status, valid: row.recordValid } : null)}` })
    return checks
  } finally {
    await client.close().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = s.port!
  await s.stop(true)
  return port
}

async function waitUp(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).status < 500) return true
    } catch {
      // not listening yet
    }
    await Bun.sleep(300)
  }
  return false
}

/** Builds the web app for production, serves .output on a free port with a throwaway in-memory database, and smokes it. */
async function runLocal(): Promise<Check[]> {
  const webDir = join(ROOT, 'apps', 'web')
  console.log('building apps/web (production) ...')
  const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: webDir, stdout: 'pipe', stderr: 'pipe' })
  if (build.exitCode !== 0) return [{ name: 'production build', ok: false, detail: build.stderr.toString().split('\n').slice(-8).join(' | ') }]
  const entry = join(webDir, '.output', 'server', 'index.mjs')
  if (!existsSync(entry)) return [{ name: 'production build', ok: false, detail: `no ${entry}` }]
  const checks: Check[] = [{ name: 'production build', ok: true, detail: 'apps/web/.output' }]

  // Production runs on Neon, so the build does not ship what an embedded PGlite needs (its wasm and data
  // files, and the SQL migrations next to the server bundle). Copy them into the untracked .output so this
  // local run can use a throwaway in-memory PGlite instead of a database.
  const pgliteDist = join(ROOT, 'node_modules', '@electric-sql', 'pglite', 'dist')
  for (const f of ['pglite.data', 'pglite.wasm', 'initdb.wasm']) cpSync(join(pgliteDist, f), join(webDir, '.output', 'server', '_libs', f))
  cpSync(join(webDir, 'drizzle'), join(webDir, '.output', 'drizzle'), { recursive: true })

  const port = await freePort()
  // Built from scratch on purpose: an inherited DATABASE_URL must never reach this server.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    DUELWISE_DB: 'memory',
    BETTER_AUTH_SECRET: 'smoke-test-secret-not-used-anywhere-else-0123456789',
    BETTER_AUTH_URL: `http://localhost:${port}`,
  }
  const node = Bun.which('node') ?? process.execPath
  const server = Bun.spawn([node, entry], { cwd: webDir, env, stdout: 'ignore', stderr: 'pipe' })
  try {
    const base = `http://localhost:${port}`
    if (!(await waitUp(`${base}/`, 45_000))) {
      checks.push({ name: 'server starts', ok: false, detail: `no answer on ${base} within 45 s` })
      return checks
    }
    checks.push({ name: 'server starts', ok: true, detail: base })
    checks.push(...(await runUrlSmoke(base, { allowWrite: true })))
  } finally {
    server.kill()
  }
  checks.push(...(await runHandlerSmoke()))
  return checks
}

function report(checks: Check[]): boolean {
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`)
  const failed = checks.filter((c) => !c.ok)
  console.log(failed.length === 0 ? `\nsmoke: all ${checks.length} checks passed` : `\nsmoke: ${failed.length} of ${checks.length} checks failed`)
  return failed.length === 0
}

if (import.meta.main) {
  try {
    const opts = parseArgs(Bun.argv.slice(2))
    const checks = opts.url ? await runUrlSmoke(opts.url, { allowWrite: opts.allowWrite }) : await runLocal()
    process.exit(report(checks) ? 0 : 1)
  } catch (e) {
    console.error(`smoke: ${errText(e)}`)
    process.exit(2)
  }
}
