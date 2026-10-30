import { expect, test, type Browser, type Page } from '@playwright/test'

const NAME = 'e2e-report-player'

async function signedIn(browser: Browser, baseURL: string, name: string, opts: { width?: number; dark?: boolean } = {}) {
  const context = await browser.newContext({ baseURL, viewport: { width: opts.width ?? 1280, height: 900 }, colorScheme: opts.dark ? 'dark' : 'light' })
  const page = await context.newPage()
  await page.goto('/signin')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Dev sign in' }).click()
  await expect(page).toHaveURL(/\/play$/)
  await expect(page.getByTestId('user-menu')).toContainText(name)
  return { context, page }
}

/** Plays a counted Four in a Row match against Easy to its end by always taking the first open column. */
async function playToTheEnd(page: Page) {
  await page.goto('/play/four-in-a-row')
  await page.waitForLoadState('networkidle')
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', 'you')
  for (let i = 0; i < 44; i++) {
    if (await page.getByTestId('result-panel').isVisible()) break
    const col = await page.locator('[data-testid^="col-"]:not([aria-disabled="true"])').first().getAttribute('data-testid')
    await page.getByTestId(col!).click()
    await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', /you|over/)
    await expect(page.getByTestId('four-board')).not.toHaveAttribute('data-settling', 'true')
  }
  await expect(page.getByTestId('result-panel')).toBeVisible()
}

test.describe('match report', () => {
  test('from the end of a match to its report, then the public link and the share card', async ({ browser, baseURL }) => {
    const { context, page } = await signedIn(browser, baseURL!, NAME)
    await playToTheEnd(page)
    const outcome = await page.getByTestId('result-panel').getAttribute('data-outcome')

    // The result panel links to the report once the server has counted the match.
    const link = page.getByTestId('result-report-link')
    await expect(link).toBeVisible()
    const href = await link.getAttribute('href')
    expect(href).toMatch(/^\/report\/[0-9a-f-]{36}$/)
    await link.click()

    // Owner view: headline, rating, training status, key moments, share controls.
    await expect(page.getByTestId('report')).toHaveAttribute('data-mode', 'owner')
    await expect(page.getByTestId('report')).toHaveAttribute('data-status', 'ready')
    await expect(page.getByTestId('report-title')).toContainText('Pip')
    await expect(page.getByTestId('report-title')).toContainText(outcome === 'win' ? 'You beat Pip.' : outcome === 'loss' || outcome === 'lose' ? 'Pip beat you.' : 'A draw with Pip.')
    await expect(page.getByTestId('report-rating')).toBeVisible()
    await expect(page.getByTestId('report-learning-state')).toHaveAttribute('data-state', 'stored')
    await expect(page.getByTestId('moments').locator('li').last()).toHaveAttribute('data-kind', 'end')
    await expect(page.getByTestId('share-link')).toContainText(href!)
    // Four reports show the final board and the drop strip.
    await expect(page.getByTestId('four-final-board').locator('span.rounded-full')).toHaveCount(42)
    expect(await page.getByTestId('four-drops').locator('li').count()).toBeGreaterThan(6)

    // The share card of a public report is an image with the headline and nothing private.
    const card = await page.request.get(`${href!.replace('/report/', '/report-card/')}`)
    expect(card.status()).toBe(200)
    expect(card.headers()['content-type']).toContain('image/svg+xml')
    const svg = await card.text()
    expect(svg).toContain('Pip')
    expect(svg).not.toContain(NAME)
    // The link preview image is a PNG of the same card.
    const png = await page.request.get(`${href!.replace('/report/', '/report-card/')}.png`)
    expect(png.status()).toBe(200)
    expect(png.headers()['content-type']).toBe('image/png')
    expect((await png.body()).subarray(1, 4).toString()).toBe('PNG')

    // A stranger sees the public view: no rating, no training status, no account name.
    const anon = await browser.newContext({ baseURL: baseURL! })
    const a = await anon.newPage()
    const res = await a.goto(href!)
    expect(res!.status()).toBe(200)
    await expect(a.getByTestId('report')).toHaveAttribute('data-mode', 'public')
    await expect(a.getByTestId('report-rating')).toHaveCount(0)
    await expect(a.getByTestId('report-learning')).toHaveCount(0)
    await expect(a.getByTestId('report-share')).toHaveCount(0)
    const text = await a.locator('body').innerText()
    expect(text).not.toContain(NAME)
    expect(text).not.toContain('dev.invalid')
    await expect(a.getByTestId('report-title')).toContainText(/a Duelwise player/i)
    await expect(a.locator('meta[property="og:image"]')).toHaveAttribute('content', /\/report-card\/[0-9a-f-]{36}\.png$/)

    // The player shows their name; the public page follows.
    await page.getByTestId('share-name').check()
    await expect(page.getByTestId('share-name')).toBeChecked()
    await a.reload()
    await expect(a.getByTestId('report-title')).toContainText(NAME)

    // Turning the link off hides the report and its card from everyone else, but not from the player.
    await page.getByTestId('share-public').uncheck()
    await expect(page.getByTestId('share-off')).toBeVisible()
    await a.reload()
    await expect(a.getByTestId('report-private')).toBeVisible()
    await expect(a.getByTestId('report')).toHaveCount(0)
    expect((await a.request.get(href!.replace('/report/', '/report-card/'))).status()).toBe(404)
    expect((await a.request.get(`${href!.replace('/report/', '/report-card/')}.png`)).status()).toBe(404)
    await page.reload()
    await expect(page.getByTestId('report')).toHaveAttribute('data-mode', 'owner')
    await anon.close()
    await context.close()
  })

  test('an unknown report id is the not-found page', async ({ page }) => {
    const res = await page.goto('/report/00000000-0000-4000-8000-000000000000')
    expect(res!.status()).toBe(404)
    await expect(page.getByTestId('not-found')).toBeVisible()
  })

  test('a resigned match has a report with the result and no invented moments', async ({ browser, baseURL }) => {
    const { context, page } = await signedIn(browser, baseURL!, 'e2e-report-resigner')
    await page.goto('/play/four-in-a-row')
    await page.waitForLoadState('networkidle')
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', 'you')
    await page.getByRole('button', { name: 'Resign' }).click()
    await page.getByRole('button', { name: 'Yes, resign' }).click()
    await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss')
    await page.getByTestId('result-report-link').click()
    await expect(page.getByTestId('report')).toHaveAttribute('data-status', 'resigned')
    await expect(page.getByTestId('report-learning-state')).toHaveAttribute('data-state', 'not_used')
    await expect(page.getByTestId('report-moments')).toHaveCount(0)
    await context.close()
  })

  test('works at 360 px in light and dark with no horizontal scroll', async ({ browser, baseURL }) => {
    for (const dark of [false, true]) {
      const { context, page } = await signedIn(browser, baseURL!, `rp-${dark ? 'd' : 'l'}`, { width: 360, dark })
      await playToTheEnd(page)
      await page.getByTestId('result-report-link').click()
      await expect(page.getByTestId('report')).toBeVisible()
      // The report itself must fit; the signed-in header's own width is not this page's.
      const outside = await page.evaluate(() => {
        const out: string[] = []
        document.querySelectorAll('[data-testid="report"], [data-testid="report"] *').forEach((e) => {
          if (e.getBoundingClientRect().right > window.innerWidth + 0.5) out.push((e as HTMLElement).dataset.testid ?? e.tagName)
        })
        return out
      })
      expect(outside).toEqual([])
      await context.close()
    }
  })
})
