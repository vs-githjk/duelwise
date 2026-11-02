import { devices, expect, test, type Locator, type Page } from '@playwright/test'

// Slackwater at /dev/slack, on a phone 360 wide: a whole match to a result, the board never moves by more than 2 px on any frame, nothing
// overflows sideways, every control is at least 44 px (cells exempt, like chess squares), a cell needs two taps, and reduced motion keeps the
// end state. The dev page reads a test-only ?moves= list (cell names, or "pass") to reach a known position without playing there; it sets up the first match only.

const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 15']
test.use({ ...iphone, viewport: { width: 360, height: 780 } })

/** Eight moves in which the player (dark, moves first) ends with no placement while Pip still has one, so the page owes a forced pass. */
const PASS_POSITION = 'D3,C3,B3,B2,F5,A3,A1,C1'
/** Fifty-two moves of a played-out game: the player is to move with eight empty cells left, so a real result is a few taps away. */
const NEAR_END = 'F5,F4,D3,C4,E3,F6,B3,F2,E2,B4,C5,F1,G5,B2,G7,D6,B5,E6,G1,B6,D2,G4,D7,E1,A7,C7,F7,H5,B1,C6,D8,B8,B7,E7,C3,A4,H6,G6,E8,C8,G3,A2,A3,H2,A1,G2,F3,H1,A8,F8,G8,A6'

const cells = (page: Page) => page.locator('[data-testid^="slack-cell-"]')
const legalCells = (page: Page) => page.locator('[data-testid^="slack-cell-"][data-legal]')
const hud = (page: Page) => page.getByTestId('play-hud')

/** Records the element's position on every frame, so a shift that undoes itself between two checks still counts. Copied from no-jump.spec.ts. */
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

/** The same, but the top on the screen alone (no scrollY added), so a page that scrolls under the board is caught. */
async function watchScreen(locator: Locator) {
  await locator.evaluate((el) => {
    const w = window as unknown as { __screen: number[] }
    w.__screen = []
    const tick = () => {
      w.__screen.push(el.getBoundingClientRect().top)
      requestAnimationFrame(tick)
    }
    tick()
  })
}
async function expectNoScreenShift(page: Page, label: string) {
  const tops = await page.evaluate(() => (window as unknown as { __screen: number[] }).__screen)
  expect(tops.length, `${label}: screen frames were recorded`).toBeGreaterThan(10)
  expect(Math.max(...tops) - Math.min(...tops), `${label}: moved on screen during a frame`).toBeLessThanOrEqual(2)
}

async function expectNoOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, x: window.scrollX }))
  expect(w.scroll, `${label}: page is wider than the screen`).toBeLessThanOrEqual(w.client)
  expect(w.x, `${label}: page scrolled sideways`).toBe(0)
}

/** Every visible button on the page, except the 64 cells, is at least 44 by 44. */
async function expectTargets(page: Page, label: string) {
  const small = await page.evaluate(() => {
    const out: string[] = []
    for (const b of document.querySelectorAll<HTMLElement>('[data-testid="slack-page"] button:not([data-testid^="slack-cell-"])')) {
      const r = b.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.width < 43.5 || r.height < 43.5) out.push(`${(b.textContent ?? '').trim().slice(0, 20) || b.dataset.testid} ${Math.round(r.width)}x${Math.round(r.height)}`)
    }
    return out
  })
  expect(small, `${label}: controls under 44 px`).toEqual([])
}

/** Remembers every message the page posts to a Worker, so a spec can see that a level reset was sent. */
async function recordWorkerPosts(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __posts: Array<{ type: string; level?: string }> }
    w.__posts = []
    const original = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<Worker['postMessage']>) {
      const d = args[0] as { type?: string; level?: string } | undefined
      if (d && d.type === 'reset') w.__posts.push({ type: d.type, level: d.level })
      return original.apply(this, args)
    } as typeof Worker.prototype.postMessage
  })
}
const resets = (page: Page) => page.evaluate(() => (window as unknown as { __posts: Array<{ level?: string }> }).__posts.map((p) => p.level))

/** One real move: tap the first ringed cell twice (the second tap commits), then wait for the opponent's reply. */
async function playOne(page: Page) {
  const cell = legalCells(page).first()
  await cell.click()
  await expect(cell).toHaveAttribute('data-selected', '')
  await cell.click()
}

