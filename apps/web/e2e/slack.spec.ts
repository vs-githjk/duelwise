import { devices, expect, test, type Locator, type Page } from '@playwright/test'

// Crosscurrent at /play/crosscurrent: the real game page on GameShell, LevelPicker and ResultPanel. A whole match to a result on a phone 360 wide,
// the board never moves by more than 2 px on any frame, nothing overflows sideways at 360, 390 or 1440, every control is at least 44 px (cells
// exempt, like chess squares), a cell needs two taps, a forced pass and an opponent pass behave, a resignation reads as a loss, and a worker that
// cannot load or that dies ends in a visible line with a way out. The page reads a test-only ?moves= list (cell names, or "pass"; dev builds only)
// to reach a known position without playing there; it sets up the first match only.

const URL = '/play/crosscurrent'

const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 15']

/** Eight moves in which the player (dark, moves first) ends with no placement while Pip still has one, so the page owes a forced pass. */
const PASS_POSITION = 'D3,C3,B3,B2,F5,A3,A1,C1'
/** Fifty-two moves of a played-out game: the player is to move with eight empty cells left, so a real result is a few taps away. */
const NEAR_END = 'F5,F4,D3,C4,E3,F6,B3,F2,E2,B4,C5,F1,G5,B2,G7,D6,B5,E6,G1,B6,D2,G4,D7,E1,A7,C7,F7,H5,B1,C6,D8,B8,B7,E7,C3,A4,H6,G6,E8,C8,G3,A2,A3,H2,A1,G2,F3,H1,A8,F8,G8,A6'
/** Fifty-nine moves, the last a real move by the player after which Pip has none: the opponent passes and the player is to move again. */
const OPPONENT_PASS = 'F5,D6,C7,F6,C5,B6,F7,F4,G3,E7,A5,G7,F8,A7,H8,G4,D7,H2,B4,G6,D3,C2,H4,C3,B2,E3,C1,H3,F2,H5,F3,E2,B5,C6,E1,A1,D2,E8,B7,F1,H7,B8,A2,B3,G5,D8,C8,H6,A8,E6,G2,B1,A3,C4,D1,G1,G8,A4,A6'

const cells = (page: Page) => page.locator('[data-testid^="slack-cell-"]')
const legalCells = (page: Page) => page.locator('[data-testid^="slack-cell-"][data-legal]')
const hud = (page: Page) => page.getByTestId('play-hud')
const discs = (page: Page) => page.locator('.sl-disc')

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

/**
 * Records the element's position on every frame, so a shift that undoes itself between two checks still counts. Copied from no-jump.spec.ts.
 * Recording stops when the result card mounts: on a phone the verdict leads the page, above the board, by design (every game does this).
 */
