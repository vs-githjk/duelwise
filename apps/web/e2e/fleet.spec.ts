import { expect, test, type Page } from '@playwright/test'

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

  const shipCellsNow = (page: Page) => page.locator('[data-testid^="fleet-setup-"][data-state="ship"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')).join())

  test('setup: shuffle changes the fleet and Ready starts the match', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    const ships = page.locator('[data-testid^="fleet-setup-"][data-state="ship"]')
    await expect(ships).toHaveCount(17)
    const before = await shipCellsNow(page)
    await page.getByTestId('fleet-shuffle').click()
    await expect(ships).toHaveCount(17)
    expect(await shipCellsNow(page)).not.toBe(before)
    await page.getByTestId('fleet-ready').click()
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-phase', 'play')
  })

  test('setup: selecting a ship and tapping it again turns it, so its cells change', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    const ships = page.locator('[data-testid^="fleet-setup-"][data-state="ship"]')
    let turned = false
    // A turn is refused when it would cross another ship, so shuffle until one is accepted.
    for (let attempt = 0; attempt < 12 && !turned; attempt++) {
      await page.getByTestId('fleet-shuffle').click()
      const before = await shipCellsNow(page)
      await ships.first().click()
      await expect(page.getByTestId('fleet-rotate')).toContainText(/across|down/)
      await ships.first().click()
      const after = await shipCellsNow(page)
      turned = after !== before
    }
    expect(turned).toBe(true)
    await expect(ships).toHaveCount(17)
  })

  test('setup: dragging a ship with the mouse moves its cells', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    const ships = page.locator('[data-testid^="fleet-setup-"][data-state="ship"]')
    const centre = async (id: string) => {
      const box = (await page.getByTestId(id).boundingBox())!
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    let moved = false
    for (let attempt = 0; attempt < 12 && !moved; attempt++) {
      await page.getByTestId('fleet-shuffle').click()
      const before = await shipCellsNow(page)
      const from = (await ships.first().getAttribute('data-testid'))!
      const n = Number(from.split('-').pop())
      for (const delta of [10, -10, 1, -1, 20, -20]) {
        const to = n + delta
        if (to < 0 || to > 99) continue
        const a = await centre(from)
        const b = await centre(`fleet-setup-${to}`)
        await page.mouse.move(a.x, a.y)
        await page.mouse.down()
        await page.mouse.move(b.x, b.y, { steps: 4 })
        await page.mouse.up()
        if ((await shipCellsNow(page)) !== before) {
          moved = true
          break
        }
      }
    }
    expect(moved).toBe(true)
    await expect(ships).toHaveCount(17)
  })

  test('setup: a keyboard can select and turn a ship (Enter, no pointer)', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    const ships = page.locator('[data-testid^="fleet-setup-"][data-state="ship"]')
    await expect(page.getByTestId('fleet-rotate')).toBeDisabled()
    let turned = false
    for (let attempt = 0; attempt < 12 && !turned; attempt++) {
      await page.getByTestId('fleet-shuffle').click()
      const before = await shipCellsNow(page)
      await ships.first().focus()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('fleet-rotate')).toBeEnabled()
      await page.keyboard.press('Space')
      turned = (await shipCellsNow(page)) !== before
    }
    expect(turned).toBe(true)
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
    const rect = async () => ({
      board: await board.boundingBox(),
      fire: await fire.boundingBox(),
      own: await own.boundingBox(),
    })
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
      // The board and the Fire bar never move or resize; the own-waters card holds still too until the result card mounts above it.
      const turnBefore = await root.getAttribute('data-turn')
      const now = await rect()
      const turnAfter = await root.getAttribute('data-turn')
      expect(now.board).toEqual(start.board)
      expect(now.fire).toEqual(start.fire)
      if (turnBefore !== 'over' && turnAfter !== 'over') expect(now.own).toEqual(start.own)
    }
    await expect(page.getByTestId('fleet-result')).toBeVisible()
    await expect(page.getByTestId('fleet-result-reason')).toContainText(/sank/)
    // The result card brings itself into view: no manual scroll is needed to reach Play again.
    await expect(page.getByTestId('fleet-again')).toBeInViewport()
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

  test('resigning ends the match: Fire is off, the shot count holds, and no fleet is claimed to be shown', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    await page.getByTestId('fleet-ready').click()
    const cell = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').first()
    await cell.click()
    await expect(page.getByTestId('fleet-fire')).toBeEnabled()
    await page.getByTestId('fleet-resign').click()
    await expect(page.getByTestId('fleet-result')).toContainText('You resigned.')
    await expect(page.getByTestId('fleet-fire')).toBeDisabled()
    await expect(page.getByTestId('fleet-aim-chip')).toBeEmpty()
    await expect(page.getByTestId('fleet-shot-count')).toHaveText('Shot 0')
    await expect(page.getByTestId('fleet-result')).not.toContainText('whole fleet is shown')
    await page.getByTestId('fleet-fire').click({ force: true })
    await cell.click({ force: true })
    await expect(page.getByTestId('fleet-shot-count')).toHaveText('Shot 0')
  })
})

test.describe('fleet dev page at desktop width', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('two boards sit side by side with Fire under the left one', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    await page.getByTestId('fleet-ready').click()
    const theirs = (await page.getByTestId('fleet-cell-board').boundingBox())!
    const mine = (await page.getByTestId('fleet-own-board').boundingBox())!
    const fire = (await page.getByTestId('fleet-fire').boundingBox())!
    expect(mine.x).toBeGreaterThan(theirs.x + theirs.width - 1)
    expect(Math.abs(mine.y - theirs.y)).toBeLessThan(2)
    expect(theirs.width).toBeGreaterThan(330)
    expect(Math.abs(mine.width - theirs.width)).toBeLessThan(2)
    expect(fire.y).toBeGreaterThan(theirs.y + theirs.height)
    expect(fire.x).toBeLessThan(mine.x)
    expect(fire.x + fire.width).toBeLessThanOrEqual(theirs.x + theirs.width + 1)
    await expect(page.getByTestId('fleet-status-row')).toBeHidden()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })
})
