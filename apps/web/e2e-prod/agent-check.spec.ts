import { expect, test } from '@playwright/test'

/**
 * The server's re-run of the opponent (H1) in a production build: no DUELWISE_AGENT_CHECK switch exists here, so the
 * server loads the shipped Four in a Row Easy net itself, replays the whole game against the record the page uploaded,
 * and only then counts the match. A page that played honestly must come back "Saved", not "rejected".
 */
test('an honest Four in a Row game is counted by the production server', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/play/four-in-a-row')
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  const board = page.getByTestId('four-board')
  await expect(board).toBeVisible({ timeout: 30_000 })
  for (let i = 0; i < 44; i++) {
    if (await page.getByTestId('result-panel').isVisible()) break
    await expect(board).toHaveAttribute('data-turn', /you|over/, { timeout: 30_000 })
    await expect(board).not.toHaveAttribute('data-settling', 'true')
    if (await page.getByTestId('result-panel').isVisible()) break
    const col = await page.locator('[data-testid^="col-"]:not([aria-disabled="true"])').first().getAttribute('data-testid')
    await page.getByTestId(col!).click()
  }
  await expect(page.getByTestId('result-panel')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('four-record')).toHaveAttribute('data-record-ok', 'true')
  const upload = page.getByTestId('result-upload')
  await expect(upload).toBeVisible({ timeout: 30_000 })
  await expect(upload).toContainText('Saved')
  await expect(upload).not.toContainText('could not be checked')
  await expect(upload).not.toContainText('not the ones')
})
