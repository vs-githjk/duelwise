import { expect, test } from '@playwright/test'

// The config marks every guide seen; this spec tests the first visit, so it starts with empty storage.
test.use({ storageState: { cookies: [], origins: [] } })

for (const [slug, title] of [['chess', 'Chess'], ['word-duel', 'Word Duel']] as const) {
  test(`${title} instructions open on first visit and can be reopened`, async ({ page }) => {
    await page.goto(`/play/${slug}`)
    const dialog = page.getByRole('dialog', { name: `How to play ${title}` })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await page.reload()
    await expect(dialog).toBeHidden()
    await page.getByRole('button', { name: 'How to play' }).click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toBeHidden()
    await page.getByRole('button', { name: 'Start match' }).click()
    const headerButton = page.locator('[data-testid=game-shell] header').getByRole('button', { name: 'How to play' })
    await expect(headerButton).toBeVisible()
    await headerButton.click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
}
