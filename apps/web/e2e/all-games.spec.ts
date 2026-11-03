import { visibleRegistry } from '../src/lib/strength-gates'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { PRODUCT, type GameId } from '@duelwise/core/src/product.ts'

// Path of the paid clip file (apps/web/src/games/arena/render/opponent.ts PAID_CLIPS_PATH); keyed on the path so any VITE_PAID_ASSETS_URL base works.
const PAID_CLIPS_PATH = 'arena/quaternius/universal-animation-library/ual1-shooter.glb'

// T41: the all-games smoke (one driver per game). Every game whose page module exists is loaded, played at its lowest published level
// (Easy where it exists) through a short scripted interaction to a finished match, its record checked, and its
// stats page opened. During play nothing may call an inference endpoint (the agent runs in the browser, claim C3),
// and no game with published levels may still serve its preview stub. Games with no page module are listed with
// the registry's reason instead of failing the run.

const ROOT = join(import.meta.dirname, '..', '..', '..')
const WEB_SRC = join(ROOT, 'apps', 'web', 'src')
const REGISTRY_DIR = join(ROOT, 'packages', 'agents', 'registry')
const GAMES = Object.keys(PRODUCT.games) as GameId[]
const LEVELS = ['easy', 'medium', 'hard', 'champion'] as const

interface Registry {
  levels?: Record<string, unknown>
  measured?: Record<string, unknown>
  unpublished?: Record<string, string>
}

function registryOf(game: GameId): Registry | null {
  const p = join(REGISTRY_DIR, `${game}.json`)
  return existsSync(p) ? (visibleRegistry(JSON.parse(readFileSync(p, 'utf8'))) as unknown as Registry) : null
}

/** Levels the registry publishes (a version and a measurement), lowest first. */
function publishedLevels(game: GameId): string[] {
  const reg = registryOf(game)
  return LEVELS.filter((l) => reg?.levels?.[l] && reg?.measured?.[l])
}

/** A game is playable when its page module exists (plan: there is no `enabled` flag). */
function hasPageModule(game: GameId): boolean {
  const dir = join(WEB_SRC, 'games', game)
  return existsSync(join(dir, 'index.tsx'))
}

function missingReason(game: GameId): string {
  const reg = registryOf(game)
  const why = Object.values(reg?.unpublished ?? {})[0]
  return why ?? 'no registry file'
}

const PLAYABLE = GAMES.filter(hasPageModule)
const MISSING = GAMES.filter((g) => !hasPageModule(g))

/** Collects every request the page makes, so a test can assert on where the match traffic went. */
function watchRequests(page: Page) {
  const seen: { method: string; url: URL }[] = []
  page.on('request', (r) => {
    try {
      seen.push({ method: r.method(), url: new URL(r.url()) })
    } catch {
      /* data: and blob: URLs are not network requests */
    }
  })
  return seen
}

/** No inference call: every request stays on this origin and none is shaped like a model or agent endpoint. */
function expectNoInferenceTraffic(seen: { method: string; url: URL }[], origin: string) {
  const outside = seen.filter((s) => s.url.origin !== origin).map((s) => s.url.href)
  expect(outside).toEqual([])
  const inference = seen.filter((s) => /\/(infer|inference|predict|completions|act|move|agent)(\/|$|\?)/i.test(s.url.pathname)).map((s) => `${s.method} ${s.url.pathname}`)
  expect(inference).toEqual([])
  // Writes are the match bookkeeping server functions and the finish and resign routes, nothing else.
  const writes = seen.filter((s) => s.method !== 'GET' && s.method !== 'HEAD' && s.method !== 'OPTIONS')
  for (const w of writes) expect(w.url.pathname).toMatch(/^\/(_serverFn\/|api\/(finish|resign)$)/)
}

