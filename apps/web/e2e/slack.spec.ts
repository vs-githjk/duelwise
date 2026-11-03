import { devices, expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishedLevels } from './published-levels'

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

// On a laptop the board is as large as the screen allows: the whole board, the Place bar and the HUD stay on screen without scrolling. The size comes
// from the height (the column is wider than any height here allows); a phone and a tablet keep the 520 cap.
for (const [vw, vh, minBoard] of [[1280, 800, 560], [1440, 900, 640], [1920, 1080, 660]] as const) {
  test.describe(`desktop ${vw} by ${vh}`, () => {
    test.use({ viewport: { width: vw, height: vh } })

    test('the whole board, the Place bar and the HUD are on screen with no scroll, the board is large, and the agent card and result sit beside it', async ({ page }) => {
      test.setTimeout(90_000)
      await start(page)
      await expectNoOverflow(page, 'in play')
      const board = (await page.getByTestId('slack-board').boundingBox())!
      const bar = (await page.getByTestId('slack-action').boundingBox())!
      const hudBox = (await hud(page).boundingBox())!
      expect(await page.evaluate(() => window.scrollY)).toBe(0)
      expect(hudBox.y).toBeGreaterThanOrEqual(0)
      expect(board.width).toBeGreaterThanOrEqual(minBoard)
      expect(Math.abs(board.width - board.height)).toBeLessThanOrEqual(1)
      expect(bar.y + bar.height).toBeLessThanOrEqual(vh)
      // the board and the bar are one column: same left edge and same width
      expect(Math.abs(bar.x - board.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(bar.width - board.width)).toBeLessThanOrEqual(1)
      const card = (await page.getByTestId('agent-card').boundingBox())!
      expect(card.x).toBeGreaterThan(board.x + board.width - 1)
      // the agent card sits right beside the board, not across a wide empty gap
      expect(card.x - (board.x + board.width)).toBeLessThanOrEqual(40)
      // the HUD and the score share one row above the board
      const status = (await page.getByTestId('slack-status-row').boundingBox())!
      expect(Math.abs(status.y - hudBox.y)).toBeLessThanOrEqual(12)
      await page.getByTestId('slack-resign').click()
      await page.getByTestId('slack-resign-yes').click()
      const panel = (await page.getByTestId('result-panel').boundingBox())!
      expect(panel.x).toBeGreaterThan(board.x + board.width - 1)
      const after = (await page.getByTestId('slack-board').boundingBox())!
      expect(Math.abs(after.width - board.width)).toBeLessThanOrEqual(1)
      expect(Math.abs(after.x - board.x)).toBeLessThanOrEqual(1)
      await expectNoOverflow(page, 'result')
      await expectTargets(page, 'result')
    })
  })
}

/** Starts at a width and height with a chosen level (and optionally Practice), through a forced check so a covering element cannot hide the radio. */
async function startAt(page: Page, vw: number, vh: number, opts: { level?: RegExp; practice?: boolean; query?: string } = {}) {
  await page.setViewportSize({ width: vw, height: vh })
  await page.goto(`${URL}?seed=3${opts.query ?? ''}`)
  await expect(page.getByTestId('slack-setup')).toBeVisible()
  if (opts.practice) await page.locator('[data-mode-option="practice"]').click()
  await page.getByTestId('level-picker').getByRole('radio', { name: opts.level ?? /Pip/ }).check({ force: true })
  await page.getByTestId('slack-start').click()
  await expect(page.getByTestId('slack-board')).toBeVisible()
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

// The "recorded for your report" notice rides in the top of the aside column. It follows the content row (not a fixed offset), so a header that wraps cannot be covered.
test.describe('the lifted notice stays off the header and the aside card', () => {
  for (const [vw, vh] of [[1024, 768], [1280, 800], [1440, 900]] as const) {
    test(`${vw} by ${vh}: the notice meets neither the header nor the agent card`, async ({ page }) => {
      test.setTimeout(90_000)
      await startAt(page, vw, vh)
      const notice = page.getByTestId('training-notice')
      await expect(notice).toBeVisible()
      const n = (await notice.boundingBox())!
      const header = (await page.getByTestId('game-shell').locator('header').boundingBox())!
      const card = (await page.getByTestId('agent-card').boundingBox())!
      expect(overlaps(n, header)).toBe(false)
      expect(overlaps(n, card)).toBe(false)
      expect(n.y).toBeGreaterThanOrEqual(header.y + header.height)
    })
  }

  test('1024 by 768, Practice and Sable: the header wraps, and its "?", sound and Leaderboard controls are still the topmost thing at their centres', async ({ page }) => {
    test.setTimeout(90_000)
    await startAt(page, 1024, 768, { level: /Sable/, practice: true })
    // the wrapped header makes the page a little taller than the screen at this size, so look from the top, where a covered control would show
    await page.evaluate(() => window.scrollTo(0, 0))
    const notice = (await page.getByTestId('training-notice').boundingBox())!
    const header = (await page.getByTestId('game-shell').locator('header').boundingBox())!
    expect(overlaps(notice, header)).toBe(false)
    for (const target of [page.getByRole('button', { name: 'How to play' }), page.getByTestId('game-sound-button'), page.getByTestId('game-leaderboard-link')]) {
      const box = (await target.boundingBox())!
      const hit = await target.evaluate((el, [x, y]) => document.elementFromPoint(x!, y!) === el || el.contains(document.elementFromPoint(x!, y!)), [box.x + box.width / 2, box.y + box.height / 2])
      expect(hit).toBe(true)
    }
  })
})

// The status line never clips: when it cannot fit beside the HUD it takes its own row.
test.describe('the status line is never clipped on a laptop', () => {
  const cases: Array<[string, number, number, string, RegExp]> = [
    ['Pip has no move, 1366 by 657', 1366, 657, OPPONENT_PASS, /Pip/],
    ['no move for you, 1024 by 600', 1024, 600, PASS_POSITION, /Pip/],
    ['no move for you, Sable, 1280 by 720', 1280, 720, PASS_POSITION, /Sable/],
    ['no move for you, Marlow, 1280 by 800', 1280, 800, PASS_POSITION, /Marlow/],
    ['no move for you, Vesper, 1440 by 900', 1440, 900, PASS_POSITION, /Vesper/],
  ]
  for (const [label, vw, vh, moves, level] of cases) {
    test(label, async ({ page }) => {
      test.setTimeout(90_000)
      await startAt(page, vw, vh, { level, query: `&moves=${moves}` })
      const line = page.getByTestId('slack-status')
      await expect(line).toHaveText(/no move/i)
      const fits = await line.evaluate((el) => ({ w: el.scrollWidth <= el.clientWidth, h: el.scrollHeight <= el.clientHeight, text: el.textContent }))
      expect(fits, fits.text ?? '').toMatchObject({ w: true, h: true })
      const bar = (await page.getByTestId('slack-action').boundingBox())!
      expect(bar.y + bar.height).toBeLessThanOrEqual(vh)
    })
  }
})

test.describe('the Place button carries the pick', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('reads "Pick a ring" and is disabled before a pick, "Place at <cell>" after, keeps its size, and Enter places', async ({ page }) => {
    test.setTimeout(90_000)
    await start(page)
    const button = page.getByTestId('slack-action')
    await expect(page.getByTestId('slack-chip')).toHaveCount(0)
    await expect(button).toHaveText('Pick a ring')
    await expect(button).toBeDisabled()
    const before = (await button.boundingBox())!
    const cell = legalCells(page).first()
    const testid = (await cell.getAttribute('data-testid'))!
    await cell.click()
    const name = await cell.getAttribute('data-cell')
    await expect(button).toBeEnabled()
    await expect(button).toHaveText(/^Place at [A-H][1-8]$/)
    const text = (await button.textContent())!
    expect(text).toBe(`Place at ${name}`)
    const during = (await button.boundingBox())!
    expect(during).toEqual(before)
    await cell.focus()
    await page.keyboard.press('Enter')
    await expect(button).toHaveText('Pick a ring')
    await expect(page.locator(`[data-testid="${testid}"] .sl-disc`)).toHaveCount(1)
    expect((await button.boundingBox())!).toEqual(before)
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

  test('Rated is open and the default pick; every level shows the strength its registry measured, and nothing is In training', async ({ page }) => {
    await page.goto(URL)
    const mode = page.getByTestId('play-mode')
    await expect(mode).toHaveAttribute('data-mode', 'rated')
    await expect(page.locator('[data-mode-option="rated"] input')).toBeEnabled()
    await expect(page.locator('[data-mode-option="rated"] input')).toBeChecked()
    await expect(page.locator('[data-mode-option="rated"]')).not.toContainText('Not open yet')
    // The four levels are the four personas, each with its own line, and each is published with the registry's own site Elo.
    for (const [level, name, line] of [['easy', 'Pip', /most discs it can/], ['medium', 'Marlow', /squares matter/], ['hard', 'Vesper', /few moves ahead/], ['champion', 'Sable', /endgame/]] as const) {
      const row = page.locator(`[data-persona="${level}"]`)
      await expect(row).toContainText(name)
      await expect(row).toContainText(line)
      await expect(row).not.toContainText('In training')
    }
    expect(publishedLevels('slack')).toEqual(['easy', 'medium', 'hard', 'champion'])
    await expect(page.getByTestId('slack-start')).toContainText('Start match vs Pip')
  })

  test('the aside prints the measured strength of the opponent from the registry, level by level', async ({ page }) => {
    const reg = JSON.parse(readFileSync(join(import.meta.dirname, '../../../packages/agents/registry/slack.json'), 'utf8')) as { measured: Record<string, { siteElo: number }> }
    for (const level of ['easy', 'champion'] as const) {
      await page.goto(URL)
      await page.locator(`[data-persona="${level}"]`).click()
      await page.getByTestId('slack-start').click()
      await expect(page.getByTestId('agent-card')).toContainText(`site Elo ${Math.round(reg.measured[level]!.siteElo)}`)
    }
  })

  test('a Rated match is not a Practice match: no badge, resigning is a loss for a signed-out player with the unranked line, and Practice still marks itself', async ({ page }) => {
    await page.goto(URL)
    await page.getByTestId('slack-start').click()
    await expect(page.getByTestId('practice-badge')).toHaveCount(0)
    await page.getByTestId('slack-resign').click()
    await page.getByTestId('slack-resign-yes').click()
    await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss')
    await expect(page.getByTestId('result-practice')).toHaveCount(0)
    // Practice, picked on the setup screen, marks the match as before.
    await page.goto(URL)
    await page.locator('[data-mode-option="practice"]').click()
    await page.getByTestId('slack-start').click()
    await expect(page.getByTestId('practice-badge')).toBeVisible()
    await page.getByTestId('slack-resign').click()
    await page.getByTestId('slack-resign-yes').click()
    await expect(page.getByTestId('result-practice')).toHaveText('Practice, not rated')
    await expect(page.getByTestId('result-leaderboard-link')).toHaveCount(0)
  })

  test('a first-time profile (no owner key) sees a path that is true: Pip open, the rest locked behind a rated win', async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({ baseURL: baseURL!, extraHTTPHeaders: { 'x-dw-test': '1' }, storageState: { cookies: [], origins: [] } })
    const page = await ctx.newPage()
    await page.addInitScript(() => {
      localStorage.setItem('duelwise.how-to-play.slack', 'seen')
      localStorage.setItem('duelwise.welcomed', '1')
    })
    await page.goto(URL)
    await expect(page.getByTestId('play-mode')).toHaveAttribute('data-mode', 'rated')
    await expect(page.getByText('Clear Pip to unlock Marlow')).toBeVisible()
    await expect(page.getByTestId('path-stop-easy')).toHaveAttribute('data-state', 'current')
    for (const level of ['medium', 'hard', 'champion']) await expect(page.getByTestId(`path-stop-${level}`)).toHaveAttribute('data-state', 'locked')
    await expect(page.getByTestId('path-stop-medium')).toContainText('Locked, beat Pip')
    await expect(page.locator('[data-mode-option="rated"] input')).toBeEnabled()
    await expect(page.getByTestId('path-stop-easy')).not.toContainText('In training')
    await ctx.close()
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
    // Closing the confirm row shortens the page, which can clamp the scroll position (the Rated aside is taller than the Practice one); put the board back in the middle before it is watched.
    await board.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(300)
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
    // Measured on the page, not the screen: on a short phone the page may scroll to bring the Place bar up, which is not the title moving.
    const docBox = () => title.evaluate((el) => { const r = el.getBoundingClientRect(); return { y: r.top + window.scrollY, height: r.height } })
    const titleBefore = await docBox()
    await page.getByTestId('slack-start').click()
    await expect(page.getByTestId('slack-board')).toBeVisible()
    const titleAfter = await docBox()
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

  /** Wraps the page's AudioContext so every oscillator a cue starts is recorded with its type, first pitch and the context time it was scheduled at. */
  async function spyAudio(page: Page) {
    await page.addInitScript(() => {
      const w = window as unknown as { __osc: Array<{ type: string; f0: number; at: number }>; AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
      w.__osc = []
      const Real = w.AudioContext ?? w.webkitAudioContext
      if (!Real) return
      class Spy extends Real {
        createOscillator() {
          const o = super.createOscillator()
          const rec = { type: '', f0: 0, at: -1 }
          w.__osc.push(rec)
          const set = o.frequency.setValueAtTime.bind(o.frequency)
          o.frequency.setValueAtTime = (v: number, t: number) => { if (!rec.f0) rec.f0 = v; return set(v, t) }
          const start = o.start.bind(o)
          o.start = (t?: number) => { rec.at = t ?? 0; rec.type = o.type; return start(t) }
          return o
        }
      }
      w.AudioContext = Spy as typeof AudioContext
      w.webkitAudioContext = Spy as typeof AudioContext
    })
  }
  const heard = (page: Page) => page.evaluate(() => (window as unknown as { __osc: Array<{ type: string; f0: number; at: number }> }).__osc.map((o) => ({ ...o })))
  /** The pitch of rung n of the flip ripple: 880 Hz raised by RIPPLE_STEPS[n] semitones. */
  const rung = (n: number) => 880 * 2 ** ([0, 2, 4, 7][n]! / 12)
  const isTick = (o: { type: string; f0: number }) => o.type === 'sine' && [0, 1, 2, 3].some((n) => Math.abs(o.f0 - rung(n)) < 0.5)

  test('sound: your disc and the reply are different cues, a flip is a short ripple, and the sound switch silences all of it', async ({ page }) => {
    test.setTimeout(60_000)
    await spyAudio(page)
    await start(page)
    expect(await heard(page)).toEqual([])
    await playOne(page)
    // Your disc: the firm triangle tap, plus a ripple of at most four ticks for what it turned (never one cue per disc).
    await expect.poll(async () => (await heard(page)).some((o) => o.type === 'triangle')).toBe(true)
    const mine = await heard(page)
    expect(mine.filter(isTick).length).toBeGreaterThanOrEqual(1)
    expect(mine.filter(isTick).length).toBeLessThanOrEqual(4)
    const tap = mine.find((o) => o.type === 'triangle')!
    // Pip's reply: its own lower, hollower cue.
    await expect(page.getByTestId('slack-live')).toContainText('Pip', { timeout: 20_000 })
    const both = await heard(page)
    const reply = both.find((o) => o.type === 'sine' && Math.abs(o.f0 - 250) < 0.5)
    expect(reply, 'the reply has its own cue').toBeTruthy()
    expect(reply!.f0).toBeLessThan(tap.f0)
    expect(both.length).toBeLessThanOrEqual(2 * 8)
    // The switch in the header silences every later cue.
    await page.getByTestId('game-sound-button').click()
    await page.getByTestId('game-sound-panel').getByTestId('sfx-switch').uncheck()
    await page.keyboard.press('Escape')
    const before = (await heard(page)).length
    await expect(hud(page)).toHaveAttribute('data-turn', 'you')
    await playOne(page)
    await expect(page.getByTestId('slack-live')).toContainText('Pip', { timeout: 20_000 })
    await page.waitForTimeout(300)
    expect((await heard(page)).length).toBe(before)
  })

  test('sound with reduced motion: the flip is one tick, because nothing cascades', async ({ page }) => {
    test.setTimeout(60_000)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await spyAudio(page)
    await start(page)
    await playOne(page)
    // Count the ripple of your own disc: everything scheduled before Pip's reply cue (the lower hollow sine).
    await expect.poll(async () => (await heard(page)).some((o) => o.type === 'sine' && Math.abs(o.f0 - 250) < 0.5), { timeout: 20_000 }).toBe(true)
    const all = await heard(page)
    const replyAt = all.find((o) => o.type === 'sine' && Math.abs(o.f0 - 250) < 0.5)!.at
    expect(all.filter((o) => isTick(o) && o.at < replyAt)).toHaveLength(1)
  })

  /** Times the verdict on the status line against the result panel mounting, frame by frame. */
  async function timeTheEnd(page: Page) {
    await page.evaluate(() => {
      const w = window as unknown as { __end: { verdict: number; panel: number; resign: string; boardTop: number[]; turnAtVerdict: string } }
      w.__end = { verdict: 0, panel: 0, resign: '', boardTop: [], turnAtVerdict: '' }
      const board = document.querySelector('[data-testid="slack-board"]')!
      const tick = () => {
        const status = document.querySelector('[data-testid="slack-status"]')?.textContent ?? ''
        if (!w.__end.verdict && /You win|wins\.|A draw/.test(status)) {
          w.__end.verdict = performance.now()
          w.__end.turnAtVerdict = document.querySelector('[data-testid="play-hud"]')?.getAttribute('data-turn') ?? ''
        }
        if (!w.__end.panel && document.querySelector('[data-testid="result-panel"]')) {
          w.__end.panel = performance.now()
          return
        }
        if (w.__end.verdict) {
          w.__end.boardTop.push(board.getBoundingClientRect().top + window.scrollY)
          const r = document.querySelector('[data-testid="slack-resign"]') as HTMLButtonElement | null
          w.__end.resign = r ? (getComputedStyle(r).visibility === 'hidden' && r.disabled ? 'held' : 'live') : 'gone'
        }
        requestAnimationFrame(tick)
      }
      tick()
    })
  }

  for (const reduced of [false, true]) {
    test(`the end of a match${reduced ? ' with reduced motion' : ''}: the last discs settle, the finished board is held, then the result panel; nothing moves`, async ({ page }) => {
      test.setTimeout(90_000)
      if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' })
      await start(page, `&moves=${NEAR_END}`)
      await expect(hud(page)).toHaveAttribute('data-turn', 'you')
      await timeTheEnd(page)
      await playToEnd(page, 60_000)
      await expect(page.getByTestId('result-panel')).toBeVisible()
      const end = await page.evaluate(() => (window as unknown as { __end: { verdict: number; panel: number; resign: string; boardTop: number[]; turnAtVerdict: string } }).__end)
      expect(end.verdict, 'the verdict showed on the status line').toBeGreaterThan(0)
      const gap = end.panel - end.verdict
      // Full motion: the farthest ring settles at 380 ms and the board is held 700 ms more. Reduced motion: a 400 ms beat.
      expect(gap, 'verdict to panel').toBeGreaterThanOrEqual(reduced ? 330 : 1000)
      expect(gap, 'verdict to panel').toBeLessThanOrEqual(reduced ? 1500 : 2500)
      expect(end.turnAtVerdict).toBe('over')
      expect(end.resign, 'Resign keeps its place but cannot be used while the board is held').toBe('held')
      expect(end.boardTop.length).toBeGreaterThan(5)
      expect(Math.max(...end.boardTop) - Math.min(...end.boardTop), 'the board did not move before the panel').toBeLessThanOrEqual(2)
    })
  }

  // The report page on a fixture match played through the real core (/dev/report, seed 4, Marlow): the next test follows the live link from a real
  // Rated match; this one covers owner and public views, the chart marks and the honest lines on a fixed match.
  test('the match report is a real Crosscurrent report: the disc lead over time, the final board, named moments, honest lines, owner and public', async ({ page }) => {
    test.setTimeout(60_000)
    const errors = watchConsole(page)
    await page.goto('/dev/report?scenario=slack')
    await expect(page.getByTestId('report')).toHaveAttribute('data-status', 'ready')
    await expect(page.getByTestId('report-title')).toContainText('Marlow')
    await expect(page.getByTestId('report-meta')).toContainText('Crosscurrent')
    // The disc lead over time, with marks on the turns it names.
    await expect(page.getByTestId('report-chart')).toContainText('How the game went')
    await expect(page.getByTestId('eval-chart')).toBeVisible()
    expect(await page.getByTestId('chart-label').count()).toBeGreaterThanOrEqual(2)
    // The final board and its counts agree with the tile.
    const board = page.getByTestId('slack-final-board')
    const label = (await board.getAttribute('aria-label'))!
    const [, you, them] = /You (\d+) discs.*Marlow (\d+) discs/.exec(label)!.map(Number) as [number, number, number]
    await expect(page.getByTestId('report-tiles')).toContainText(`${you} to ${them}`)
    await expect(board.locator('span.aspect-square')).toHaveCount(64)
    await expect(board.locator('[data-corner]')).toHaveCount(4)
    // Named moments, then the result as the last row; nothing from another game.
    const moments = page.getByTestId('moments').locator('li')
    expect(await moments.count()).toBeGreaterThanOrEqual(4)
    await expect(moments.first()).toContainText('Corners')
    await expect(moments.last()).toHaveAttribute('data-kind', 'end')
    const owner = await page.getByTestId('report').innerText()
    expect(owner).toMatch(/You took \d+ corners?/)
    expect(owner).not.toMatch(/Hold.?em|chips|fold|ship|column|\bdrops?\b/i)
    await expect(page.getByTestId('report-note').or(page.getByTestId('report-moments'))).toContainText('counts discs only')
    // At 360 the page does not scroll sideways and the board is inside the screen.
    const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }))
    expect(w.s).toBeLessThanOrEqual(w.c)
    // The public view speaks about "the player" and never says "you".
    await page.goto('/dev/report?scenario=slack&mode=public')
    // The match's own sections (the sidebar cards are shared site copy).
    const pub = (await Promise.all(['report-title', 'report-meta', 'report-tiles', 'report-chart', 'report-slack', 'report-moments'].map((id) => page.getByTestId(id).innerText()))).join('\n')
    expect(pub).toMatch(/The player took \d+ corners?/)
    expect(pub).not.toMatch(/\b(You|Your|you|your)\b/)
    expect(errors).toEqual([])
  })

  test('a Rated match settles once through the held end, and its report link opens the real Crosscurrent report', async ({ page }) => {
    test.setTimeout(240_000)
    const errors = watchConsole(page)
    const finishes: string[] = []
    page.on('request', (r) => { if (/\/api\/(finish|resign)$/.test(r.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0])) finishes.push(r.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0]) })
    // A whole real match with no fixed seed (a test seed and a preset position are never counted).
    await page.goto(URL)
    await page.getByTestId('level-picker').getByRole('radio', { name: /Pip/ }).check()
    await page.getByTestId('slack-start').click()
    await expect(page.getByTestId('slack-board')).toBeVisible()
    await expect(page.getByTestId('play-mode')).toHaveAttribute('data-mode', 'rated').catch(() => undefined)
    await playToEnd(page, 180_000)
    // During the hold Resign is held back; forcing a click does nothing, so the match is not turned into a resignation.
    await page.getByTestId('slack-resign').click({ force: true, timeout: 1000 }).catch(() => undefined)
    await expect(page.getByTestId('result-panel')).toBeVisible()
    await expect(page.getByTestId('slack-final-count')).toBeVisible()
    await expect(page.getByTestId('result-upload').or(page.getByTestId('result-elo'))).toBeVisible()
    expect(finishes.filter((p) => p.endsWith('/resign'))).toEqual([])
    const link = page.getByTestId('result-report-link')
    await expect(link).toBeVisible()
    await link.click()
    await expect(page.getByTestId('report')).toHaveAttribute('data-status', 'ready')
    await expect(page.getByTestId('report-meta')).toContainText('Crosscurrent')
    await expect(page.getByTestId('eval-chart')).toBeVisible()
    await expect(page.getByTestId('slack-final-board')).toBeVisible()
    await expect(page.getByTestId('moments').locator('li').last()).toHaveAttribute('data-kind', 'end')
    expect(errors).toEqual([])
  })

  /** A real unseeded Rated start: a fixed seed or a preset position is never counted. */
  async function startRated(page: Page) {
    await page.goto(URL)
    await expect(page.getByTestId('slack-setup')).toBeVisible()
    await page.getByTestId('level-picker').getByRole('radio', { name: /Pip/ }).check()
    await page.getByTestId('slack-start').click()
    await expect(page.getByTestId('slack-board')).toBeVisible()
    await expect(hud(page)).toHaveAttribute('data-turn', 'you')
  }

  test('offline in setup: Rated cannot start and says why in the page, Practice still starts, and nothing is covered at 390', async ({ page, context }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(URL)
    await expect(page.getByTestId('slack-start')).toBeEnabled()
    await context.setOffline(true)
    const pill = page.getByTestId('offline-chip')
    await expect(pill).toHaveText('Offline: Practice only')
    // In the page's own flow, not fixed over Start or the header.
    expect(await pill.evaluate((el) => getComputedStyle(el).position)).not.toBe('fixed')
    await expect(page.getByTestId('slack-offline-line')).toContainText('Rated Crosscurrent needs a connection')
    await expect(page.getByTestId('slack-start')).toBeDisabled()
    await expect(page.getByTestId('slack-start')).toHaveText('Rated needs a connection')
    // Practice works offline.
    await page.locator('[data-mode-option="practice"]').click()
    await expect(page.getByTestId('slack-start')).toBeEnabled()
    await expect(page.getByTestId('slack-start')).toContainText('Start match vs Pip')
    // (The dev server cannot serve the opponent's worker while the network is off, so the start itself is not driven here.)
    await context.setOffline(false)
    await expect(page.getByTestId('offline-chip')).toHaveCount(0)
    await expect(page.getByTestId('slack-start')).toHaveText(/Start match vs Pip/)
  })

  test('offline in a live Rated match: the pill says reconnecting in its reserved slot, nothing moves, and the match goes on when back online', async ({ page, context }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 390, height: 844 })
    await startRated(page)
    const before = await page.evaluate(() => document.documentElement.scrollHeight)
    await context.setOffline(true)
    await expect(page.getByTestId('offline-chip')).toHaveText('Offline: reconnecting')
    expect(await page.getByTestId('offline-chip').evaluate((el) => getComputedStyle(el).position)).not.toBe('fixed')
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(before)
    await context.setOffline(false)
    await expect(page.getByTestId('offline-chip')).toHaveCount(0)
    await playOne(page)
    await expect(page.getByTestId('slack-live')).toContainText('Pip', { timeout: 20_000 })
  })

  test('offline: every other page keeps the fixed chip and its old line', async ({ page, context }) => {
    await page.goto('/play/chess')
    await page.waitForLoadState('networkidle')
    await context.setOffline(true)
    await expect(page.getByTestId('offline-chip')).toHaveText('Offline: matches will sync later')
    expect(await page.getByTestId('offline-chip').evaluate((el) => getComputedStyle(el).position)).toBe('fixed')
  })

  test('a reload in the middle of a Rated match gives the match up once and setup says so', async ({ page }) => {
    test.setTimeout(60_000)
    const gaveUp: string[] = []
    page.on('request', (r) => { if (/\/api\/resign/.test(r.url())) gaveUp.push(r.url()) })
    await startRated(page)
    await playOne(page)
    await expect(page.getByTestId('slack-live')).toContainText('Pip', { timeout: 20_000 })
    await page.reload()
    await expect(page.getByTestId('slack-setup')).toBeVisible()
    await expect(page.getByTestId('resigned-notice')).toContainText('resigned when you left the page')
    expect(gaveUp.length).toBeLessThanOrEqual(1)
  })

  test('at 360 by 640 the Place bar is on screen when a match starts', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 })
    await startRated(page)
    await page.waitForTimeout(300)
    const bar = (await page.getByTestId('slack-action').boundingBox())!
    expect(bar.y).toBeGreaterThanOrEqual(0)
    expect(bar.y + bar.height).toBeLessThanOrEqual(640)
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
