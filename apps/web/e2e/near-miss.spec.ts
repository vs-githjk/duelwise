import { mkdirSync } from 'node:fs'
import { devices, expect, test, type Page } from '@playwright/test'

// B1: after a close loss the result panel carries the near-miss strip (where it turned, how near it got, two to four counts), above the fold.
// Glasscut has no spec here: its scripted autoplay wins every seed in the browser, so its strip is covered by the replayed-record unit tests. Each match below is a real one: the opponent and the human policy were replayed offline to find seeds that end in a close loss, so the
// strip's text is asserted exactly. NEAR_MISS_SHOTS=<absolute dir> saves a screenshot of each result.

const phone = (d: (typeof devices)[string]) => { const { defaultBrowserType: _ignored, ...rest } = d; return rest }
const SHOTS = process.env.NEAR_MISS_SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const VIEWPORTS = [
  { name: 'desktop-1440', use: { viewport: { width: 1440, height: 900 } } },
  { name: 'phone-390', use: { ...phone(devices['iPhone 15']), viewport: { width: 390, height: 844 } } },
] as const

function watch(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

async function expectAboveFold(page: Page) {
  const vh = page.viewportSize()!.height
  for (const id of ['near-miss', 'rematch']) {
    const b = await page.getByTestId(id).boundingBox()
    expect(b, id).not.toBeNull()
    expect(b!.y, `${id} top`).toBeGreaterThanOrEqual(0)
    expect(b!.y + b!.height, `${id} bottom`).toBeLessThanOrEqual(vh)
  }
}

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use(vp.use)

    test('Four in a Row: the drop after which the solver says lost', async ({ page }) => {
      test.setTimeout(120_000)
      const errors = watch(page)
      // Seed 27 and ?opponent=random: the opponent's replies are the seeded stub's, so these eleven drops lose at drop 15 of a game the solver had level.
      await page.goto('/play/four-in-a-row?seed=27&opponent=random')
      await page.getByRole('radio', { name: /Easy/ }).check()
      await page.getByRole('button', { name: 'Start match' }).click()
      const board = page.getByTestId('four-board')
      for (const col of [2, 7, 1, 6, 3, 7, 7, 4, 1, 6, 6]) {
        await expect(board).toHaveAttribute('data-turn', 'you')
        const before = Number(await board.getAttribute('data-moves'))
        await page.getByTestId(`col-${col - 1}`).click()
        await expect(board).not.toHaveAttribute('data-moves', String(before))
        if (await page.getByTestId('result-panel').isVisible()) break
      }
      await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss')
      const strip = page.getByTestId('near-miss')
      await expect(strip).toBeVisible({ timeout: 15_000 })
      await expect(page.getByTestId('near-miss-line')).toHaveText('Before drop 15 you could still win.')
      await expect(page.getByTestId('near-miss-turning')).toContainText('Drop 15, column 4, was where it turned: after it the solver says Pip wins.')
      await expect(page.getByTestId('near-miss-stats')).toContainText('Drops after it turned')
      await expectAboveFold(page)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/four-${vp.name}.png` })
      expect(errors).toEqual([])
    })

    test('Crosscurrent: the placement that gave a corner away', async ({ page }) => {
      test.setTimeout(120_000)
      const errors = watch(page)
      // Seed 8: Pip is the opponent, the player takes the lowest legal cell every turn, and the game ends four discs short.
      await page.goto('/play/crosscurrent?seed=8')
      await page.getByRole('radio', { name: /Easy/ }).check()
      await page.getByRole('button', { name: 'Start match' }).click()
      const hud = page.getByTestId('play-hud')
      for (let i = 0; i < 400; i++) {
        if ((await hud.getAttribute('data-turn')) === 'over') break
        const cell = page.locator('[data-testid^="slack-cell-"][data-legal]').first()
        if ((await hud.getAttribute('data-turn')) === 'you' && (await cell.count()) > 0) {
          await cell.click()
          await cell.click()
        }
        await page.waitForTimeout(120)
      }
      await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss', { timeout: 20_000 })
      await expect(page.getByTestId('near-miss')).toBeVisible({ timeout: 15_000 })
      await expect(page.getByTestId('near-miss-line')).toHaveText('You finished 4 discs short.')
      await expect(page.getByTestId('near-miss-turning')).toContainText('let Pip take the H8 corner on the next move.')
      await expect(page.getByTestId('near-miss-stats')).toContainText('Discs short')
      await expectAboveFold(page)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/crosscurrent-${vp.name}.png` })
      expect(errors).toEqual([])
    })
  })
}
