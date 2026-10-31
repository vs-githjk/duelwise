import { expect, test, type Page } from '@playwright/test'

// Practice: the same game, unrated. A Rated / Practice pick on each setup screen (Rated by default). A practice Hold'em player who busts is
// offered a free "Buy back in" and the match goes on. A practice chess match moves no rating. Run on the phone profile too:
//   PORT=<free port> bunx playwright test -c playwright.webkit.config.ts e2e/practice.spec.ts
// PRACTICE_SHOTS=<absolute dir> saves a screenshot of each state for a human look.

const HOLDEM = '/play/heads-up-holdem'
const CHESS = '/play/chess'
const FOUR = '/play/four-in-a-row'
const PHONE = { width: 393, height: 852 }
test.use({ viewport: PHONE })

async function shot(page: Page, name: string, of?: string) {
  if (!process.env.PRACTICE_SHOTS) return
  const path = `${process.env.PRACTICE_SHOTS}/${name}.png`
  if (of) await page.getByTestId(of).screenshot({ path })
  else await page.screenshot({ path })
}

async function devSignIn(page: Page, name: string) {
  await page.goto('/signin')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Dev sign in' }).click()
  await expect(page).toHaveURL(/\/play$/)
  await expect(page.getByTestId('user-menu')).toContainText(name)
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test.describe('the Rated / Practice pick', () => {
  for (const [name, url] of [['Hold\'em', HOLDEM], ['chess', CHESS], ['Four in a Row', FOUR]] as const) {
    test(`${name}: Rated is the default, Practice is one tap, the rows are 44 px targets and the page does not scroll sideways`, async ({ page }) => {
      await page.goto(url)
      const mode = page.getByTestId('play-mode')
      await expect(mode).toBeVisible()
      await expect(mode).toHaveAttribute('data-mode', 'rated')
      await expect(page.locator('[data-mode-option="rated"] input')).toBeChecked()
      for (const id of ['rated', 'practice']) {
        const box = (await page.locator(`[data-mode-option="${id}"]`).boundingBox())!
        expect(box.height).toBeGreaterThanOrEqual(44)
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width)
      }
      await page.locator('[data-mode-option="practice"]').click()
      await expect(mode).toHaveAttribute('data-mode', 'practice')
      expect(await overflow(page)).toBeLessThanOrEqual(0)
      await shot(page, `setup-practice-${name.replace(/[^a-z]/gi, '').toLowerCase()}`)
      // Rated again, then a reload: Practice never carries over.
      await page.locator('[data-mode-option="rated"]').click()
      await expect(mode).toHaveAttribute('data-mode', 'rated')
      await page.locator('[data-mode-option="practice"]').click()
      await page.reload()
      await expect(page.getByTestId('play-mode')).toHaveAttribute('data-mode', 'rated')
    })
  }

  test('a rated match shows no Practice badge or chip', async ({ page }) => {
    await page.goto(FOUR + '?seed=7')
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(page.getByTestId('four-board')).toBeVisible()
    await expect(page.getByTestId('practice-badge')).toHaveCount(0)
  })
})

