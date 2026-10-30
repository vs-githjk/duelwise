import { expect, test, type Browser, type Page } from '@playwright/test'

// playwright.config.ts sets OWNER_EMAILS to the dev-login email of "eowner".
const OWNER_NAME = 'eowner'
const OWNER_EMAIL = 'eowner@dev.invalid'

async function signedIn(browser: Browser, baseURL: string, name: string, width = 1280) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 900 } })
  const page = await context.newPage()
  await page.goto('/signin')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Dev sign in' }).click()
  await expect(page).toHaveURL(/\/play$/)
  await expect(page.getByTestId('user-menu')).toContainText(name)
  return { context, page }
}

/** Plays a Four in a Row match against Easy to its end, so one finished, valid match exists for the player. */
async function playFourToEnd(page: Page) {
  await page.goto('/play/four-in-a-row')
  await page.waitForLoadState('networkidle')
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId('four-board')).toBeVisible()
  for (let i = 0; i < 44; i++) {
    if (await page.getByTestId('result-panel').isVisible()) break
    await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', /you|over/)
    await expect(page.getByTestId('four-board')).not.toHaveAttribute('data-settling', 'true')
    if (await page.getByTestId('result-panel').isVisible()) break
    const col = await page.locator('[data-testid^="col-"]:not([aria-disabled="true"])').first().getAttribute('data-testid')
    await page.getByTestId(col!).click()
    await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', /you|over/)
    await expect(page.getByTestId('four-board')).not.toHaveAttribute('data-settling', 'true')
  }
  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('four-record')).toHaveAttribute('data-record-ok', 'true')
}

test.describe('owner admin: people, drill-down and activity', () => {
  test('the owner sees totals, the people table, a drill-down and the feed; a normal user cannot see any of it', async ({ browser, baseURL }) => {
    const player = await signedIn(browser, baseURL!, 'e2e-adm-player')
    await playFourToEnd(player.page)
    await player.context.close()

    const { context, page } = await signedIn(browser, baseURL!, OWNER_NAME)
    await page.goto('/owner')
    await expect(page.getByTestId('owner-page')).toBeVisible()
    await expect(page.getByTestId('admin-section')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'People and activity' })).toBeVisible()

    // Totals: both dev accounts exist, so at least two players; two 14-day charts with 14 bars each.
    await expect(page.getByTestId('admin-totals')).toBeVisible()
    expect(Number(await page.getByTestId('admin-total-count').textContent())).toBeGreaterThanOrEqual(2)
    await expect(page.getByTestId('admin-new-bars').locator('[title]')).toHaveCount(14)
    await expect(page.getByTestId('admin-matches-bars').locator('[title]')).toHaveCount(14)
    await expect(page.getByTestId('admin-game-four')).not.toHaveAttribute('data-count', '0')

    // People table: the player is listed with a match and the type, and the search narrows it.
    const row = page.getByTestId('person-row').filter({ hasText: 'e2e-adm-player' })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('signed in')
    expect(Number(await row.locator('td').nth(4).textContent())).toBeGreaterThanOrEqual(1)
    await expect(row.getByTestId('admin-ref')).toHaveText(/account pl_[0-9a-f]{8}/)
    await expect(page.getByTestId('admin-people')).not.toContainText('@')

    await page.getByTestId('people-search').fill('adm-pla')
    await expect(page.getByTestId('person-row')).toHaveCount(1)
    await page.getByTestId('people-search').fill('nobody-by-this-name')
    await expect(page.getByTestId('people-empty')).toBeVisible()
    await page.getByTestId('people-search').fill('')
    await expect(page.getByTestId('person-row').first()).toBeVisible()

    // Sorting flips the order and marks the header.
    await page.getByTestId('sort-joined').click()
    await expect(page.getByRole('columnheader', { name: /Joined/ })).toHaveAttribute('aria-sort', 'descending')
    await page.getByTestId('sort-joined').click()
    await expect(page.getByRole('columnheader', { name: /Joined/ })).toHaveAttribute('aria-sort', 'ascending')

    // The feed lists the finished match.
    await expect(page.getByTestId('feed-row').filter({ hasText: 'e2e-adm-player' }).first()).toBeVisible()

    // Drill-down: history and path.
    await page.getByTestId('person-row').filter({ hasText: 'e2e-adm-player' }).getByRole('button', { name: /Open e2e-adm-player/ }).click()
    const sheet = page.getByTestId('player-sheet')
    await expect(sheet).toBeVisible()
    await expect(page.getByTestId('player-name')).toHaveText('e2e-adm-player')
    // Starting a game opens match rows that were never finished (shown as in progress); the one finished match is the counted one.
    const finished = page.locator('[data-testid="history-row"][data-result="won"], [data-testid="history-row"][data-result="lost"], [data-testid="history-row"][data-result="draw"]')
    await expect(finished).toHaveCount(1)
    await expect(finished).toContainText('Four in a Row')
    await expect(finished).toContainText('Pip')
    await expect(finished.getByText('counted', { exact: true })).toBeVisible()
    await expect(finished.getByText('valid', { exact: true })).toBeVisible()
    await expect(finished.getByRole('link', { name: 'Report' })).toHaveAttribute('href', /^\/report\/.+/)
    await expect(page.getByTestId('path-four')).toBeVisible()
    await expect(sheet).not.toContainText('@')
    await page.getByTestId('player-close').click()
    await expect(sheet).toBeHidden()

    // Emails stay hidden until the audited reveal, then show here too.
    await page.getByTestId('owner-reveal-toggle').click()
    await page.getByTestId('owner-reveal-confirm').click()
    await expect(page.getByTestId('admin-people')).toContainText('e2e-adm-player@dev.invalid')
    await expect(page.getByTestId('admin-people')).toContainText(OWNER_EMAIL)
    await page.getByTestId('owner-reveal-toggle').click()
    await expect(page.getByTestId('admin-people')).not.toContainText('@')
    await context.close()

    // A normal player and a visitor with no account get the not-found page, and none of the admin markup.
    const plain = await signedIn(browser, baseURL!, 'e2e-adm-plain')
    const res = await plain.page.goto('/owner')
    expect(res!.status()).toBe(404)
    await expect(plain.page.getByTestId('not-found')).toBeVisible()
    await expect(plain.page.getByTestId('admin-section')).toHaveCount(0)
    await expect(plain.page.locator('body')).not.toContainText('e2e-adm-player')
    await plain.context.close()

    const anon = await browser.newContext({ baseURL: baseURL! })
    const a = await anon.newPage()
    expect((await a.goto('/owner'))!.status()).toBe(404)
    await expect(a.getByTestId('admin-section')).toHaveCount(0)
    await anon.close()
  })

  test('the admin section has no horizontal page scroll at phone width and lists people as cards', async ({ browser, baseURL }) => {
    const { context, page } = await signedIn(browser, baseURL!, OWNER_NAME, 390)
    await page.goto('/owner')
    await expect(page.getByTestId('admin-section')).toBeVisible()
    await expect(page.getByTestId('person-card').first()).toBeVisible()
    await expect(page.getByTestId('person-row').first()).toBeHidden()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await page.getByTestId('person-card').first().click()
    await expect(page.getByTestId('player-sheet')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    await context.close()
  })
})