/** Plays the player's side until the match is over: a ringed cell when there is one, otherwise it waits (the opponent, or a forced pass). */
async function playToEnd(page: Page, budgetMs: number) {
  const until = Date.now() + budgetMs
  for (;;) {
    if (Date.now() > until) throw new Error('the match did not finish in time')
    const turn = await hud(page).getAttribute('data-turn')
    if (turn === 'over') return
    if (turn === 'you' && (await legalCells(page).count()) > 0) {
      await playOne(page)
      await page.waitForTimeout(80)
    } else {
      await page.waitForTimeout(120)
    }
  }
}

async function start(page: Page, query: string) {
  await page.goto(`/dev/slack?seed=3${query}`)
  await page.getByTestId('slack-start').click()
  await expect(page.getByTestId('slack-board')).toBeVisible()
}

test('a whole match at 360: board still, no overflow, 44 px targets, two taps to place', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto('/dev/slack?seed=3')
  await expectNoOverflow(page, 'before start')
  await expectTargets(page, 'before start')
  await page.getByTestId('slack-start').click()
  const board = page.getByTestId('slack-board')
  const status = page.getByTestId('slack-status')
  const live = page.getByTestId('slack-live')
  await expect(status).toHaveText('Move 1')
  await expect(hud(page)).toHaveAttribute('data-turn', 'you')
  await board.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(300)
  await expectNoOverflow(page, 'in play')
  await expectTargets(page, 'in play')
  // The resign confirm row: both of its buttons are measured, then Keep playing puts the row back.
  await page.getByTestId('slack-resign').click()
  await expectTargets(page, 'confirm')
  await expectNoOverflow(page, 'confirm')
  await page.getByRole('button', { name: 'Keep playing' }).click()
  await expect(page.getByTestId('slack-resign')).toBeVisible()
  await watchFrames(board)
  await watchScreen(board)

  // One tap never plays: it only selects. A tap on a cell with no ring does nothing at all.
  const first = legalCells(page).first()
  const firstLabel = await first.getAttribute('aria-label')
  await first.click()
  await expect(first).toHaveAttribute('data-selected', '')
  await page.waitForTimeout(700)
  await expect(status).toHaveText('Move 1')
  await expect(live).toHaveText('')
  await expect(first).toHaveAttribute('aria-label', firstLabel!)
  await expect(page.getByTestId('slack-action')).toBeEnabled()
  const blocked = cells(page).filter({ hasNot: page.locator('.sl-disc') }).and(page.locator(':not([data-legal])')).first()
  await blocked.click({ force: true })
  await page.waitForTimeout(700)
  await expect(first).toHaveAttribute('data-selected', '')
  await expect(status).toHaveText('Move 1')
  await expect(live).toHaveText('')
  await expect(page.locator('.sl-disc')).toHaveCount(4)

  // Move 1 by the Place button; its flip and the agent's reply are on screen, and the board has not moved.
  await page.getByTestId('slack-action').click()
  await expect(live).toContainText('You placed at')
  await expect(page.locator('.sl-disc[data-flip]').first()).toBeAttached()
  await expect(live).toContainText('Pip', { timeout: 20_000 })
  await expect(hud(page)).toHaveAttribute('data-turn', 'you')
  // Moves 2 and 3 by two taps.
  for (let n = 2; n <= 3; n++) {
    await playOne(page)
    await expect(status).toHaveText(`Move ${n * 2}`, { timeout: 20_000 })
    await expect(hud(page)).toHaveAttribute('data-turn', 'you')
  }

  // The rest of the match, still watched frame by frame, through the result.
  await playToEnd(page, 180_000)
  await expect(page.getByTestId('slack-result')).toContainText(/^You \d+, Pip \d+$/)
  await expect(page.getByTestId('slack-action')).toHaveText('Play again')
  await expectNoFrameShift(page, 'slack whole match')
  await expectNoScreenShift(page, 'slack whole match')
  await expectNoOverflow(page, 'result')
  await expectTargets(page, 'result')
})

