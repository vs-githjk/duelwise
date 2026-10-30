import { expect, test } from '@playwright/test'

for (const slug of ['chess', 'four-in-a-row', 'word-duel', 'heads-up-holdem', 'tinderbox', 'coldstore']) {
  test(`${slug} offers playable Practice and Start in the desktop viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/play/${slug}`)
    const picker = page.getByTestId('level-picker')
    await expect(picker.getByRole('radio')).toHaveCount(4)
    for (const radio of await picker.getByRole('radio').all()) await expect(radio).toBeEnabled()
    const start = page.getByRole('button', { name: 'Start match' })
    if (slug === 'tinderbox' || slug === 'coldstore') await expect(page.locator('section[data-testid="agent-card"]')).toHaveCount(0)
    if (slug === 'tinderbox') await page.getByRole('button', { name: 'Choose your fighter' }).click()
    await expect(start).toBeInViewport()
    const box = await start.boundingBox()
    expect(box!.y + box!.height).toBeLessThanOrEqual(900)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440)
  })
}

for (const slug of ['chess', 'four-in-a-row', 'word-duel', 'heads-up-holdem', 'tinderbox', 'coldstore']) {
  test(`${slug} has no horizontal overflow on a phone`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/play/${slug}`)
    // Tinderbox and Coldstore are playable on a phone with touch controls: no desktop-only notice, the setup screen shows.
    await expect(page.getByTestId('desktop-only')).toHaveCount(0)
    if (slug === 'tinderbox') await expect(page.getByRole('button', { name: 'Choose your fighter' })).toBeVisible()
    else await expect(page.getByTestId('level-picker')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })
}