/** The reply proof for claim C3: no request may start between the human's move and the turn coming back, so the agent's answer needed no network. */
function expectNoRequestsSince(seen: { method: string; url: URL }[], before: number) {
  // Static assets (move sounds, sprites) are fetched on demand; anything that can run code on a server is not allowed.
  const calls = seen.slice(before).filter((s) => s.method !== 'GET' || /^\/(_serverFn\/|api\/)/.test(s.url.pathname))
  expect(calls.map((s) => `${s.method} ${s.url.pathname}`)).toEqual([])
}

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.location().url.endsWith(PAID_CLIPS_PATH)) errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

async function chooseLevel(page: Page, level: string) {
  await page.getByRole('radio', { name: new RegExp(level, 'i') }).check()
}

async function expectStatsPage(page: Page, game: GameId) {
  await page.goto(`/agents/${PRODUCT.games[game].slug}`)
  await expect(page.getByTestId('agent-detail')).toHaveAttribute('data-game', game)
  await expect(page.getByTestId('tile-version')).toBeVisible()
}

const slug = (game: GameId) => PRODUCT.games[game].slug

test.describe.configure({ mode: 'serial' })

test.describe(`${GAMES.length} games, end to end`, () => {
  test('lists the games without a page module with the registry reason', async () => {
    const lines = MISSING.map((g) => `${g}: ${missingReason(g)}`)
    test.info().annotations.push({ type: 'not-playable', description: lines.length ? lines.join(' | ') : 'none' })
    // Every game's page is expected to exist at the end of the build; a missing one is reported, not silently skipped.
    expect(lines).toEqual([])
    expect(PLAYABLE.sort()).toEqual([...GAMES].sort())
  })

  test('chess: the real Easy agent answers a move, a counted resignation is saved, then its stats page renders', async ({ page, baseURL }) => {
    test.setTimeout(180_000)
    test.skip(!PLAYABLE.includes('chess'), `chess has no page: ${missingReason('chess')}`)
    const seen = watchRequests(page)
    const errors = watchConsole(page)
    await page.goto(`/play/${slug('chess')}`)
    await chooseLevel(page, 'Easy')
    await page.getByRole('button', { name: 'Start match' }).click()
    const board = page.getByTestId('chess-board')
    await expect(board).toBeVisible({ timeout: 90_000 })
    await expect(board).toHaveAttribute('data-turn', 'you')
    // Easy is Practice (the preview badge shows) until the chess publisher verifies it.
    await expect(page.getByTestId('preview-badge')).toHaveCount(publishedLevels('chess').includes('easy') ? 0 : 1)
    await page.getByTestId('sq-e2').click()
    const before = seen.length
    await page.getByTestId('sq-e4').click()
    // Two plies means the measured agent (in the browser) replied; a resignation has no replayable record, so the
    // saved-match line is the proof that the server took it. Replayed records are covered by chess.spec.ts.
    await expect(board).toHaveAttribute('data-plies', '2', { timeout: 60_000 })
    await expect(board).toHaveAttribute('data-turn', 'you')
    expectNoRequestsSince(seen, before)
    await page.getByRole('button', { name: 'Resign' }).click()
    await page.getByRole('button', { name: 'Yes, resign' }).click()
    await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss')
    await expect(page.getByTestId('result-upload')).toContainText('Saved')
    expectNoInferenceTraffic(seen, new URL(baseURL!).origin)
    expect(errors).toEqual([])
    await expectStatsPage(page, 'chess')
  })

  test('four: a full counted match is saved with a valid record, then its stats page renders', async ({ page, baseURL }) => {
    test.setTimeout(180_000)
    test.skip(!PLAYABLE.includes('four'), `four has no page: ${missingReason('four')}`)
    const seen = watchRequests(page)
    const errors = watchConsole(page)
    await page.goto(`/play/${slug('four')}`)
    await chooseLevel(page, 'Easy')
    await page.getByRole('button', { name: 'Start match' }).click()
    const board = page.getByTestId('four-board')
    await expect(board).toBeVisible()
    await expect(page.getByTestId('preview-badge')).toHaveCount(0)
    for (let i = 0; i < 44; i++) {
      if (await page.getByTestId('result-panel').isVisible()) break
      await expect(board).toHaveAttribute('data-turn', /you|over/)
      await expect(board).not.toHaveAttribute('data-settling', 'true')
      if (await page.getByTestId('result-panel').isVisible()) break
      const col = await page.locator('[data-testid^="col-"]:not([aria-disabled="true"])').first().getAttribute('data-testid')
      const before = seen.length
      await page.getByTestId(col!).click()
      await expect(board).toHaveAttribute('data-turn', /you|over/)
      await expect(board).not.toHaveAttribute('data-settling', 'true')
      // A finished match legitimately saves; every earlier move and reply must stay off the network.
      if (!(await page.getByTestId('result-panel').isVisible())) expectNoRequestsSince(seen, before)
    }
    await expect(page.getByTestId('result-panel')).toBeVisible()
    await expect(page.getByTestId('four-record')).toHaveAttribute('data-record-ok', 'true')
    await expect(page.getByTestId('result-upload')).toContainText('Saved')
    expectNoInferenceTraffic(seen, new URL(baseURL!).origin)
    expect(errors).toEqual([])
    await expectStatsPage(page, 'four')
  })

  test("holdem: a counted match conceded after the first deal is a loss with a valid, saved record, then its stats page renders", async ({ page, baseURL }) => {
    test.setTimeout(120_000)
    test.skip(!PLAYABLE.includes('holdem'), `holdem has no page: ${missingReason('holdem')}`)
    const seen = watchRequests(page)
    const errors = watchConsole(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(`/play/${slug('holdem')}`)
    await chooseLevel(page, 'Easy')
    await page.getByRole('button', { name: 'Start match' }).click()
    const table = page.getByTestId('holdem-table')
    await expect(table).toBeVisible()
    await expect(page.getByTestId('preview-badge')).toHaveCount(publishedLevels('holdem').includes('easy') ? 0 : 1)
    await expect(table).toHaveAttribute('data-turn', /you|over/, { timeout: 30_000 })
    await page.getByRole('button', { name: 'Concede' }).click()
    await page.getByRole('button', { name: 'Yes, concede' }).click()
    await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss')
    await expect(page.getByTestId('holdem-record')).toHaveAttribute('data-record-ok', 'true')
    await expect(page.getByTestId('result-upload')).toContainText('Saved')
    expectNoInferenceTraffic(seen, new URL(baseURL!).origin)
    expect(errors).toEqual([])
    await expectStatsPage(page, 'holdem')
  })

  test('word: a full counted match is saved with a valid record, then its stats page renders', async ({ page, baseURL }) => {
    test.setTimeout(120_000)
    test.skip(!PLAYABLE.includes('word'), `word has no page: ${missingReason('word')}`)
    const seen = watchRequests(page)
    const errors = watchConsole(page)
    await page.goto(`/play/${slug('word')}`)
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(page.getByTestId('word-input')).toBeVisible()
    await expect(page.getByTestId('preview-badge')).toHaveCount(0)
    for (const w of ['crane', 'slate', 'house', 'about', 'other', 'these', 'light', 'might']) {
      await expect(page.locator('[data-testid="word-input"]:enabled, [data-testid="result-panel"]')).toBeVisible()
      if (await page.getByTestId('result-panel').isVisible()) break
      await page.getByTestId('word-input').fill(w)
      await page.getByTestId('word-input').press('Enter')
    }
    await expect(page.getByTestId('result-panel')).toBeVisible()
    await expect(page.getByTestId('word-record')).toHaveAttribute('data-record-ok', 'true')
    await expect(page.getByTestId('result-upload')).toContainText('Saved')
    expectNoInferenceTraffic(seen, new URL(baseURL!).origin)
    expect(errors).toEqual([])
    await expectStatsPage(page, 'word')
  })

  test('fleet: a full counted match is played shot by shot to a sealed, saved result, then its stats page renders', async ({ page, baseURL }) => {
    test.setTimeout(180_000)
    test.skip(!PLAYABLE.includes('fleet'), `fleet has no page: ${missingReason('fleet')}`)
    const seen = watchRequests(page)
    const errors = watchConsole(page)
    await page.goto(`/play/${slug('fleet')}?hold=0`)
    await page.getByTestId('fleet-ready').click()
    const root = page.getByTestId('fleet-page')
    await expect(root).toHaveAttribute('data-phase', 'play')
    await expect(root).toHaveAttribute('data-counted', 'true')
    for (let i = 0; i < 100; i++) {
      await expect(root).toHaveAttribute('data-turn', /you|over/)
      if ((await root.getAttribute('data-turn')) === 'over') break
      const cell = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').first()
      const id = (await cell.getAttribute('data-testid'))!
      await cell.click()
      await cell.click()
      await expect(page.getByTestId(id)).not.toHaveAttribute('data-state', 'open')
    }
    await expect(page.getByTestId('result-panel')).toBeVisible()
    await expect(page.getByTestId('result-upload')).toContainText('Saved')
    await expect(page.getByTestId('preview-badge')).toHaveCount(publishedLevels('fleet').includes('easy') ? 0 : 1)
    expectNoInferenceTraffic(seen, new URL(baseURL!).origin)
    expect(errors).toEqual([])
    await expectStatsPage(page, 'fleet')
  })

  test('slack: a full match is played to the end on the real page, its record is valid and saved, then its stats page renders', async ({ page, baseURL }) => {
    test.setTimeout(240_000)
    test.skip(!PLAYABLE.includes('slack'), `slack has no page: ${missingReason('slack')}`)
    const seen = watchRequests(page)
    const errors = watchConsole(page)
    // No ?seed: a fixed test seed is never counted.
    await page.goto(`/play/${slug('slack')}`)
    await chooseLevel(page, 'Easy')
    await page.getByRole('button', { name: 'Start match' }).click()
    const hud = page.getByTestId('play-hud')
    await expect(page.getByTestId('slack-board')).toBeVisible()
    await expect(page.getByTestId('preview-badge')).toHaveCount(publishedLevels('slack').includes('easy') ? 0 : 1)
    for (let i = 0; i < 200; i++) {
      if (await page.getByTestId('result-panel').isVisible()) break
      const turn = await hud.getAttribute('data-turn')
      const cell = page.locator('[data-testid^="slack-cell-"][data-legal]').first()
      if (turn === 'you' && (await cell.count()) > 0) {
        await cell.click()
        await cell.click()
      }
      await page.waitForTimeout(120)
    }
    await expect(page.getByTestId('result-panel')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('slack-record')).toHaveAttribute('data-record-ok', 'true')
    // A Rated match is checked by the server: once counted the panel shows the rating line (a signed-in or guest rating) or the saved line.
    await expect(page.getByTestId('result-elo').or(page.getByTestId('result-upload').filter({ hasText: 'Saved' }))).toBeVisible({ timeout: 30_000 })
    expectNoInferenceTraffic(seen, new URL(baseURL!).origin)
    expect(errors).toEqual([])
    await expectStatsPage(page, 'slack')
  })

  test('fighter: a fast-forwarded match at the lowest published level finishes with a valid record, then its stats page renders', async ({ page, baseURL }) => {
    test.setTimeout(300_000)
    test.skip(!PLAYABLE.includes('fighter'), `fighter has no page: ${missingReason('fighter')}`)
    const level = publishedLevels('fighter')[0]
    test.skip(!level, `fighter has no published level: ${missingReason('fighter')}`)
    const seen = watchRequests(page)
    const errors = watchConsole(page)
    await page.goto(`/play/${slug('fighter')}?seed=13&speed=12&level=${level}`)
    await page.getByRole('button', { name: 'Choose your fighter' }).click()
    await page.getByRole('button', { name: 'Start match' }).click()
    const stage = page.getByTestId('fighter-stage')
    await expect(stage).toHaveAttribute('data-phase', 'playing', { timeout: 60_000 })
    await expect(page.getByTestId('preview-badge')).toHaveCount(0)
    await expect(page.getByTestId('result-panel')).toBeVisible({ timeout: 220_000 })
    await expect(stage).toHaveAttribute('data-record-ok', 'true')
    expectNoInferenceTraffic(seen, new URL(baseURL!).origin)
    expect(errors).toEqual([])
    await expectStatsPage(page, 'fighter')
  })

  test('arena: a fast-forwarded match at the lowest published level finishes with a valid record, then its stats page renders', async ({ page, baseURL }) => {
    test.setTimeout(320_000)
    test.skip(!PLAYABLE.includes('arena'), `arena has no page: ${missingReason('arena')}`)
    const level = publishedLevels('arena')[0]
    test.skip(!level, `arena has no published level: ${missingReason('arena')}`)
    const seen = watchRequests(page)
    const errors = watchConsole(page)
    await page.goto(`/play/${slug('arena')}?seed=26&speed=20&renderer=debug&level=${level}`)
    await page.getByRole('button', { name: 'Start match' }).click()
    const stage = page.getByTestId('arena-stage')
    await expect(stage).toHaveAttribute('data-phase', 'playing', { timeout: 60_000 })
    await expect(page.getByTestId('preview-badge')).toHaveCount(0)
    await expect(page.getByTestId('result-panel')).toBeVisible({ timeout: 260_000 })
    await expect(stage).toHaveAttribute('data-record-ok', 'true')
    expectNoInferenceTraffic(seen, new URL(baseURL!).origin)
    expect(errors).toEqual([])
    await expectStatsPage(page, 'arena')
  })
})

test.describe('merge integrity', () => {
  test('no game with published levels still serves its preview stub', () => {
    for (const game of GAMES) {
      if (publishedLevels(game).length === 0) continue
      const src = readFileSync(join(ROOT, 'packages', 'agents', 'src', game, 'agent.ts'), 'utf8')
      // The factory may fall back to the stub when a model file is missing, but it must build a real agent first.
      expect(src, `${game}/agent.ts must build a real agent`).toMatch(/preview:\s*(false|!)/)
      expect(src.trim(), `${game}/agent.ts is still the bare stub`).not.toBe(`export { createStubAgent as createGameAgent } from '../stub-agent'`)
    }
  })

  test('no route files outside the set Lane B owns', () => {
    const LANE_B_ROUTES = [
      '__root.tsx',
      'agents/$game.tsx',
      'ai.tsx',
      'api/auth/$.ts',
      'api/finish.ts',
      'api/ping.ts',
      'c/$game.$level.tsx',
      'api/resign.ts',
      'dev/$view.tsx',
      'index.tsx',
      'leaderboard/$game.tsx',
      'leaderboard/index.tsx',
      'owner.tsx',
      'play/$game.tsx',
      'play/index.tsx',
      'privacy.tsx',
      'report-card.$id.tsx',
      'report.$id.tsx',
      'settings.tsx',
      'signin.tsx',
      'terms.tsx',
    ]
    const dir = join(WEB_SRC, 'routes')
    const found: string[] = []
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        if (statSync(p).isDirectory()) walk(p)
        else found.push(relative(dir, p).split('\\').join('/'))
      }
    }
    walk(dir)
    expect(found.sort()).toEqual([...LANE_B_ROUTES].sort())
  })

  test('bun.lock changed since Lane 0 only for the approved resvg install', () => {
    let log: string
    try {
      log = execFileSync('git', ['log', '--format=%h %s', 'lane-0..HEAD', '--', 'bun.lock'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    } catch {
      test.skip(true, 'the lane-0 tag is not in this checkout')
      return
    }
    const lines = log ? log.split('\n') : []
    // JB5 installed resvg-wasm 2.6.2, approved in the plan (JB5 files list bun.lock). Anything else is a drift.
    expect(lines.filter((l) => !/task JB5: .*resvg/.test(l))).toEqual([])
  })
})