test.describe("Hold'em practice", () => {
  const table = (page: Page) => page.getByTestId('holdem-table')

  /**
   * Plays on, going all in whenever it can so a bust comes quickly, taking the free buy-back each time it is offered.
   * Returns how many buy-backs it took when the match is over.
   */
  async function playOut(page: Page, opts: { stopAtOffer?: boolean } = {}): Promise<number> {
    let buys = 0
    for (let guard = 0; guard < 900; guard++) {
      if (await page.getByTestId('buyback').isVisible()) {
        if (opts.stopAtOffer) return buys
        await page.getByTestId('buy-back').click()
        buys++
        continue
      }
      const turn = await table(page).getAttribute('data-turn')
      if (turn === 'over') return buys
      if (turn === 'you') {
        const allin = page.getByTestId('preset-allin')
        if (await allin.isVisible()) {
          await allin.click()
          await page.getByTestId('bet-raise').click()
        } else await page.getByTestId('bet-call').click()
      }
      await page.waitForTimeout(40)
    }
    throw new Error('the match did not end')
  }

  async function startPractice(page: Page, seed: number, hands: '5' | '10' = '10') {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(`${HOLDEM}?seed=${seed}`)
    await page.locator(`[data-length="${hands}"]`).click()
    await page.locator('[data-mode-option="practice"]').click()
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(table(page)).toBeVisible()
    await expect(page.getByTestId('practice-badge')).toHaveText('Practice, unrated')
  }

  // The seed is only here so the deals are the same on every run: this one has the human lose an all-in with hands still to play.
  const BUST_SEED = Number(process.env.PRACTICE_BUST_SEED ?? 11)

  test('a bust offers a free buy-back on a phone, the match then runs its chosen length, and the result says Practice, not rated', async ({ page }) => {
    test.setTimeout(240_000)
    await startPractice(page, BUST_SEED)
    await shot(page, 'holdem-practice-playing')
    // Play until the offer shows.
    const early = await playOut(page, { stopAtOffer: true })
    expect(early).toBe(0)
    const offer = page.getByTestId('buyback')
    await expect(offer).toBeVisible()
    await expect(page.getByTestId('holdem-status')).toHaveText('Out of chips')
    // Nothing to act on until the choice is made, and the match has not ended.
    await expect(page.getByTestId('bet-controls')).toHaveCount(0)
    await expect(page.getByTestId('result-panel')).toHaveCount(0)
    const handBefore = Number(await table(page).getAttribute('data-hand'))
    for (const id of ['buy-back', 'buyback-leave']) {
      const box = (await page.getByTestId(id).boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width)
    }
    expect(await overflow(page)).toBeLessThanOrEqual(0)
    await shot(page, 'holdem-practice-buyback')

    await page.getByTestId('buy-back').click()
    await expect(offer).toHaveCount(0)
    // The next hand was already dealt behind the offer: it is the one that plays on, with fresh stacks. The chip tally carries on.
    await expect(table(page)).toHaveAttribute('data-hand', String(handBefore))
    await expect(table(page)).toHaveAttribute('data-turn', /you|ai/)
    await expect(page.getByTestId('net-chips')).toHaveText('-100')
    await expect(page.getByTestId('holdem-progress')).toContainText('of 10')

    const more = await playOut(page)
    const panel = page.getByTestId('result-panel')
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('result-practice')).toHaveText('Practice, not rated')
    await expect(page.getByTestId('holdem-buyins')).toContainText(`${1 + more} ${1 + more === 1 ? 'time' : 'times'}`)
    // Not a rated result: no rating line, no path step, no leaderboard or share.
    for (const gone of ['result-elo', 'play-next', 'result-leaderboard-link']) await expect(page.getByTestId(gone)).toHaveCount(0)
    // The match ran to the chosen length (10 hands), or ended at it: a bust did not shorten it.
    const rows = await page.getByTestId('history-row').count()
    expect(rows).toBeGreaterThanOrEqual(10)
    await expect(page.getByTestId('holdem-record')).toHaveAttribute('data-record-ok', 'true')
    expect(await overflow(page)).toBeLessThanOrEqual(0)
    await shot(page, 'holdem-practice-result', 'result-panel')
  })

  test('leaving the table from the buy-back offer ends the match as practice', async ({ page }) => {
    test.setTimeout(240_000)
    await startPractice(page, BUST_SEED)
    await playOut(page, { stopAtOffer: true })
    await page.getByTestId('buyback-leave').click()
    await expect(page.getByTestId('result-panel')).toBeVisible()
    await expect(page.getByTestId('result-practice')).toBeVisible()
    await expect(page.getByTestId('holdem-left-note')).toContainText('Unrated, you left after')
    await expect(page.getByTestId('holdem-record')).toHaveAttribute('data-record-ok', 'true')
  })

  test('a rated match still ends at a bust and offers no buy-back', async ({ page }) => {
    test.setTimeout(240_000)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(`${HOLDEM}?seed=${BUST_SEED}`)
    await page.locator('[data-length="10"]').click()
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(table(page)).toBeVisible()
    await expect(page.getByTestId('practice-badge')).toHaveCount(0)
    await playOut(page)
    await expect(page.getByTestId('buyback')).toHaveCount(0)
    await expect(page.getByTestId('result-practice')).toHaveCount(0)
    expect(await page.getByTestId('history-row').count()).toBeLessThan(10)
  })
})

test.describe('chess practice', () => {
  const board = (page: Page) => page.getByTestId('chess-board')

  async function startChess(page: Page, practice: boolean) {
    await page.goto(CHESS)
    await page.waitForLoadState('networkidle')
    if (practice) await page.locator('[data-mode-option="practice"]').click()
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(board(page)).toBeVisible()
    await expect(board(page)).toHaveAttribute('data-turn', 'you')
  }
  async function resign(page: Page) {
    await page.getByRole('button', { name: 'Resign' }).click()
    await page.getByRole('button', { name: 'Yes, resign' }).click()
    await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss')
  }

  test('a practice match is unrated: a visible badge, no rating line, and the signed-in rating and leaderboard row do not move', async ({ page }) => {
    await devSignIn(page, 'prac-chess')
    // Control: a rated resign costs rating.
    await startChess(page, false)
    await expect(page.getByTestId('practice-badge')).toHaveCount(0)
    await resign(page)
    const elo = page.getByTestId('result-elo')
    await expect(elo).toContainText(/Rating 1000 to \d+/)
    const after = Number(/to (\d+)/.exec((await elo.textContent()) ?? '')![1])
    expect(after).toBeLessThan(1000)

    // Practice: same game, badge on screen while playing, and the resign moves nothing.
    await startChess(page, true)
    await expect(page.getByTestId('practice-badge')).toHaveText('Practice, unrated')
    expect(await overflow(page)).toBeLessThanOrEqual(0)
    await shot(page, 'chess-practice-playing')
    await resign(page)
    await expect(page.getByTestId('result-practice')).toHaveText('Practice, not rated')
    await expect(page.getByTestId('result-upload')).toContainText('Saved to your history')
    await expect(page.getByTestId('result-elo')).toHaveCount(0)
    await expect(page.getByTestId('result-leaderboard-link')).toHaveCount(0)
    await shot(page, 'chess-practice-result', 'result-panel')

    await page.goto('/leaderboard/chess')
    await expect(page.getByTestId('leaderboard-me')).toContainText(`Your rating: ${after} after 1 counted match`)
  })
})
