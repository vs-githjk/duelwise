import { devices, expect, test, type Locator, type Page } from '@playwright/test'

// On a phone the page must not move while a match goes on: a player who scrolled the board into view stays exactly there across their own moves
// and the AI's replies (a scrollIntoView on the chess move list used to drag the page down to it after every move).

const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 15']
test.use({ ...iphone, viewport: { width: 393, height: 852 } })

const spot = (page: Page, board: Locator) => board.evaluate((el) => ({ y: window.scrollY, x: window.scrollX, top: el.getBoundingClientRect().top }))

async function bringIntoView(page: Page, board: Locator) {
  await board.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(400)
  return spot(page, board)
}
/** Records the element's position on every frame, so a shift that undoes itself between two checks (a line that appears while the AI thinks) still counts. */
async function watchFrames(locator: Locator) {
  await locator.evaluate((el) => {
    const w = window as unknown as { __tops: number[] }
    w.__tops = []
    const tick = () => {
      w.__tops.push(el.getBoundingClientRect().top + window.scrollY)
      requestAnimationFrame(tick)
    }
    tick()
  })
}
async function expectNoFrameShift(page: Page, label: string) {
  const tops = await page.evaluate(() => (window as unknown as { __tops: number[] }).__tops)
  expect(tops.length, `${label}: frames were recorded`).toBeGreaterThan(10)
  expect(Math.max(...tops) - Math.min(...tops), `${label}: moved during a frame`).toBeLessThanOrEqual(2)
}
async function expectStill(page: Page, board: Locator, start: { y: number; x: number; top: number }, label: string) {
  const now = await spot(page, board)
  expect(Math.abs(now.y - start.y), `${label}: scrollY moved`).toBeLessThanOrEqual(2)
  expect(Math.abs(now.x - start.x), `${label}: scrollX moved`).toBeLessThanOrEqual(2)
  expect(Math.abs(now.top - start.top), `${label}: board moved on screen`).toBeLessThanOrEqual(2)
}

test('chess: the board stays put across three moves and the replies', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/play/chess?seed=3')
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  const board = page.getByTestId('chess-board')
  await expect(board).toHaveAttribute('data-turn', 'you', { timeout: 90_000 })
  const start = await bringIntoView(page, board)
  await watchFrames(board)
  let plies = 0
  for (const [from, to] of [['e2', 'e4'], ['d2', 'd4'], ['c2', 'c4']] as const) {
    await page.getByTestId(`sq-${from}`).click()
    await page.getByTestId(`sq-${to}`).click()
    plies += 2
    await expect(board).toHaveAttribute('data-plies', String(plies), { timeout: 60_000 })
    await expect(board).toHaveAttribute('data-turn', 'you')
    await page.waitForTimeout(300)
    await expectStill(page, board, start, `chess after ${plies} plies`)
  }
  await expectNoFrameShift(page, 'chess')
})

test('four in a row: the board stays put across three drops and the replies', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/play/four-in-a-row?seed=3')
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  const board = page.getByTestId('four-board')
  await expect(board).toHaveAttribute('data-turn', 'you')
  const start = await bringIntoView(page, board)
  await watchFrames(board)
  for (let i = 0; i < 3; i++) {
    await expect(board).not.toHaveAttribute('data-settling', 'true')
    const col = await page.locator('[data-testid^="col-"]:not([aria-disabled="true"])').first().getAttribute('data-testid')
    await page.getByTestId(col!).click()
    await expect(board).toHaveAttribute('data-turn', /you|over/, { timeout: 30_000 })
    await expect(board).not.toHaveAttribute('data-settling', 'true')
    await expectStill(page, board, start, `four after drop ${i + 1}`)
  }
  await expectNoFrameShift(page, 'four')
})

test("hold'em: the table stays put across three actions", async ({ page }) => {
  test.setTimeout(120_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/play/heads-up-holdem?seed=3')
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  const table = page.getByTestId('holdem-table')
  await expect(table).toHaveAttribute('data-turn', /you|over/, { timeout: 30_000 })
  const start = await bringIntoView(page, table)
  await watchFrames(table)
  for (let i = 0; i < 3; i++) {
    await expect(table).toHaveAttribute('data-turn', 'you', { timeout: 30_000 })
    const go = page.getByRole('button', { name: /^(Check|Call)/ }).first()
    await go.click()
    await page.waitForTimeout(1500)
    await expectStill(page, table, start, `holdem after action ${i + 1}`)
  }
  await expectNoFrameShift(page, 'holdem')
})

test('word duel: the ledger stays put across three guesses', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/play/word-duel?seed=2')
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  const ledger = page.getByTestId('word-ledger')
  await expect(page.getByTestId('word-input')).toBeVisible()
  // The guess box is where the player looks and types, so it is the one brought into view; the ledger above it grows a row per guess and the
  // page must not scroll to follow (the box is already on screen, so nothing needs revealing).
  await bringIntoView(page, page.getByTestId('word-input'))
  const start = await spot(page, ledger)
  for (const w of ['crane', 'slate', 'house']) {
    await page.getByTestId('word-input').fill(w)
    await page.getByTestId('word-input').press('Enter')
    await page.waitForTimeout(900)
    await expectStill(page, ledger, start, `word after ${w}`)
  }
})

test('stormglass: the board and the Fire bar stay put on every frame across six shots and the replies', async ({ page }) => {
  test.setTimeout(150_000)
  // The opponent's pause is left at its real default, so the "thinking" and "fired at" lines come and go while the page is watched.
  await page.goto('/play/stormglass')
  await page.getByTestId('fleet-ready').click()
  const root = page.getByTestId('fleet-page')
  await expect(root).toHaveAttribute('data-turn', 'you')
  const board = page.getByTestId('fleet-cell-board')
  const fire = page.getByTestId('fleet-fire')
  const start = await bringIntoView(page, board)
  const fireStart = await spot(page, fire)
  await watchFrames(board)
  for (let i = 0; i < 6; i++) {
    await expect(root).toHaveAttribute('data-turn', /you|over/, { timeout: 30_000 })
    if ((await root.getAttribute('data-turn')) === 'over') break
    const cell = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').first()
    const id = (await cell.getAttribute('data-testid'))!
    await cell.click()
    await cell.click()
    await expect(page.getByTestId(id)).not.toHaveAttribute('data-state', 'open')
    await expect(root).toHaveAttribute('data-turn', /you|over/, { timeout: 30_000 })
    await expectStill(page, board, start, `fleet after shot ${i + 1}`)
    await expectStill(page, fire, fireStart, `fleet fire bar after shot ${i + 1}`)
  }
  await expectNoFrameShift(page, 'fleet')
})
