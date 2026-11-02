import { expect, test, type Page } from '@playwright/test'

/**
 * The installable offline app, against the production build (the service worker is registered only there).
 * Run: PORT=<free port> bunx playwright test -c playwright.prod.config.ts e2e-prod/pwa-offline.spec.ts --workers=1
 *
 * Flow: open the site online so the worker installs and tickets are issued, go offline, reload Four in a Row and Tinderbox,
 * play a whole Four in a Row match offline, go back online, watch the upload queue drain, and see the match count rise.
 */
const FOUR = '/play/four-in-a-row'
const TINDERBOX = '/play/tinderbox'

test.use({ serviceWorkers: 'allow' })

async function queued(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('duelwise-offline')
        open.onerror = () => resolve(0)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('uploads')) return resolve(0)
          const req = db.transaction('uploads').objectStore('uploads').count()
          req.onsuccess = () => { db.close(); resolve(req.result) }
          req.onerror = () => resolve(0)
        }
      }),
  )
}

async function tickets(page: Page, game: string, level: string): Promise<number> {
  return page.evaluate(
    ([g, l]) =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('duelwise-offline')
        open.onerror = () => resolve(0)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('tickets')) return resolve(0)
          const req = db.transaction('tickets').objectStore('tickets').getAll()
          req.onsuccess = () => { db.close(); resolve((req.result as Array<{ game: string; level: string }>).filter((t) => t.game === g && t.level === l).length) }
          req.onerror = () => resolve(0)
        }
      }),
    [game, level],
  )
}

async function boardCount(page: Page): Promise<number> {
  await page.goto('/')
  // The landing strip shows this week's human wins and agent wins or draws (or "Opening week" before the first match); their sum is the matches counted.
  await expect(page.getByTestId('landing-strip')).toBeVisible()
  const texts = await page.getByTestId('strip-count').allTextContents()
  return texts.reduce((sum, t) => sum + (Number(t.replaceAll(',', '')) || 0), 0)
}

test('installs, plays Four in a Row offline on a ticket, and the match counts once back online', async ({ page, context }) => {
  test.setTimeout(240_000)
  await context.addInitScript(() => {
    for (const g of ['chess', 'four', 'holdem', 'word', 'fighter', 'arena', 'fleet']) localStorage.setItem(`duelwise.how-to-play.${g}`, 'seen')
  })

  // 1. Online: the worker installs and takes over the page.
  const before = await boardCount(page)
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 60_000 }).toBe(true)
  // Install finishes only when every required file and every model is in the cache.
  expect(await page.evaluate(async () => !!(await caches.match('/agents/four/v1/easy.onnx')))).toBe(true)
  expect(await page.evaluate(async () => !!(await caches.match('/play/tinderbox')))).toBe(true)

  // 2. Online: opening the games fills the offline ticket pool (two per level for a level never played).
  await page.goto(FOUR)
  await expect(page.getByTestId('four-setup')).toBeVisible()
  await expect.poll(() => tickets(page, 'four', 'easy'), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
  await page.goto(TINDERBOX)
  await expect(page.getByTestId('prematch').or(page.getByTestId('select'))).toBeVisible()

  // 3. Offline: both games reload from the cache and the chip says so.
  await context.setOffline(true)
  await page.goto(TINDERBOX)
  await expect(page.getByTestId('prematch').or(page.getByTestId('select'))).toBeVisible()
  await expect(page.getByTestId('offline-chip')).toHaveText('Offline: matches will sync later')
  await page.goto(FOUR)
  await page.reload()
  await expect(page.getByTestId('four-setup')).toBeVisible()
  await expect(page.getByTestId('error-fallback')).toHaveCount(0)

  // Pages that need the server say so in plain words instead of an error.
  await page.goto('/leaderboard/four-in-a-row')
  await expect(page.getByText('You are offline').first()).toBeVisible()
  await page.goto(FOUR)
  await expect(page.getByTestId('four-setup')).toBeVisible()

  // 4. Offline: a whole counted-on-sync match, on a ticket.
  const startUsed = await tickets(page, 'four', 'easy')
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId('four-board')).toBeVisible()
  await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', 'you')
  expect(await tickets(page, 'four', 'easy')).toBe(startUsed - 1)
  for (let i = 0; i < 44; i++) {
    if (await page.getByTestId('result-panel').isVisible()) break
    await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', /you|over/)
    await expect(page.getByTestId('four-board')).not.toHaveAttribute('data-settling', 'true')
    if (await page.getByTestId('result-panel').isVisible()) break
    const col = await page.locator('[data-testid^="col-"]:not([aria-disabled="true"])').first().getAttribute('data-testid')
    await page.getByTestId(col!).click()
    await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', /you|over/)
  }
  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('four-record')).toHaveAttribute('data-record-ok', 'true')
  await expect(page.getByTestId('result-upload')).toContainText('Saved on this device')
  await expect(page.getByTestId('result-unrated')).toHaveCount(0)
  await expect.poll(() => queued(page)).toBe(1)

  // 5. Online again: the queue drains by itself and the page says the match now counts.
  await context.setOffline(false)
  // The chip checks the server every 4 s while offline, so allow a few rounds on a busy machine.
  await expect(page.getByTestId('offline-chip')).toHaveCount(0, { timeout: 40_000 })
  await expect.poll(() => queued(page), { timeout: 60_000 }).toBe(0)
  await expect(page.getByTestId('result-upload')).toContainText('now counts', { timeout: 30_000 })
  await expect(page.getByTestId('result-report-link')).toBeVisible()

  // 6. The server counted it: the public match count went up by one (the server check finishes a few seconds after the answer).
  await expect.poll(() => boardCount(page), { timeout: 90_000, intervals: [2000, 3000, 5000] }).toBe(before + 1)
})

test('an update is offered, never forced, and the worker is absent from dev', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  const worker = await page.request.get('/sw.js')
  expect(worker.status()).toBe(200)
  expect(worker.headers()['cache-control']).toContain('no-cache')
  expect(await worker.text()).toContain('SKIP_WAITING')
  await expect(page.getByTestId('update-prompt')).toHaveCount(0)
})
