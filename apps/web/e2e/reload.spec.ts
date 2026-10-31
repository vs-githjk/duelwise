import { expect, test, type Page, type Route } from '@playwright/test'
import { PRODUCT } from '@duelwise/core/src/product.ts'

/**
 * Reloading in the middle of a match, for all six games, and a page that was opened before a new deploy.
 * Bug report: "my friend reloaded the app in the middle of a game and it just died". A reload must always come back to a clean,
 * working setup screen (the unfinished counted match is given up by the page-hide beacon), and a script that a deploy removed must
 * end in one fresh load, never a dead page.
 */

type Key = keyof typeof PRODUCT.games
interface Game {
  key: Key
  inMatch: (page: Page) => ReturnType<Page['locator']>
  /** Real-time games keep their stage on screen at setup; the phase tells setup from play. */
  phased?: boolean
  /** A few inputs a player would make. */
  play: (page: Page) => Promise<void>
}

const GAMES: Game[] = [
  { key: 'chess', inMatch: (p) => p.getByTestId('chess-board'), play: async (p) => { await p.getByTestId('chess-board').click({ position: { x: 40, y: 40 }, force: true }) } },
  { key: 'four', inMatch: (p) => p.getByTestId('four-board'), play: async (p) => { await p.getByTestId('col-3').click() } },
  { key: 'holdem', inMatch: (p) => p.getByTestId('holdem-table'), play: async (p) => { await p.keyboard.press('Tab') } },
  { key: 'word', inMatch: (p) => p.getByTestId('word-input'), play: async (p) => { await p.getByTestId('word-input').fill('crane'); await p.getByTestId('word-input').press('Enter') } },
  { key: 'fighter', phased: true, inMatch: (p) => p.getByTestId('fighter-stage'), play: async (p) => { for (const k of ['ArrowRight', 'KeyJ', 'ArrowLeft']) { await p.keyboard.down(k); await p.waitForTimeout(150); await p.keyboard.up(k) } } },
  { key: 'arena', phased: true, inMatch: (p) => p.getByTestId('arena-stage'), play: async (p) => { for (const k of ['KeyW', 'KeyD', 'Space']) { await p.keyboard.down(k); await p.waitForTimeout(150); await p.keyboard.up(k) } } },
]

function watch(page: Page): string[] {
  const problems: string[] = []
  // Not a page fault: a reload cancels requests, and the dev server reports a cancelled request ("aborted") to every open page (see vite.config.ts).
  const benign = /Failed to load resource|\[vite\] Internal Server Error[\s\S]*aborted/
  page.on('console', (m) => { if (m.type() === 'error' && !benign.test(m.text())) problems.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  return problems
}

async function startMatch(page: Page) {
  await page.getByRole('button', { name: /^(Start match|Choose your fighter)/ }).first().waitFor()
  const fighter = page.getByRole('button', { name: 'Choose your fighter' })
  if (await fighter.count()) await fighter.click()
  await page.getByRole('button', { name: /^Start match/ }).click()
}

/** The setup screen is back: the page title is there and the start button is usable. */
async function expectCleanSetup(page: Page, g: Game) {
  await expect(page.getByTestId('error-fallback')).toHaveCount(0)
  await expect(page.getByTestId('new-version-fallback')).toHaveCount(0)
  await expect(page.getByTestId('offline-state')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Start match|Choose your fighter)/ }).first()).toBeEnabled({ timeout: 20_000 })
  if (g.phased) await expect(g.inMatch(page)).not.toHaveAttribute('data-phase', 'playing')
  else await expect(g.inMatch(page)).toHaveCount(0)
}

async function expectPlaying(page: Page, g: Game) {
  await expect(g.inMatch(page)).toBeVisible({ timeout: 60_000 })
  if (g.phased) await expect(g.inMatch(page)).toHaveAttribute('data-phase', 'playing', { timeout: 60_000 })
}

for (const g of GAMES) {
  const slug = PRODUCT.games[g.key].slug
  test.describe(`reload mid-match: ${g.key}`, () => {
    test('comes back to a clean setup screen, twice, and a new match can be started after it', async ({ page }) => {
      test.setTimeout(180_000)
      const problems = watch(page)
      await page.goto(`/play/${slug}`)
      await startMatch(page)
      await expectPlaying(page, g)
      await g.play(page)

      await page.reload()
      await expectCleanSetup(page, g)
      await page.reload()
      await expectCleanSetup(page, g)

      // Leaving to the game list and coming back is clean too.
      await page.goto('/play')
      await expect(page.getByRole('heading', { name: 'Pick a game' })).toBeVisible()
      await page.goBack()
      await expectCleanSetup(page, g)

      // The unfinished match left nothing behind that blocks a new one.
      await startMatch(page)
      await expectPlaying(page, g)
      expect(problems).toEqual([])
    })

    test('a reload while the opponent is still loading is clean too', async ({ page }) => {
      test.setTimeout(120_000)
      const problems = watch(page)
      await page.goto(`/play/${slug}`)
      await startMatch(page)
      await page.reload()
      await expectCleanSetup(page, g)
      expect(problems).toEqual([])
    })
  })
}

