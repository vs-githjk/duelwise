import { expect, test, type Page } from '@playwright/test'

/**
 * The installable offline app, against the production build (the service worker is registered only there).
 * Run: PORT=<free port> bunx playwright test -c playwright.prod.config.ts e2e-prod/pwa-offline.spec.ts --workers=1
 *
 * Flow: open the site online so the worker installs and the models are cached, go offline, reload Four in a Row and Tinderbox,
 * play a whole Four in a Row match offline (it is unrated: no game issues offline tickets), go back online, and see that nothing was queued
 * and no match call was sent.
 */
const FOUR = '/play/four-in-a-row'
const TINDERBOX = '/play/tinderbox'

// The prod config sends the x-dw-test marker, so this run is tagged as test traffic.
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

test('installs, plays Four in a Row offline from the cache, unrated, and nothing is sent', async ({ page, context }) => {
  test.setTimeout(240_000)
  await context.addInitScript(() => {
    for (const g of ['chess', 'four', 'holdem', 'word', 'fighter', 'arena', 'fleet', 'slack']) localStorage.setItem(`duelwise.how-to-play.${g}`, 'seen')
  })

  // 1. Online: the worker installs and takes over the page.
  await boardCount(page)
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 60_000 }).toBe(true)
  // Install finishes only when every required file and every model is in the cache.
  expect(await page.evaluate(async () => !!(await caches.match('/agents/four/v1/easy.onnx')))).toBe(true)
  expect(await page.evaluate(async () => !!(await caches.match('/play/tinderbox')))).toBe(true)

  // 2. Online: opening the games issues no offline tickets (offline matches are unrated in every game).
  await page.goto(FOUR)
  await expect(page.getByTestId('four-setup')).toBeVisible()
  await page.waitForTimeout(3000)
  expect(await tickets(page, 'four', 'easy')).toBe(0)
  await page.goto(TINDERBOX)
  await expect(page.getByTestId('prematch').or(page.getByTestId('select'))).toBeVisible()

  // 3. Offline: both games reload from the cache and the chip says so.
  await context.setOffline(true)
  await page.goto(TINDERBOX)
  await expect(page.getByTestId('prematch').or(page.getByTestId('select'))).toBeVisible()
  await expect(page.getByTestId('offline-chip')).toHaveText('Offline: new matches are not rated')
  await page.goto(FOUR)
  await page.reload()
  await expect(page.getByTestId('four-setup')).toBeVisible()
  await expect(page.getByTestId('error-fallback')).toHaveCount(0)

  // Pages that need the server say so in plain words instead of an error.
  await page.goto('/leaderboard/four-in-a-row')
  await expect(page.getByText('You are offline').first()).toBeVisible()
  await page.goto(FOUR)
  await expect(page.getByTestId('four-setup')).toBeVisible()

  // 4. Offline: a whole match plays from the cache. It is unrated, says why, and nothing is queued or sent. From here to the end, the browser must not send
  // a match to the server. The calls are server function POSTs to /_serverFn/<id> (the ids are opaque, so the body tells them apart; match-recorder.ts serverApi,
  // tickets.ts serverTicketApi):
  //   start      JSON { game, level, ... } with no count field
  //   finish     multipart/form-data carrying the gzipped record (a Blob part named "record")
  //   tickets    JSON { game, level, count } with count above 0
  // The viewer probe (JSON { game: 'four', level: 'easy', count: 0 }) runs on every return to online to learn who is signed in and issues nothing, so it is allowed.
  const sent: string[] = []
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !r.url().includes('/_serverFn')) return
    if ((r.headers()['content-type'] ?? '').includes('multipart/form-data')) return void sent.push(`finish ${r.url()}`)
    let body: unknown = null
    try { body = JSON.parse(r.postData() ?? '') } catch { return }
    const data = (body as { data?: { game?: unknown; count?: unknown } } | null)?.data ?? (body as { game?: unknown; count?: unknown } | null)
    if (!data || data.game !== 'four') return
    if (data.count === undefined) sent.push(`start ${r.url()}`)
    else if (typeof data.count === 'number' && data.count > 0) sent.push(`tickets ${r.url()}`)
  })
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId('four-board')).toBeVisible()
  await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', 'you')
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
  await expect(page.getByTestId('result-unrated')).toContainText('not counted')
  expect(await queued(page)).toBe(0)

  // 5. Online again: the chip goes away by itself and still nothing is queued.
  await context.setOffline(false)
  // The chip checks the server every 4 s while offline, so allow a few rounds on a busy machine.
  await expect(page.getByTestId('offline-chip')).toHaveCount(0, { timeout: 40_000 })
  expect(await queued(page)).toBe(0)

  // 6. The offline match counted nowhere: the browser never sent a Four in a Row start, finish or ticket call, and the landing strip still shows.
  await page.waitForTimeout(5000)
  expect(sent, 'match start, finish or ticket calls for Four in a Row').toEqual([])
  await boardCount(page)
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
