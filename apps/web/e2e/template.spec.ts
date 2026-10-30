import { expect, test } from '@playwright/test'

// The Cairn template game (docs/add-a-game.md): playable on a dev server at /dev/cairn, invisible to players.
test.describe('template game', () => {
  test('is not in the games list and has no play route', async ({ page }) => {
    await page.goto('/play')
    await expect(page.getByRole('heading', { name: 'Chess' }).first()).toBeVisible()
    await expect(page.getByText(/cairn/i)).toHaveCount(0)
    await page.goto('/play/cairn')
    await expect(page.getByTestId('cairn-page')).toHaveCount(0)
  })

  test('can be played to the end at /dev/cairn', async ({ page }) => {
    await page.goto('/dev/cairn')
    await page.getByTestId('cairn-start').click()
    const status = page.getByTestId('cairn-status')
    await expect(status).toContainText('Your move')
    for (let i = 0; i < 30; i++) {
      const text = (await status.textContent()) ?? ''
      if (/win|lose/.test(text)) break
      const take = page.getByTestId('cairn-take-1')
      if (await take.isEnabled()) await take.click()
      await page.waitForTimeout(150)
    }
    await expect(status).toContainText(/You win|You lose/)
    await expect(page.getByTestId('cairn-take-1')).toBeDisabled()
    await page.getByTestId('cairn-start').click()
    await expect(status).toContainText('Your move')
  })
})