test('a forced pass for the player does not move the board', async ({ page }) => {
  test.setTimeout(60_000)
  await start(page, `&moves=${PASS_POSITION}`)
  const board = page.getByTestId('slack-board')
  await expect(page.locator('.sl-disc')).toHaveCount(12)
  await expect(page.getByTestId('slack-status')).toHaveText('No move for you. Pip plays again.')
  await expect(legalCells(page)).toHaveCount(0)
  await board.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(300)
  await watchFrames(board)
  await watchScreen(board)
  // The page sends the pass itself after a beat, then Pip replies, then the turn is back.
  await expect(page.getByTestId('slack-live')).toContainText('You had no move and passed.')
  await expect(page.getByTestId('slack-live')).toContainText('Pip placed at', { timeout: 20_000 })
  await expect(hud(page)).toHaveAttribute('data-turn', 'you')
  await page.waitForTimeout(400)
  await expectNoFrameShift(page, 'slack forced pass')
  await expectNoScreenShift(page, 'slack forced pass')
  await expectNoOverflow(page, 'pass')
})

test('reduced motion: discs land in their end state, no animation runs, the result is right', async ({ page }) => {
  test.setTimeout(90_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await start(page, `&moves=${NEAR_END}`)
  await expect(page.locator('.sl-disc')).toHaveCount(56)
  await expect(hud(page)).toHaveAttribute('data-turn', 'you')
  await playOne(page)
  // Right after the move: the changed discs exist, with no animation attached to them.
  const flipped = page.locator('.sl-disc[data-flip]').first()
  await expect(flipped).toBeAttached()
  const names = await page.locator('.sl-disc[data-flip], .sl-disc[data-placed]').evaluateAll((els) => els.map((e) => getComputedStyle(e).animationName))
  expect(names.length).toBeGreaterThan(0)
  expect(names.every((n) => n === 'none')).toBe(true)
  await playToEnd(page, 60_000)
  const result = await page.getByTestId('slack-result').innerText()
  const [, you, them] = /^You (\d+), \w+ (\d+)$/.exec(result)!.map(Number) as [number, number, number]
  const owned = await page.evaluate(() => ({
    you: document.querySelectorAll('.sl-disc[data-owner="you"]').length,
    them: document.querySelectorAll('.sl-disc[data-owner="them"]').length,
    running: document.getAnimations().filter((a) => a.playState === 'running' && (a.effect as KeyframeEffect | null)?.target?.classList.contains('sl-disc')).length,
  }))
  expect(owned.you).toBe(you)
  expect(owned.them).toBe(them)
  expect(owned.running).toBe(0)
  await expect(page.getByTestId('slack-action')).toHaveText('Play again')
})

test('after a result, tapping another level keeps the result and board; Play again starts that persona', async ({ page }) => {
  test.setTimeout(90_000)
  await recordWorkerPosts(page)
  await start(page, `&moves=${NEAR_END}`)
  await expect(page.locator('.sl-disc')).toHaveCount(56)
  await expect(hud(page)).toHaveAttribute('data-turn', 'you')
  expect(await resets(page)).toEqual(['easy'])
  await playToEnd(page, 60_000)
  const result = page.getByTestId('slack-result')
  await expect(result).toBeVisible()
  const resultText = await result.innerText()
  const boardBefore = await cells(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  const hudBefore = await hud(page).innerText()
  expect(hudBefore).toContain('Pip')

  const other = page.getByTestId('slack-level-hard')
  const name = (await other.innerText()).trim().split(/\s+/)[0]!
  expect(name).not.toBe('Pip')
  await other.click()
  await expect(other).toHaveAttribute('aria-checked', 'true')
  // Only the choice is stored: the finished match, its card and its HUD stay, and no new worker was started.
  await expect(result).toHaveText(resultText)
  expect(await cells(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(boardBefore)
  expect(await hud(page).innerText()).toBe(hudBefore)
  await expect(hud(page)).toHaveAttribute('data-turn', 'over')
  expect(await resets(page)).toEqual(['easy'])

  await page.getByTestId('slack-action').click()
  await expect(hud(page)).toContainText(name)
  await expect(hud(page)).not.toContainText('Pip')
  await expect(page.getByTestId('slack-status')).toHaveText('Move 1')
  await expect(page.locator('.sl-disc')).toHaveCount(4)
  await expect(page.getByTestId('slack-result')).toHaveCount(0)
  expect(await resets(page)).toEqual(['easy', 'hard'])
  await expectNoOverflow(page, 'new match')
})