async function watchFrames(locator: Locator) {
  await locator.evaluate((el) => {
    const w = window as unknown as { __tops: number[] }
    w.__tops = []
    const tick = () => {
      if (document.querySelector('[data-testid="result-panel"]')) return
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
      if (document.querySelector('[data-testid="result-panel"]')) return
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

/** Every visible button and link in the game, except the 64 cells, is at least 44 by 44. */
async function expectTargets(page: Page, label: string) {
  const small = await page.evaluate(() => {
    const out: string[] = []
    for (const b of document.querySelectorAll<HTMLElement>('[data-testid="game-shell"] button:not([data-testid^="slack-cell-"]), [data-testid="game-shell"] a[data-testid]')) {
      const r = b.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.width < 43.5 || r.height < 43.5) out.push(`${(b.textContent ?? '').trim().slice(0, 20) || b.dataset.testid} ${Math.round(r.width)}x${Math.round(r.height)}`)
    }
    return out
  })
  expect(small, `${label}: controls under 44 px`).toEqual([])
}

/** One real move: tap the first ringed cell twice (the second tap commits). */
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

/** Opens the page, picks a level and starts. `query` is appended after ?seed=3. */
async function start(page: Page, query = '', level: RegExp = /Pip/) {
  await page.goto(`${URL}?seed=3${query}`)
  await expect(page.getByTestId('slack-setup')).toBeVisible()
  await page.getByTestId('level-picker').getByRole('radio', { name: level }).check()
  await page.getByTestId('slack-start').click()
  await expect(page.getByTestId('slack-board')).toBeVisible()
}

for (const width of [360, 390]) {
  test.describe(`phone ${width}`, () => {
    test.use({ ...iphone, viewport: { width, height: 780 } })

    test('setup, play and the result fit the screen: no sideways scroll, 44 px targets, board inside the screen', async ({ page }) => {
      test.setTimeout(90_000)
      await page.goto(`${URL}?seed=3`)
      await expectNoOverflow(page, 'setup')
      await expectTargets(page, 'setup')
      await page.getByTestId('slack-start').click()
      const board = page.getByTestId('slack-board')
      await expect(board).toBeVisible()
      await expect(page.getByTestId('slack-status')).toHaveText('Move 1')
      await board.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await page.waitForTimeout(300)
      await expectNoOverflow(page, 'in play')
      await expectTargets(page, 'in play')
      const box = (await board.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      expect(Math.round(box.width)).toBe(width - 32)
      await page.getByTestId('slack-resign').click()
      await expectTargets(page, 'resign confirm')
      await page.getByTestId('slack-resign-yes').click()
      await expect(page.getByTestId('result-panel')).toBeVisible()
      await expectNoOverflow(page, 'result')
      await expectTargets(page, 'result')
    })
  })
}

test.describe('desktop 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('the board is 520 wide with the agent card beside it, and the result sits beside the board', async ({ page }) => {
    test.setTimeout(90_000)
    await start(page)
    await expectNoOverflow(page, 'in play')
    const board = (await page.getByTestId('slack-board').boundingBox())!
    expect(Math.round(board.width)).toBe(520)
    const card = (await page.getByTestId('agent-card').boundingBox())!
    expect(card.x).toBeGreaterThan(board.x + board.width - 1)
    await page.getByTestId('slack-resign').click()
    await page.getByTestId('slack-resign-yes').click()
    const panel = (await page.getByTestId('result-panel').boundingBox())!
    expect(panel.x).toBeGreaterThan(board.x + board.width - 1)
    await expectNoOverflow(page, 'result')
    await expectTargets(page, 'result')
  })
})

test.describe('Crosscurrent on a phone', () => {
  test.use({ ...iphone, viewport: { width: 360, height: 780 } })

  test('is a real game: listed in /play, opens at /play/crosscurrent on the site shell, with no dev copy and a sound control', async ({ page }) => {
    await page.goto('/play')
    const card = page.getByTestId('game-card-slack')
    await expect(card.getByRole('heading', { name: 'Crosscurrent' })).toBeVisible()
    await expect(page.getByTestId('tile-art-slack')).toBeVisible()
    await card.getByRole('link', { name: 'Play' }).click()
    await expect(page).toHaveURL(/\/play\/crosscurrent$/)
    await expect(page.getByTestId('game-shell')).toHaveAttribute('data-game', 'slack')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Crosscurrent')
    await expect(page.getByTestId('slack-setup')).toBeVisible()
    await expect(page.getByTestId('game-sound-button')).toBeVisible()
    await expect(page.locator('body')).not.toContainText('(dev)')
    await expect(page.locator('body')).not.toContainText(/dev only|groundwork/i)
    await expect(page.getByTestId('game-leaderboard-link')).toBeVisible()
  })

  test('its leaderboard and agent pages open and name Crosscurrent', async ({ page }) => {
    for (const path of ['/leaderboard/crosscurrent', '/agents/crosscurrent']) {
      const res = await page.goto(path)
      expect(res!.status(), path).toBe(200)
      // Let the page finish its own client navigation before the next goto, or WebKit reports the next one as interrupted.
      await page.waitForLoadState('networkidle')
      await expect(page).toHaveURL(new RegExp(`${path}$`))
      await expect(page.locator('body')).toContainText('Crosscurrent')
      await expect(page.locator('body')).not.toContainText(/not found/i)
    }
    // The agents page says plainly that every level is still in training and the opponent is a program with nothing to train.
    await expect(page.locator('body')).toContainText(/scripted|search/i)
  })

  test('Rated is shut with the reason and Practice is picked, so no match can count for a record nothing checks', async ({ page }) => {
    await page.goto(URL)
    const mode = page.getByTestId('play-mode')
    await expect(mode).toHaveAttribute('data-mode', 'practice')
    await expect(page.locator('[data-mode-option="rated"] input')).toBeDisabled()
    await expect(page.locator('[data-mode-option="rated"]')).toContainText('Not open yet')
    await expect(page.locator('[data-mode-option="practice"] input')).toBeChecked()
    // The four levels are the four personas, each with its own line; none shows a strength number.
    for (const [level, name, line] of [['easy', 'Pip', /most discs it can/], ['medium', 'Marlow', /squares matter/], ['hard', 'Vesper', /few moves ahead/], ['champion', 'Sable', /endgame/]] as const) {
      const row = page.locator(`[data-persona="${level}"]`)
      await expect(row).toContainText(name)
      await expect(row).toContainText(line)
      await expect(row).toContainText('In training')
      await expect(row).not.toContainText(/site Elo/i)
    }
    await expect(page.getByTestId('slack-start')).toContainText('Start match vs Pip')
    // A match started from here is a Practice match: the header says so and the result says so.
    await page.getByTestId('slack-start').click()
    await expect(page.getByTestId('practice-badge')).toBeVisible()
    await page.getByTestId('slack-resign').click()
    await page.getByTestId('slack-resign-yes').click()
    await expect(page.getByTestId('result-practice')).toHaveText('Practice, not rated')
    await expect(page.getByTestId('result-leaderboard-link')).toHaveCount(0)
  })

  test('How to play lists arrows and keyboard play and the rules', async ({ page }) => {
    await page.goto(URL)
    await page.getByRole('button', { name: 'How to play' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('How to play Crosscurrent')
    await expect(dialog).toContainText('Arrow keys')
    await expect(dialog).toContainText('Enter or Space')
    await expect(dialog).toContainText('ring')
    await expect(dialog).toContainText('pass')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('a whole match at 360: board still, no overflow, 44 px targets, two taps to place, then the result card and a replayable record', async ({ page }) => {
    test.setTimeout(240_000)
    const errors = watchConsole(page)
    await page.goto(`${URL}?seed=3`)
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
    await expect(discs(page)).toHaveCount(4)

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
    await expectNoFrameShift(page, 'slack whole match')
    await expectNoScreenShift(page, 'slack whole match')
    const panel = page.getByTestId('result-panel')
    await expect(panel).toBeVisible()
    const outcome = await panel.getAttribute('data-outcome')
    expect(['win', 'loss', 'draw']).toContain(outcome)
    // The verdict is the display-size headline, not the smallest line on the page.
    const headline = page.getByTestId('result-headline')
    await expect(headline).toHaveText(outcome === 'win' ? /You beat Pip/ : outcome === 'loss' ? /Pip took it/ : /A draw with Pip/)
    const headlinePx = await headline.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    const statusPx = await status.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    expect(headlinePx).toBeGreaterThanOrEqual(statusPx * 1.75)
    await expect(page.getByTestId('result-reason')).toHaveText(outcome === 'draw' ? /same number of discs/ : /finished with more discs/)
    await expect(page.getByTestId('slack-final-count')).toHaveText(/^Final discs: You \d+, Pip \d+\.$/)
    // The count on the card is the count on the board.
    const counts = await page.evaluate(() => ({
      you: document.querySelectorAll('.sl-disc[data-owner="you"]').length,
      them: document.querySelectorAll('.sl-disc[data-owner="them"]').length,
    }))
    await expect(page.getByTestId('slack-final-count')).toHaveText(`Final discs: You ${counts.you}, Pip ${counts.them}.`)
    const record = page.getByTestId('slack-record')
    await expect(record).toHaveAttribute('data-record-ok', 'true')
    await expect(record).toHaveAttribute('data-final-hash', /^[0-9a-f]{16}$/)
    await expectNoOverflow(page, 'result')
    await expectTargets(page, 'result')
    expect(errors).toEqual([])
    // Rematch starts a fresh board against the same opponent; Change level goes back to the picker.
    await page.getByTestId('rematch').click()
    await expect(page.getByTestId('result-panel')).toHaveCount(0)
    await expect(discs(page)).toHaveCount(4)
    await expect(status).toHaveText('Move 1')
  })

  test('a forced pass for the player does not move the board', async ({ page }) => {
    test.setTimeout(60_000)
    await start(page, `&moves=${PASS_POSITION}`)
    const board = page.getByTestId('slack-board')
    await expect(discs(page)).toHaveCount(12)
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

  test('after Pip has to pass, the ring stays on the last disc placed and nothing flips again', async ({ page }) => {
    test.setTimeout(60_000)
    await start(page, `&moves=${OPPONENT_PASS}`)
    await expect(page.getByTestId('slack-live')).toContainText('Pip had no move and passed.', { timeout: 20_000 })
    await expect(hud(page)).toHaveAttribute('data-turn', 'you')
    await expect(page.getByTestId('slack-status')).toHaveText('Pip has no move. Your turn again.')
    // The last disc placed was the player's own move before the pass: it keeps its ring, and no disc is animating or marked as just placed or flipped.
    await expect(page.locator('.sl-disc[data-last]')).toHaveCount(1)
    await expect(page.locator('.sl-disc[data-last]')).toHaveAttribute('data-owner', 'you')
    await expect(page.locator('.sl-disc[data-flip], .sl-disc[data-placed]')).toHaveCount(0)
    const lastCell = await page.locator('.sl-disc[data-last]').evaluate((el) => el.closest('button')!.getAttribute('data-cell'))
    expect(lastCell).toBe('A6')
    // Then the player's next move moves the ring to it.
    await playOne(page)
    await expect(page.locator('.sl-disc[data-last]')).toHaveCount(1)
  })

  test('a resignation reads as a loss through the result card, never as a disc count of an unfinished board', async ({ page }) => {
    await start(page)
    await playOne(page)
    await expect(hud(page)).toHaveAttribute('data-turn', 'you', { timeout: 20_000 })
    await expect(page.getByTestId('slack-status')).toHaveText('Move 3')
    await page.getByTestId('slack-resign').click()
    await page.getByTestId('slack-resign-yes').click()
    const panel = page.getByTestId('result-panel')
    await expect(panel).toHaveAttribute('data-outcome', 'loss')
    await expect(page.getByTestId('result-headline')).toHaveText('Pip took it.')
    await expect(page.getByTestId('result-reason')).toHaveText('You resigned.')
    await expect(page.getByTestId('result-chip')).toHaveText('Loss')
    await expect(page.getByTestId('slack-final-count')).toHaveCount(0)
    await expect(page.getByTestId('result-headline')).not.toContainText(/You \d+/)
    await expect(page.getByTestId('slack-status')).toHaveText('You resigned.')
    await expect(page.getByTestId('slack-live')).toHaveText('You resigned.')
    await expect(hud(page)).toHaveAttribute('data-turn', 'over')
    await expect(page.getByTestId('slack-action')).toHaveCount(0)
  })

  test('keyboard play: arrows move between cells, Enter picks, Enter again places, Home and End jump along the row', async ({ page }) => {
    await start(page)
    const legal = await legalCells(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!))
    // The first legal cell holds the tab stop and the focus after Start.
    await expect(page.getByTestId(legal[0]!)).toBeFocused()
    await page.keyboard.press('ArrowRight')
    const idx = Number(legal[0]!.replace('slack-cell-', ''))
    await expect(page.getByTestId(`slack-cell-${idx + 1}`)).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId(`slack-cell-${idx}`)).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId(`slack-cell-${idx + 8}`)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Home')
    await expect(page.getByTestId(`slack-cell-${Math.floor(idx / 8) * 8}`)).toBeFocused()
    await page.keyboard.press('End')
    await expect(page.getByTestId(`slack-cell-${Math.floor(idx / 8) * 8 + 7}`)).toBeFocused()
    // Pick and place a legal cell from the keyboard alone.
    await page.getByTestId(legal[0]!).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId(legal[0]!)).toHaveAttribute('data-selected', '')
    await expect(page.getByTestId('slack-status')).toHaveText('Move 1')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('slack-live')).toContainText('You placed at')
    await expect(page.getByTestId('slack-live')).toContainText('Pip', { timeout: 20_000 })
  })

  test('reduced motion: discs land in their end state, no animation runs, and the result is right', async ({ page }) => {
    test.setTimeout(90_000)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await start(page, `&moves=${NEAR_END}`)
    await expect(discs(page)).toHaveCount(56)
    await expect(hud(page)).toHaveAttribute('data-turn', 'you')
    await playOne(page)
    // Right after the move: the changed discs exist, with no animation attached to them.
    await expect(page.locator('.sl-disc[data-flip]').first()).toBeAttached()
    const names = await page.locator('.sl-disc[data-flip], .sl-disc[data-placed]').evaluateAll((els) => els.map((e) => getComputedStyle(e).animationName))
    expect(names.length).toBeGreaterThan(0)
    expect(names.every((n) => n === 'none')).toBe(true)
    await playToEnd(page, 60_000)
    const text = await page.getByTestId('slack-final-count').innerText()
    const [, you, them] = /^Final discs: You (\d+), \w+ (\d+)\.$/.exec(text)!.map(Number) as [number, number, number]
    const owned = await page.evaluate(() => ({
      you: document.querySelectorAll('.sl-disc[data-owner="you"]').length,
      them: document.querySelectorAll('.sl-disc[data-owner="them"]').length,
      running: document.getAnimations().filter((a) => a.playState === 'running' && (a.effect as KeyframeEffect | null)?.target?.classList.contains('sl-disc')).length,
    }))
    expect(owned.you).toBe(you)
    expect(owned.them).toBe(them)
    expect(owned.running).toBe(0)
    await expect(page.getByTestId('result-panel')).toBeVisible()
  })

  test('reduced motion: the board never jumps on any frame from the first frame of a match, nor when the first reply lands', async ({ page }) => {
    test.setTimeout(60_000)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(`${URL}?seed=3`)
    // Watch from before Start is tapped: every frame from the board's first paint is recorded.
    await page.evaluate(() => {
      const w = window as unknown as { __first: number[]; __stop: boolean }
      w.__first = []
      w.__stop = false
      const tick = () => {
        const b = document.querySelector('[data-testid="slack-board"]')
        if (b) w.__first.push(b.getBoundingClientRect().top + window.scrollY)
        if (!w.__stop) requestAnimationFrame(tick)
      }
      tick()
    })
    // The page's own title does not change size or place when the match starts (the dev page shrank its heading, which moved everything below it).
    const title = page.getByRole('heading', { level: 1 })
    const titleBefore = (await title.boundingBox())!
    await page.getByTestId('slack-start').click()
    await expect(page.getByTestId('slack-board')).toBeVisible()
    const titleAfter = (await title.boundingBox())!
    expect(Math.abs(titleAfter.y - titleBefore.y)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(titleAfter.height - titleBefore.height)).toBeLessThanOrEqual(0.5)
    await playOne(page)
    await expect(page.getByTestId('slack-live')).toContainText('Pip', { timeout: 20_000 })
    await page.waitForTimeout(300)
    const tops = await page.evaluate(() => {
      const w = window as unknown as { __first: number[]; __stop: boolean }
      w.__stop = true
      return w.__first
    })
    expect(tops.length).toBeGreaterThan(10)
    // Between consecutive frames the board never moves by more than 2 px. (Its place on the page is its own: the first frames after it mounts count.)
    const worst = Math.max(...tops.slice(1).map((t, i) => Math.abs(t - tops[i]!)))
    expect(worst, 'largest frame-to-frame move of the board').toBeLessThanOrEqual(2)
  })

  test('after a result, Change level returns to the picker and a new match starts the chosen persona', async ({ page }) => {
    await start(page)
    await page.getByTestId('slack-resign').click()
    await page.getByTestId('slack-resign-yes').click()
    await page.getByRole('button', { name: 'Change level' }).click()
    await expect(page.getByTestId('slack-setup')).toBeVisible()
    // The Start button is pinned to the bottom of a phone screen, so the row is centred first, as a thumb would.
    await page.locator('[data-persona="hard"]').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.locator('[data-persona="hard"]').click()
    await expect(page.locator('[data-persona="hard"] input')).toBeChecked()
    await page.getByTestId('slack-start').click()
    await expect(hud(page)).toContainText('Vesper')
    await expect(page.getByTestId('agent-card')).toContainText('Vesper, Hard')
    await expect(page.getByTestId('slack-status')).toHaveText('Move 1')
    await expect(discs(page)).toHaveCount(4)
    await expect(page.getByTestId('result-panel')).toHaveCount(0)
  })

  test('a reload mid-match lands on a clean setup with no stuck match and no error', async ({ page }) => {
    const errors = watchConsole(page)
    await start(page)
    await playOne(page)
    await page.reload()
    await expect(page.getByTestId('slack-setup')).toBeVisible()
    await expect(page.getByTestId('slack-start')).toBeEnabled()
    await expect(page.getByTestId('result-panel')).toHaveCount(0)
    // A reload cancels whatever the dev server was still sending; Vite prints that as an error line in dev only, and it is not the page's.
    expect(errors.filter((e) => !/Failed to load resource|net::|\[vite\] Internal Server Error\s+aborted/.test(e))).toEqual([])
  })

  test('a worker that cannot load ends in a visible line and the start can be tried again', async ({ page }) => {
    await page.route(/\/games\/slack\/worker\.ts/, (route) => route.abort())
    await page.goto(`${URL}?seed=3`)
    await page.getByTestId('slack-start').click()
    const failure = page.getByTestId('slack-failure')
    await expect(failure).toContainText('The opponent could not start', { timeout: 30_000 })
    await expect(failure).toContainText('try again')
    // Nothing is left waiting: the setup is back and Start works again once the script can load.
    await expect(page.getByTestId('slack-setup')).toBeVisible()
    await expect(page.getByTestId('slack-start')).toBeEnabled()
    await page.unroute(/\/games\/slack\/worker\.ts/)
    await page.getByTestId('slack-start').click()
    await expect(page.getByTestId('slack-board')).toBeVisible()
    await expect(page.getByTestId('slack-status')).toHaveText('Move 1')
    await expect(page.getByTestId('slack-failure')).toHaveCount(0)
  })

  test('a worker that dies mid-match shows the stopped line at once, with Back to setup as the way out', async ({ page }) => {
    // The first request the page sends the worker after the opening reset is answered by a worker error instead of a move.
    await page.addInitScript(() => {
      const original = Worker.prototype.postMessage
      Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<Worker['postMessage']>) {
        const d = args[0] as { type?: string } | undefined
        if (d && d.type === 'act') {
          setTimeout(() => this.dispatchEvent(new ErrorEvent('error', { message: 'crashed' })), 20)
          return
        }
        return original.apply(this, args)
      } as typeof Worker.prototype.postMessage
    })
    await start(page)
    await playOne(page)
    const failure = page.getByTestId('slack-failure')
    await expect(failure).toContainText('The opponent stopped', { timeout: 10_000 })
    await expect(page.getByRole('button', { name: 'Back to setup' })).toBeVisible()
    await page.getByRole('button', { name: 'Back to setup' }).click()
    await expect(page.getByTestId('slack-setup')).toBeVisible()
  })

  test('the sound effects switch in the game header persists across a reload', async ({ page }) => {
    await page.goto(URL)
    await page.getByTestId('game-sound-button').click()
    const sfx = page.getByTestId('game-sound-panel').getByTestId('sfx-switch')
    await expect(sfx).toBeChecked()
    await sfx.uncheck()
    await page.reload()
    await page.getByTestId('game-sound-button').click()
    await expect(page.getByTestId('game-sound-panel').getByTestId('sfx-switch')).not.toBeChecked()
  })
})
