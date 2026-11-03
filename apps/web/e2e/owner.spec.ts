import { mkdirSync } from 'node:fs'
import { expect, test, type Browser, type Page } from '@playwright/test'

// playwright.config.ts sets OWNER_EMAILS to the dev-login email of "eowner".
const OWNER_NAME = 'eowner'
const OWNER_EMAIL = 'eowner@dev.invalid'

async function signedIn(browser: Browser, baseURL: string, name: string, opts: { width?: number; dark?: boolean; timezoneId?: string } = {}) {
  const context = await browser.newContext({ baseURL, ...(opts.timezoneId ? { timezoneId: opts.timezoneId } : {}), viewport: { width: opts.width ?? 1280, height: 900 }, colorScheme: opts.dark ? 'dark' : 'light' })
  const page = await context.newPage()
  await page.goto('/signin')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Dev sign in' }).click()
  await expect(page).toHaveURL(/\/play$/)
  await expect(page.getByTestId('user-menu')).toContainText(name)
  return { context, page }
}

/** Starts a counted Four in a Row match against Easy and resigns it: one started and one resigned event. */
async function playAndResign(page: Page) {
  await page.goto('/play/four-in-a-row')
  await page.waitForLoadState('networkidle')
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', 'you')
  await page.getByRole('button', { name: 'Resign' }).click()
  await page.getByRole('button', { name: 'Yes, resign' }).click()
  await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss')
}

test.describe('owner dashboard', () => {
  test('anyone but the owner gets the not-found page, signed in or not', async ({ browser, baseURL }) => {
    const anon = await browser.newContext({ baseURL: baseURL! })
    const a = await anon.newPage()
    const r1 = await a.goto('/owner')
    expect(r1!.status()).toBe(404)
    await expect(a.getByTestId('not-found')).toBeVisible()
    await expect(a.getByTestId('owner-page')).toHaveCount(0)
    await anon.close()

    const { context, page } = await signedIn(browser, baseURL!, 'e2e-plain-player')
    const r2 = await page.goto('/owner')
    expect(r2!.status()).toBe(404)
    await expect(page.getByTestId('not-found')).toBeVisible()
    await expect(page.getByTestId('owner-page')).toHaveCount(0)
    await context.close()
  })

  test('times and days follow the browser time zone, named in plain words, with no UTC wording', async ({ browser, baseURL }) => {
    const { context, page } = await signedIn(browser, baseURL!, OWNER_NAME, { timezoneId: 'Asia/Kolkata' })
    const res = await page.goto('/owner?who=all')
    expect(res!.status()).toBe(200)
    await expect(page.getByTestId('owner-page')).toBeVisible()
    await expect(page.getByTestId('owner-zone')).toHaveText(/^Times are India Standard Time \(/)
    await expect(page.getByTestId('owner-active')).toContainText('India Standard Time')
    await expect(page.getByTestId('owner-page')).not.toContainText('UTC')
    await context.close()
  })

  test('the owner sees seeded matches, ids by default, a logged email reveal and a CSV of ids', async ({ browser, baseURL }) => {
    const other = await signedIn(browser, baseURL!, 'e2e-seed-player')
    await playAndResign(other.page)
    await other.context.close()

    const { context, page } = await signedIn(browser, baseURL!, OWNER_NAME)
    await playAndResign(page)

    // The e2e runs send the test marker and the owner plays as the owner, so the panels are looked at with every class shown.
    const res = await page.goto('/owner?who=all')
    expect(res!.status()).toBe(200)
    await expect(page.getByTestId('owner-page')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Observability' })).toBeVisible()
    // Panels from the design.
    for (const id of ['owner-kpis', 'owner-drift', 'owner-wins', 'owner-per-game', 'owner-length', 'owner-devices', 'owner-recent', 'owner-who']) {
      await expect(page.getByTestId(id)).toBeVisible()
    }
    await expect(page.getByTestId('drift-easy')).toBeVisible()
    const matchParts = (await page.getByTestId('kpi-matches-parts').textContent()) ?? ''
    expect(Number(/Total (\d+)/.exec(matchParts)![1])).toBeGreaterThanOrEqual(2)
    expect(Number(/Owner (\d+)/.exec(matchParts)![1])).toBeGreaterThanOrEqual(1)
    expect(Number(/Test (\d+)/.exec(matchParts)![1])).toBeGreaterThanOrEqual(1)
    await expect(page.getByTestId('owner-empty')).toHaveCount(0)

    const rows = page.getByTestId('recent-row')
    expect(await rows.count()).toBeGreaterThanOrEqual(2)
    await expect(rows.first()).toHaveAttribute('data-result', 'Resigned')
    await expect(rows.first().getByRole('link', { name: 'Report' })).toHaveAttribute('href', /^\/report\/.+/)
    await expect(page.getByTestId('bar-four')).toBeVisible()
    await expect(page.getByTestId('owner-device-list')).toContainText('Desktop')

    // Ids only until the owner confirms a reveal.
    const recent = page.getByTestId('owner-recent')
    await expect(recent).not.toContainText('@')
    await expect(page.getByTestId('owner-who')).not.toContainText('@')
    await expect(recent.getByTestId('player-id').first()).toHaveText(/pl_[0-9a-f]{6}/)

    const toggle = page.getByTestId('owner-reveal-toggle')
    await toggle.click()
    await expect(page.getByTestId('owner-reveal-dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Keep hidden' }).click()
    await expect(recent).not.toContainText('@')
    await toggle.click()
    await page.getByTestId('owner-reveal-confirm').click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('owner-who')).toContainText(OWNER_EMAIL)
    await toggle.click()
    await expect(page.getByTestId('owner-who')).not.toContainText('@')

    // Filters narrow the table: nobody can play Tinderbox yet, so it has no rows.
    await page.getByLabel('Game').selectOption('fighter')
    await expect(page).toHaveURL(/game=fighter/)
    await expect(page.getByTestId('recent-row')).toHaveCount(0)
    await page.getByLabel('Game').selectOption('four')
    await expect(page.getByTestId('recent-row').first()).toBeVisible()

    // CSV carries ids, never emails.
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('owner-csv').click()])
    const path = await download.path()
    const csv = (await import('node:fs')).readFileSync(path, 'utf8')
    expect(csv.split('\n')[0]).toContain('match_id')
    expect(csv).not.toContain('@')
    await context.close()
  })

  test('phone width has no horizontal page scroll, in light and dark', async ({ browser, baseURL }, testInfo) => {
    const shots = process.env.OWNER_SHOTS
    if (shots) mkdirSync(shots, { recursive: true })
    for (const [width, dark] of [[390, false], [390, true], [1440, false], [1440, true]] as const) {
      const { context, page } = await signedIn(browser, baseURL!, OWNER_NAME, { width, dark })
      await page.goto('/owner')
      await expect(page.getByTestId('owner-page')).toBeVisible()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `${width}px ${dark ? 'dark' : 'light'}`).toBeLessThanOrEqual(0)
      if (shots) await page.screenshot({ path: `${shots}/owner-${width}-${dark ? 'dark' : 'light'}.png`, fullPage: true })
      await context.close()
    }
    void testInfo
  })
})
