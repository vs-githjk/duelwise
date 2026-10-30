import { expect, test } from '@playwright/test'
import { PRODUCT } from '@duelwise/core/src/product.ts'

// KB2: shell polish. Hero tiles, leaderboard, phone nav, skip link, phone tables.

const noSideways = (page: import('@playwright/test').Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)

test.describe('KB2 shell', () => {
  test('fight cards: names are whole and the record never sits on the name', async ({ page }) => {
    for (const width of [1440, 1152, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      await page.waitForLoadState('networkidle')
      const cards = page.locator('[data-testid^="fighter-"]:not([data-testid^="fighter-record-"])')
      await expect(cards.first()).toBeVisible()
      expect(await cards.count()).toBe(4)
      for (const card of await cards.all()) {
        const name = card.locator('b').first()
        const fits = await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
        expect(fits, `${width}: name fits`).toBe(true)
        // Inject a worst-case record, so the check does not depend on the DB being empty.
        const record = card.locator('[data-testid^="fighter-record-"]')
        await record.evaluate((el) => { el.textContent = '123,456 W 123,456 L' })
        const inside = await record.evaluate((el) => {
          const c = el.closest('li')!
          return { sw: el.scrollWidth, cw: el.clientWidth, card: c.clientWidth, right: el.getBoundingClientRect().right, cardRight: c.getBoundingClientRect().right }
        })
        expect(inside.sw, `${width}: record not cut off`).toBeLessThanOrEqual(inside.card - 8)
        expect(inside.sw, `${width}: record fits its own box`).toBeLessThanOrEqual(inside.cw + 1)
        expect(inside.right, `${width}: record inside card`).toBeLessThanOrEqual(inside.cardRight + 1)
        const recordY = await record.evaluate((el) => el.getBoundingClientRect().top)
        const nameBox = (await name.boundingBox())!
        expect(recordY, `${width}: record below name`).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 1)
      }
    }
  })

  test('leaderboard at 1440: one row of tabs, and the empty state has a next step and the AI rows', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/leaderboard/${PRODUCT.games.chess.slug}`)
    const links = page.getByTestId('leaderboard-switcher').locator('a')
    const ys = await links.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
    expect(new Set(ys).size).toBe(1)
    await expect(page.getByTestId('leaderboard-empty')).toBeVisible()
    await expect(page.getByTestId('leaderboard-cta')).toBeVisible()
    await expect(page.getByTestId('leaderboard-cta')).toHaveAttribute('href', '/signin')
    await expect(page.getByTestId('leaderboard-ai').locator('li')).toHaveCount(4)
  })

  test('leaderboard: the Four reference matches the AI page, and a signed-in user with no rating gets Play', async ({ page }) => {
    const slug = PRODUCT.games.four.slug
    await page.goto('/ai')
    const aiEasy = await page.getByTestId('cast-row-four').locator('[data-testid="cast-strength"]').first().innerText()
    await page.goto(`/leaderboard/${slug}`)
    const easy = await page.getByTestId('leaderboard-ai-easy').innerText()
    expect(aiEasy).toContain('site Elo 1000')
    expect(easy).toContain(aiEasy.trim())
    await page.goto('/signin')
    await page.waitForLoadState('networkidle')
    await page.getByLabel('Name').fill('Board Rookie')
    await page.getByRole('button', { name: 'Dev sign in' }).click()
    await expect(page).toHaveURL(/\/play$/)
    await page.goto(`/leaderboard/${slug}`)
    const cta = page.getByTestId('leaderboard-cta')
    await expect(cta).toContainText('Play')
    await expect(cta).toHaveAttribute('href', `/play/${slug}`)
    await expect(page.getByTestId('leaderboard-empty')).not.toContainText('Sign in')
  })

  test('phone: The AI is in the nav, the header fits, and the skip link reaches the content', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await expect(page.getByTestId('nav-ai')).toBeVisible()
    expect(await noSideways(page)).toBe(true)
    await page.keyboard.press('Tab')
    const skip = page.getByTestId('skip-link')
    await expect(skip).toBeFocused()
    await expect(skip).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('#main')).toBeFocused()
  })

  test('phone: The AI table shows every opponent without a sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/ai')
    await expect(page.getByTestId('cast-table')).toBeVisible()
    expect(await noSideways(page)).toBe(true)
    await expect(page.getByTestId('scroll-cue')).toHaveCount(0)
    const row = page.getByTestId('cast-row-chess')
    for (const name of ['Pip (Easy)', 'Marlow (Medium)', 'Vesper (Hard)', 'Sable (Champion)']) {
      const label = await row.locator(`td[data-label="${name}"]`).count()
      expect(label, name).toBe(1)
    }
  })
})
