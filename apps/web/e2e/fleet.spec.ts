import { expect, test, type Page } from '@playwright/test'

// Stormglass dev page (internal id fleet): playable at /dev/fleet on a dev server and, since promotion, at /play/stormglass for players.
// ?hold=0 removes the opponent's 700 ms pause so a whole match fits in the test timeout.
test.use({ viewport: { width: 360, height: 780 } })

test.describe('fleet dev page and promotion', () => {
  test('is promoted: listed on /play, played at /play/stormglass, no route at the internal id', async ({ page }) => {
    await page.goto('/play')
    await expect(page.getByRole('heading', { name: 'Chess' }).first()).toBeVisible()
    await expect(page.getByText(/stormglass/i).first()).toBeVisible()
    await page.goto('/play/stormglass')
    await expect(page.getByTestId('fleet-page')).toBeVisible()
    // The play page sits in the shared shell: back link, guide button and sound control.
    await expect(page.getByTestId('game-shell')).toHaveAttribute('data-game', 'fleet')
    await expect(page.getByTestId('game-back')).toBeVisible()
    await expect(page.getByTestId('game-sound-button')).toBeVisible()
    await expect(page.getByRole('button', { name: 'How to play' })).toBeVisible()
    const res = await page.goto('/play/fleet')
    expect(res?.status()).toBe(404)
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

  test('setup: dragging a ship moves it by exactly the drag offset', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    const read = async () =>
      new Set(
        await page
          .locator('[data-testid^="fleet-setup-"][data-state="ship"]')
          .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-testid')!.split('-').pop()))),
      )
    const centre = async (n: number) => {
      const box = (await page.getByTestId(`fleet-setup-${n}`).boundingBox())!
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    let proven = false
    // One drag per shuffle with nothing selected, onto open water: only the drag branch can move a ship then.
    for (let attempt = 0; attempt < 40 && !proven; attempt++) {
      await page.getByTestId('fleet-shuffle').click()
      const before = await read()
      const grab = Math.max(...before)
      for (const delta of [10, -10, 1, -1]) {
        const to = grab + delta
        if (to < 0 || to > 99 || before.has(to)) continue
        const a = await centre(grab)
        const b = await centre(to)
        await page.mouse.move(a.x, a.y)
        await page.mouse.down()
        await page.mouse.move(b.x, b.y, { steps: 4 })
        await page.mouse.up()
        const after = await read()
        if ([...before].every((x) => after.has(x))) break
        // Exactly one straight ship through the grabbed cell moved by the drag offset; every other cell stayed.
        const shifted = (ship: number[]) => new Set([...before].filter((x) => !ship.includes(x)).concat(ship.map((x) => x + delta)))
        const same = (u: Set<number>, v: Set<number>) => u.size === v.size && [...u].every((x) => v.has(x))
        const fits = [1, 10].some((step) =>
          [2, 3, 4, 5].some((len) =>
            Array.from({ length: len }, (_, k) => grab - k * step).some((start) => {
              const ship = Array.from({ length: len }, (_, k) => start + k * step)
              return ship.every((x) => before.has(x)) && same(shifted(ship), after)
            }),
          ),
        )
        expect(fits).toBe(true)
        proven = true
        break
      }
    }
    expect(proven).toBe(true)
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
    // Start from the top so the end-of-match scroll into view is really needed.
    await page.evaluate(() => scrollTo(0, 0))
    // Then the design's own fit test (section 2.2): scroll so the HUD is at the top, which keeps the board, Fire and the click targets in view with the In training badge in the header.
    await page.getByTestId('fleet-hud').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY))

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
      if (turnBefore !== 'over' && turnAfter !== 'over') {
        expect(now.board).toEqual(start.board)
        expect(now.fire).toEqual(start.fire)
        expect(now.own).toEqual(start.own)
      }
    }
    await expect(page.getByTestId('result-panel')).toBeVisible()
    await expect(page.getByTestId('result-reason')).toContainText(/sank/)
    // The result panel brings itself into view: no manual scroll is needed to reach the rematch button.
    await expect(page.getByTestId('rematch')).toBeInViewport()
    // The reveal holds the two-board strip.
    await expect(page.getByTestId('fleet-reveal')).toBeVisible()
    await expect(page.getByTestId('fleet-end-theirs-board')).toBeVisible()
    await expect(page.getByTestId('fleet-end-yours-board')).toBeVisible()
    await expect(fire).toBeDisabled()
    expect(hits + misses).toBeGreaterThan(10)
    // The hit/miss feedback marks exist on the board; at the end the whole enemy fleet is shown.
    await expect(page.locator('[data-testid^="fleet-cell-"][data-state="hit"]').first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await page.getByTestId('rematch').click()
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
    // One tap only asks: the match goes on until the confirm is answered.
    await expect(page.getByTestId('result-panel')).toHaveCount(0)
    await expect(page.getByTestId('fleet-resign-yes')).toHaveText('Yes, resign')
    await expect(page.getByTestId('fleet-resign-keep')).toBeInViewport({ ratio: 1 })
    await expect(page.getByTestId('fleet-resign-yes')).toBeInViewport({ ratio: 1 })
    await page.getByTestId('fleet-resign-keep').click()
    await expect(page.getByTestId('result-panel')).toHaveCount(0)
    await expect(page.getByTestId('fleet-fire')).toBeEnabled()
    await expect(page.getByTestId('fleet-resign')).toBeVisible()
    await page.getByTestId('fleet-resign').click()
    await page.getByTestId('fleet-resign-yes').click()
    await expect(page.getByTestId('result-panel')).toContainText('You resigned.')
    await expect(page.getByTestId('fleet-fire')).toBeDisabled()
    await expect(page.getByTestId('fleet-aim-chip')).toBeEmpty()
    await expect(page.getByTestId('fleet-shot-count')).toHaveText('Shot 0')
    await expect(page.getByTestId('fleet-reveal')).toHaveCount(0)
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
