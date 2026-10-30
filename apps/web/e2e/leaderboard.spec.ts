import { expect, test, type Page } from '@playwright/test'
import { PRODUCT } from '@duelwise/core/src/product.ts'

const FOUR = '/play/four-in-a-row'
const WORD = '/play/word-duel'

async function devSignIn(page: Page, name: string) {
  await page.goto('/signin')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Dev sign in' }).click()
  await expect(page).toHaveURL(/\/play$/)
  await expect(page.getByTestId('user-menu')).toContainText(name)
}

async function playFourToEnd(page: Page, query = '') {
  await page.goto(FOUR + query)
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

async function playWordToEnd(page: Page, query = '') {
  await page.goto(WORD + query)
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId('word-input')).toBeVisible()
  for (const w of ['crane', 'slate', 'house', 'about', 'other', 'these', 'light', 'might']) {
    await expect(page.locator('[data-testid="word-input"]:enabled, [data-testid="result-panel"]')).toBeVisible()
    if (await page.getByTestId('result-panel').isVisible()) break
    await page.getByTestId('word-input').fill(w)
    await page.getByTestId('word-input').press('Enter')
  }
  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('word-record')).toHaveAttribute('data-record-ok', 'true')
}

test.describe('counted matches, ratings and the leaderboard', () => {
  test('Four in a Row: the seed comes from startMatch, the record uploads, a dev user sees a rating change', async ({ page }) => {
    await devSignIn(page, 'rita')
    const started = page.waitForResponse((r) => r.url().includes('_serverFn') && r.request().method() === 'POST' && r.ok())
    await playFourToEnd(page)
    expect((await started).ok()).toBe(true)
    const elo = page.getByTestId('result-elo')
    await expect(elo).toBeVisible()
    await expect(elo).toContainText(/Rating 1000 to \d+/)
    // Four Easy is a measured level, so the rating is not marked provisional on the opponent's account.
    await expect(page.getByTestId('result-elo-provisional')).toHaveCount(0)
    await expect(page.getByTestId('result-unrated')).toHaveCount(0)

    await page.goto('/leaderboard/four-in-a-row')
    await expect(page.getByTestId('leaderboard-me')).toContainText('after 1 counted match')
    await expect(page.getByTestId('leaderboard-empty')).toBeVisible() // 1 match is under the 5 needed
  })

  test('Word Duel goes through the same recorder; a ?seed match is unrated', async ({ page }) => {
    await devSignIn(page, 'wanda')
    await playWordToEnd(page)
    await expect(page.getByTestId('result-elo')).toContainText(/Rating 1000 to \d+/)

    await playWordToEnd(page, '?seed=7')
    await expect(page.getByTestId('result-unrated')).toContainText('not counted')
    await expect(page.getByTestId('result-elo')).toHaveCount(0)
  })

  test('a guest match is saved but gets no rating', async ({ page }) => {
    await playFourToEnd(page)
    await expect(page.getByTestId('result-upload')).toContainText('Sign in to get a rating')
    await expect(page.getByTestId('result-elo')).toHaveCount(0)
  })

  test('the leaderboard page exists for every game and is honest when empty', async ({ page }) => {
    await page.goto('/leaderboard/chess')
    await expect(page.getByRole('heading', { name: /board, last 30 days/ })).toBeVisible()
    await expect(page.getByTestId('leaderboard-empty')).toBeVisible()
  })

  test('real-time games have no leaderboard and say why (S1)', async ({ page }) => {
    for (const g of ['fighter', 'arena'] as const) {
      await page.goto(`/leaderboard/${PRODUCT.games[g].slug}`)
      await expect(page.getByTestId('leaderboard-unranked')).toContainText('do not change a rating yet')
      await expect(page.getByTestId('leaderboard-empty')).toHaveCount(0)
      await expect(page.getByTestId('leaderboard-cta')).toHaveCount(0)
    }
  })
})
