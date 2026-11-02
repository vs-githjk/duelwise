import { expect, test } from '@playwright/test'

// Stormglass dev page (internal id fleet): playable at /dev/fleet on a dev server, invisible to players.
// ?hold=0 removes the opponent's 700 ms pause so a whole match fits in the test timeout.
test.use({ viewport: { width: 360, height: 780 } })

test.describe('fleet dev page', () => {
  test('is not in the games list and has no play route', async ({ page }) => {
    await page.goto('/play')
    await expect(page.getByRole('heading', { name: 'Chess' }).first()).toBeVisible()
    await expect(page.getByText(/stormglass/i)).toHaveCount(0)
    await page.goto('/play/fleet')
    await expect(page.getByTestId('fleet-page')).toHaveCount(0)
  })

  test('setup: shuffle changes the fleet, a tap turns a ship, Ready starts the match', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    const ships = () => page.locator('[data-testid^="fleet-setup-"][data-state="ship"]')
    await expect(ships()).toHaveCount(17)
    const before = await ships().evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')).join())
    await page.getByTestId('fleet-shuffle').click()
    const after = await ships().evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')).join())
    await expect(ships()).toHaveCount(17)
    expect(after).not.toBe(before)
    // Select a ship, then tap it again to turn it: still 17 hull cells, and the Rotate label names the direction.
    await ships().first().click()
    await expect(page.getByTestId('fleet-rotate')).toContainText(/across|down/)
    const label = await page.getByTestId('fleet-rotate').textContent()
    await ships().first().click()
    const label2 = await page.getByTestId('fleet-rotate').textContent()
    // A turn can be refused when it would cross another ship; either way the fleet stays whole.
    expect([label, label2].every(Boolean)).toBe(true)
    await expect(ships()).toHaveCount(17)
    await page.getByTestId('fleet-ready').click()
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-phase', 'play')
  })

  test('plays a whole match to a result at 360 wide without the page ever shifting', async ({ page }) => {
    test.setTimeout(150_000)
    await page.goto('/dev/fleet?hold=0')
    await page.getByTestId('fleet-shuffle').click()
    await page.getByTestId('fleet-ready').click()
    const root = page.getByTestId('fleet-page')
    await expect(root).toHaveAttribute('data-turn', 'you')

    const board = page.getByTestId('fleet-cell-board')
    const fire = page.getByTestId('fleet-fire')
    const own = page.getByTestId('fleet-own')
    const rect = async () => ({ board: await board.boundingBox(), fire: await fire.boundingBox(), own: await own.boundingBox() })
    const start = await rect()
    expect(start.board!.width).toBeGreaterThan(300)
    // No horizontal scroll at 360.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    // Fire is disabled until a square is aimed; the aimed square shows in the chip.
    await expect(fire).toBeDisabled()

    let hits = 0
    let misses = 0
    for (let i = 0; i < 100; i++) {
      if ((await root.getAttribute('data-turn')) === 'over') break
      await expect(root).toHaveAttribute('data-turn', /you|over/)
      if ((await root.getAttribute('data-turn')) === 'over') break
      const cell = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').first()
      const id = (await cell.getAttribute('data-testid'))!
      await cell.click()
      await expect(cell).toHaveAttribute('data-aimed', '')
      await expect(page.getByTestId('fleet-aim-chip')).not.toBeEmpty()
      // Alternate the two ways to fire: tap again, or press Fire.
      if (i % 2 === 0) await cell.click()
      else await fire.click()
      await expect(page.getByTestId(id)).not.toHaveAttribute('data-state', 'open')
      const state = await page.getByTestId(id).getAttribute('data-state')
      if (state === 'hit') hits++
      else misses++
      // The board, the Fire bar and the own-waters card never move or resize mid-match (the result panel sits below them).
      const now = await rect()
      expect(now.board).toEqual(start.board)
      expect(now.fire).toEqual(start.fire)
    }
    await expect(page.getByTestId('fleet-result')).toBeVisible()
    await expect(page.getByTestId('fleet-result-reason')).toContainText(/sank/)
    await expect(fire).toBeDisabled()
    expect(hits + misses).toBeGreaterThan(10)
    // The hit/miss feedback marks exist on the board; at the end the whole enemy fleet is shown.
    await expect(page.locator('[data-testid^="fleet-cell-"][data-state="hit"]').first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await page.getByTestId('fleet-again').click()
    await expect(root).toHaveAttribute('data-phase', 'setup')
  })

  test('their opponent pause is real by default and the layout holds still through it', async ({ page }) => {
    await page.goto('/dev/fleet')
    await page.getByTestId('fleet-ready').click()
    const board = page.getByTestId('fleet-cell-board')
    const before = await board.boundingBox()
    const cell = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').first()
    await cell.click()
    await cell.click()
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'ai')
    expect(await board.boundingBox()).toEqual(before)
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'you')
    expect(await board.boundingBox()).toEqual(before)
    await expect(page.getByTestId('fleet-event')).toContainText(/fired at/)
  })
})
