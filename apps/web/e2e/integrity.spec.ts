import { expect, test, type Page } from '@playwright/test'

const GAMES = {
  chess: { play: '/play/chess', board: 'chess-board', board_lb: '/leaderboard/chess' },
  four: { play: '/play/four-in-a-row', board: 'four-board', board_lb: '/leaderboard/four-in-a-row' },
} as const

async function devSignIn(page: Page, name: string) {
  await page.goto('/signin')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Dev sign in' }).click()
  await expect(page).toHaveURL(/\/play$/)
  await expect(page.getByTestId('user-menu')).toContainText(name)
}

async function startMatch(page: Page, game: keyof typeof GAMES, query = '') {
  await page.goto(GAMES[game].play + query)
  await page.waitForLoadState('networkidle')
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId(GAMES[game].board)).toBeVisible()
  await expect(page.getByTestId(GAMES[game].board)).toHaveAttribute('data-turn', 'you')
}

async function resign(page: Page) {
  await page.getByRole('button', { name: 'Resign' }).click()
  await page.getByRole('button', { name: 'Yes, resign' }).click()
  await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss')
  await expect(page.getByTestId('result-reason')).toHaveText('You resigned.')
}

for (const game of ['chess', 'four'] as const) {
  test.describe(`${game}: rated resign`, () => {
    test('resigning a counted match is a loss: the rating shown drops and the leaderboard reflects it', async ({ page }) => {
      await devSignIn(page, `res-${game}`)
      await startMatch(page, game)
      await resign(page)
      const elo = page.getByTestId('result-elo')
      await expect(elo).toContainText(/Rating 1000 to \d+/)
      const text = (await elo.textContent()) ?? ''
      const after = Number(/to (\d+)/.exec(text)![1])
      expect(after).toBeLessThan(1000)
      await page.goto(GAMES[game].board_lb)
      await expect(page.getByTestId('leaderboard-me')).toContainText(`Your rating: ${after} after 1 counted match`)
    })

    test('an unrated test-seed match resigns without touching the rating', async ({ page }) => {
      await devSignIn(page, `unr-${game}`)
      await startMatch(page, game, '?seed=7')
      await resign(page)
      await expect(page.getByTestId('result-elo')).toHaveCount(0)
      await expect(page.getByTestId('result-unrated')).toBeVisible()
      await page.goto(GAMES[game].board_lb)
      await expect(page.getByTestId('leaderboard-me')).toHaveCount(0)
    })
  })
}

test('closing the page during a counted match sends a beacon that resigns it', async ({ page }) => {
  await devSignIn(page, 'leaver')
  await startMatch(page, 'four')
  await page.goto('/leaderboard/four-in-a-row') // a full navigation fires pagehide on the play page
  await expect(async () => {
    await page.reload()
    await expect(page.getByTestId('leaderboard-me')).toContainText('after 1 counted match')
  }).toPass({ timeout: 15_000 })
})

/** Lets the match start but makes the finished record's upload (the multipart server function) fail. */
async function failServerUpload(page: Page) {
  await page.route(/_serverFn/, async (route) => {
    const type = route.request().headers()['content-type'] ?? ''
    if (type.includes('multipart/form-data')) await route.abort('failed')
    else await route.continue()
  })
}

/** Drops stones while it is the player's turn until the result panel shows. */
async function playFourToTheEnd(page: Page) {
  const board = page.getByTestId('four-board')
  const panel = page.getByTestId('result-panel')
  for (let i = 0; i < 60 && !(await panel.isVisible()); i++) {
    if ((await board.getAttribute('data-turn').catch(() => null)) === 'you') {
      const before = await board.getAttribute('data-moves')
      await page.getByTestId(`col-${i % 7}`).click({ trial: false, timeout: 2000 }).catch(() => {})
      await expect(async () => {
        if (await panel.isVisible()) return
        expect(await board.getAttribute('data-moves')).not.toBe(before)
      }).toPass({ timeout: 3000 }).catch(() => {})
    } else {
      await page.waitForTimeout(100)
    }
  }
  await expect(panel).toBeVisible()
}

test('a finished match whose upload failed is delivered by the pagehide beacon and counts', async ({ page }) => {
  await devSignIn(page, 'beaconer')
  await failServerUpload(page)
  // The cyclic-column player cannot be relied on to finish against the measured Easy agent, so the dev-only random opponent plays seat 1.
  await startMatch(page, 'four', '?opponent=random')
  await playFourToTheEnd(page)
  await expect(page.getByTestId('result-upload')).toContainText('next time you open a game')
  // Playwright does not report sendBeacon requests, so the proof is the server effect: only the beacon can have delivered it.
  await page.goto('/leaderboard/four-in-a-row')
  await expect(async () => {
    await page.reload()
    await expect(page.getByTestId('leaderboard-me')).toContainText('after 1 counted match')
  }).toPass({ timeout: 15_000 })
})

test('a record that no request could deliver stays in localStorage and the next game page sends it', async ({ page }) => {
  await devSignIn(page, 'retrier')
  await failServerUpload(page)
  // The pagehide beacon bypasses page.route, so make it deliver nothing: only retryPending can send the record.
  await page.addInitScript(() => {
    navigator.sendBeacon = () => false
  })
  let blockFinish = true
  let delivered = 0
  await page.route(/\/api\/finish$/, (route) => {
    if (blockFinish) return route.abort('failed')
    delivered++
    return route.continue()
  })
  // The cyclic-column player cannot be relied on to finish against the measured Easy agent, so the dev-only random opponent plays seat 1.
  await startMatch(page, 'four', '?opponent=random')
  await playFourToTheEnd(page)
  await expect(page.getByTestId('result-upload')).toBeVisible()
  const pendingKeys = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('duelwise.pending-finish.')))
  expect(await pendingKeys()).toHaveLength(1)
  await page.goto('/leaderboard/four-in-a-row')
  expect(delivered).toBe(0)
  expect(await pendingKeys()).toHaveLength(1)
  blockFinish = false
  await page.goto('/play/four-in-a-row') // retryPending runs on mount
  await expect(async () => expect(await pendingKeys()).toHaveLength(0)).toPass({ timeout: 15_000 })
  // Dev StrictMode mounts the effect twice, so the request may repeat; the server must settle the match once.
  expect(delivered).toBeGreaterThanOrEqual(1)
  await page.goto('/leaderboard/four-in-a-row')
  await expect(page.getByTestId('leaderboard-me')).toContainText('after 1 counted match')
})