test.describe('a page opened before a new deploy', () => {
  const slug = PRODUCT.games.chess.slug
  // In dev the game's code is served as /src/games/chess/index.tsx; a deploy that removed it answers 404 with an HTML page.
  const GONE = /\/src\/games\/chess\/index\.tsx/
  const gone = (route: Route) => route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><title>Not found</title>' })
  const countLoads = (page: Page) => {
    const n = { loads: 0 }
    page.on('load', () => { n.loads++ })
    return n
  }

  test('a missing script ends in one fresh load and the game opens', async ({ page }) => {
    // The import and the page's own check of the file both get the 404; the fresh load finds the file again.
    let served404 = 0
    await page.route(GONE, async (route) => {
      if (served404 < 2) { served404++; return gone(route) }
      return route.continue()
    })
    const n = countLoads(page)
    await page.goto(`/play/${slug}`)
    await expect(page.getByRole('button', { name: /^Start match/ })).toBeEnabled({ timeout: 30_000 })
    expect(served404).toBe(2)
    expect(n.loads).toBe(2)
    await expect(page.getByTestId('error-fallback')).toHaveCount(0)
  })

  test('a script that stays missing shows a friendly update screen and reloads only once, never in a loop', async ({ page }) => {
    await page.route(GONE, gone)
    const n = countLoads(page)
    await page.goto(`/play/${slug}`)
    await expect(page.getByTestId('new-version-fallback')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Duelwise just updated' })).toBeVisible()
    await page.waitForTimeout(3000)
    expect(n.loads).toBe(2)
    // The button asks for another fresh load, and when the script is back the game opens.
    await page.unroute(GONE)
    await page.getByRole('button', { name: 'Reload' }).click()
    await expect(page.getByRole('button', { name: /^Start match/ })).toBeEnabled({ timeout: 30_000 })
  })

  test('offline (the network refuses the script and the check of it): no reload, the offline message, every cache kept', async ({ page }) => {
    await page.addInitScript(() => {
      void caches.open('duelwise-pages-keepme').then((c) => c.put('/kept', new Response('kept')))
    })
    await page.route(GONE, (route) => route.abort('failed'))
    const n = countLoads(page)
    await page.goto(`/play/${slug}`)
    await expect(page.getByTestId('offline-state')).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(2000)
    expect(n.loads).toBe(1)
    expect(await page.evaluate(() => caches.keys())).toContain('duelwise-pages-keepme')
    await expect(page.getByTestId('new-version-fallback')).toHaveCount(0)
  })

  test('storage blocked (Safari private mode): no automatic reload, the update screen with its Reload button', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('blocked', 'SecurityError') } })
    })
    await page.route(GONE, gone)
    const n = countLoads(page)
    await page.goto(`/play/${slug}`)
    await expect(page.getByTestId('new-version-fallback')).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(2500)
    expect(n.loads).toBe(1)
    await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible()
  })

  test('a bug inside a script that did load goes to the error screen, with no reload', async ({ page }) => {
    await page.route(GONE, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'throw new ReferenceError("boom is not defined")' }))
    const n = countLoads(page)
    await page.goto(`/play/${slug}`)
    await expect(page.getByTestId('error-fallback')).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(2000)
    expect(n.loads).toBe(1)
    await expect(page.getByTestId('new-version-fallback')).toHaveCount(0)
  })

  test('a new deploy found in the middle of a match is announced, not applied: no reload until the match ends', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto('/play/four-in-a-row')
    await startMatch(page)
    await expect(page.getByTestId('four-board')).toBeVisible({ timeout: 60_000 })
    const n = countLoads(page)
    await page.route(/\/assets\/gone-chunk\.js/, gone)
    // What a failed import of a removed chunk looks like to the page.
    await page.evaluate(() => { void Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${location.origin}/assets/gone-chunk.js`)) })
    await expect(page.getByTestId('update-ready-notice')).toContainText('Reload after this match')
    await page.waitForTimeout(2500)
    expect(n.loads).toBe(0)
    await expect(page.getByTestId('four-board')).toBeVisible()
    // The match ends (resign): now the update loads, once.
    await page.getByRole('button', { name: 'Resign' }).click()
    await page.getByRole('button', { name: 'Yes, resign' }).click()
    await expect.poll(() => n.loads, { timeout: 30_000 }).toBe(1)
    await expect(page.getByRole('button', { name: /^Start match/ })).toBeEnabled({ timeout: 30_000 })
  })
})
