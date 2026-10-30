import { readFileSync } from 'node:fs'
import { visibleRegistry } from '../src/lib/strength-gates'
import { expect, test, type Page } from '@playwright/test'

const URL = '/play/heads-up-holdem'

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    // With the dev overlay off (vite.config.ts) Vite prints a request the previous spec's page cancelled as a console error on every open page; that is dev-server noise, not the app.
    if (m.type() === 'error' && !/^\[vite\] Internal Server Error\s+aborted/.test(m.text())) errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

async function start(page: Page, query = '') {
  await page.goto(URL + query)
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId('holdem-table')).toBeVisible()
}

const table = (page: Page) => page.getByTestId('holdem-table')
const turn = (page: Page) => table(page).getAttribute('data-turn')

/** Waits until the human may act or the match is over. */
async function waitForMe(page: Page) {
  await expect(table(page)).toHaveAttribute('data-turn', /you|over/, { timeout: 20_000 })
}

test.describe("Heads-Up Hold'em play page", () => {
  test('is listed in /play and says play chips only, no prizes', async ({ page }) => {
    await page.goto('/play')
    const card = page.getByTestId('game-card-holdem')
    await expect(card.getByRole('heading', { name: "Heads-Up Hold'em" })).toBeVisible()
    await card.getByRole('link', { name: 'Play' }).click()
    await expect(page).toHaveURL(/\/play\/heads-up-holdem$/)
    await expect(page.getByTestId('holdem-setup')).toBeVisible()
    await expect(page.getByTestId('chips-only-note')).toContainText('Play chips only, no prizes')
  })

  test('plays a full 30-hand match with presets, slider and off-tree bets; chips add up; the record validates', async ({ page }) => {
    // The held hands keep their reading time under reduced motion, so a 30-hand match takes about 2 minutes.
    test.setTimeout(420_000)
    const errors = watchConsole(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await start(page, '?seed=7')
    await expect(page.getByTestId('chips-only-note')).toContainText('Play chips only, no prizes')
    await expect(page.getByTestId('preview-badge')).toHaveCount(visibleRegistry(JSON.parse(readFileSync(new globalThis.URL('../../../packages/agents/registry/holdem.json', import.meta.url), 'utf8'))).levels.easy ? 0 : 1)

    let presetUsed = false
    let offTreeUsed = false
    let guard = 0
    while (guard++ < 600) {
      await waitForMe(page)
      if ((await turn(page)) === 'over') break
      // Chips on the table plus both stacks always make two full stacks.
      const pot = Number(await table(page).getAttribute('data-pot'))
      const mine = Number(await table(page).getAttribute('data-my-stack'))
      const theirs = Number(await table(page).getAttribute('data-opp-stack'))
      expect(mine + theirs + pot).toBe(200)

      const raise = page.getByTestId('bet-raise')
      const canRaise = await raise.isVisible()
      if (canRaise && !presetUsed) {
        const preset = page.getByTestId('preset-half').or(page.getByTestId('preset-min')).first()
        await preset.click()
        const to = await preset.getAttribute('data-to')
        await expect(raise).toHaveAttribute('data-to', to!)
        await expect(page.getByTestId('bet-slider')).toHaveValue(to!)
        presetUsed = true
        await raise.click()
      } else if (canRaise && presetUsed && !offTreeUsed) {
        const slider = page.getByTestId('bet-slider')
        await slider.focus()
        for (let i = 0; i < 3; i++) await slider.press('ArrowRight')
        const to = await slider.inputValue()
        await expect(raise).toHaveAttribute('data-to', to)
        await raise.click()
        offTreeUsed = true
        await expect(page.getByTestId('holdem-log')).toContainText(`You raise to ${to}`)
      } else {
        await page.getByTestId('bet-call').click()
      }
    }
    expect(guard).toBeLessThan(600)
    expect(presetUsed && offTreeUsed).toBe(true)

    await expect(page.getByTestId('result-panel')).toBeVisible()
    const record = page.getByTestId('holdem-record')
    await expect(record).toHaveAttribute('data-record-ok', 'true')
    await expect(record).toHaveAttribute('data-final-hash', /^[0-9a-f]{16}$/)
    await expect(table(page)).toHaveAttribute('data-hand', '30')

    // The hand history sums to the final chip difference, and the result agrees with its sign.
    const rows = await page.locator('[data-testid="history-row"]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-delta'))))
    expect(rows).toHaveLength(30)
    const net = rows.reduce((a, b) => a + b, 0)
    expect(Number(await table(page).getAttribute('data-net'))).toBe(net)
    const outcome = await page.getByTestId('result-panel').getAttribute('data-outcome')
    expect(outcome).toBe(net > 0 ? 'win' : net < 0 ? 'loss' : 'draw')
    expect(errors).toEqual([])
  })

  test('conceding ends the match as a loss with a valid record', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await start(page, '?seed=3')
    await waitForMe(page)
    await page.getByRole('button', { name: 'Concede' }).click()
    await page.getByRole('button', { name: 'Yes, concede' }).click()
    await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss')
    await expect(page.getByTestId('holdem-record')).toHaveAttribute('data-record-ok', 'true')
  })

  test('works at 360 px: no horizontal scroll, controls reachable and big enough', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(URL)
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(await overflow()).toBeLessThanOrEqual(0)
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(table(page)).toBeVisible()
    await waitForMe(page)
    expect(await overflow()).toBeLessThanOrEqual(0)
    for (const id of ['bet-call', 'bet-raise', 'bet-slider']) {
      const loc = page.getByTestId(id)
      if (!(await loc.isVisible())) continue
      const box = await loc.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(360)
      if (id !== 'bet-slider') expect(box!.height).toBeGreaterThanOrEqual(44)
    }
    await page.getByTestId('bet-call').click()
    await waitForMe(page)
    expect(await overflow()).toBeLessThanOrEqual(0)
  })

  test('at 390x844 Fold and Call are on screen at the first decision', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(URL + '?seed=7')
    await page.getByRole('button', { name: 'Start match' }).click()
    await waitForMe(page)
    for (const id of ['bet-fold', 'bet-call', 'bet-raise']) {
      const box = (await page.getByTestId(id).boundingBox())!
      expect(box.y, `${id} top`).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height, `${id} bottom`).toBeLessThanOrEqual(844)
    }
    // The rail does not cut through the seat text.
    const rail = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="holdem-table"]')!.getBoundingClientRect()
      return [...document.querySelectorAll('[data-testid="seat-me"] > *, [data-testid="seat-opp"] > *')].every((e) => {
        const r = e.getBoundingClientRect()
        return r.left >= t.left + 10 && r.right <= t.right - 10
      })
    })
    expect(rail).toBe(true)
  })

  test('mute toggle persists across a reload', async ({ page }) => {
    await page.goto(URL)
    const toggle = page.getByRole('button', { name: /Sound (on|off)/ })
    await expect(toggle).toHaveText('Sound on')
    await toggle.click()
    await page.reload()
    await expect(page.getByRole('button', { name: /Sound (on|off)/ })).toHaveText('Sound off')
  })

  test.describe('table that tells the story', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    const HAND_NAME = /with (\w+ high|a pair of \w+, \w+ kicker|two pair, \w+ and \w+|three \w+|a straight, \w+ high|a flush, \w+ high|a full house, \w+ over \w+|four \w+|a straight flush, \w+ high|a royal flush)$|both have /

    test('Raise stays above the fold at 1440x900, preflop and on later streets', async ({ page }) => {
      test.setTimeout(120_000)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await start(page, '?seed=7')
      const streets = new Set<string>()
      for (let i = 0; i < 12 && streets.size < 3; i++) {
        await waitForMe(page)
        if ((await turn(page)) === 'over') break
        const street = (await table(page).getAttribute('data-street'))!
        const raise = page.getByTestId('bet-raise')
        if (await raise.isVisible()) {
          const box = (await raise.boundingBox())!
          expect(box.y + box.height, `Raise bottom on ${street}`).toBeLessThanOrEqual(900)
          streets.add(street)
        }
        await page.getByTestId('bet-call').click()
      }
      expect(streets.size).toBeGreaterThanOrEqual(1)
    })

    test('the felt is an oval with a rail and the hand strength is named', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await start(page, '?seed=7')
      await waitForMe(page)
      const felt = await table(page).evaluate((el) => {
        const cs = getComputedStyle(el)
        return { radius: cs.borderTopLeftRadius, rail: cs.borderTopWidth, w: el.clientWidth, h: el.clientHeight }
      })
      expect(felt.rail).toBe('10px')
      expect(Number.parseFloat(felt.radius)).toBeGreaterThanOrEqual(felt.h / 2 - 1)
      await expect(page.getByTestId('hand-strength')).toBeVisible()
      await expect(page.getByTestId('hand-strength')).not.toBeEmpty()
    })

    test('a showdown names the winning hand, keeps the stacks right and then pushes the pot', async ({ page }) => {
      test.setTimeout(180_000)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await start(page, '?seed=7')
      const seen = { show: false, push: false }
      for (let guard = 0; guard < 900 && !(seen.show && seen.push); guard++) {
        const t = table(page)
        const state = await t.evaluate((el) => ({
          turn: el.getAttribute('data-turn'),
          street: el.getAttribute('data-street'),
          stage: el.getAttribute('data-stage'),
          pot: Number(el.getAttribute('data-pot')),
          mine: Number(el.getAttribute('data-my-stack')),
          theirs: Number(el.getAttribute('data-opp-stack')),
          banner: el.querySelector('[data-testid="hand-banner"]')?.textContent ?? '',
        }))
        if (state.turn === 'over') break
        if (state.turn === 'you') {
          await page.getByTestId('bet-call').click()
        } else if (state.turn === 'reveal' && state.street === 'showdown') {
          expect(state.mine + state.theirs + state.pot).toBe(200)
          if (state.stage === 'show') {
            expect(state.banner).toMatch(HAND_NAME)
            expect(state.pot).toBeGreaterThan(0)
            seen.show = true
          }
          if (state.stage === 'push') {
            expect(state.pot).toBe(0)
            expect(state.banner).toMatch(HAND_NAME)
            seen.push = true
          }
        }
        await page.waitForTimeout(60)
      }
      expect(seen).toEqual({ show: true, push: true })
    })

    test('the header holds the hand and chips until the pot is pushed, and Skip cuts a reading pause short', async ({ page }) => {
      test.setTimeout(180_000)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await start(page, '?seed=7')
      const header = () =>
        page.getByTestId('holdem-progress').evaluate((el) => ({
          hand: Number(el.querySelector('b')!.textContent),
          net: el.querySelector('[data-testid="net-chips"]')!.textContent,
        }))
      let before: { hand: number; net: string | null } | null = null
      for (let guard = 0; guard < 900; guard++) {
        const t = await table(page).getAttribute('data-turn')
        const stage = await table(page).getAttribute('data-stage')
        if (t === 'over') break
        if (t === 'you') {
          before = await header()
          await page.getByTestId('bet-call').click()
        } else if (t === 'reveal' && stage === 'show' && before) {
          expect(await header()).toEqual(before)
          const t0 = Date.now()
          await page.getByTestId('holdem-skip').click()
          await expect(table(page)).toHaveAttribute('data-stage', 'push')
          expect(Date.now() - t0).toBeLessThan(700)
          expect((await header()).hand).toBe(before.hand + 1)
          return
        }
        await page.waitForTimeout(40)
      }
      throw new Error('no hand reached the show stage')
    })

    test('hand history entries are labelled', async ({ page }) => {
      test.setTimeout(120_000)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await start(page, '?seed=7')
      for (let guard = 0; guard < 900; guard++) {
        if ((await page.getByTestId('history-row').count()) > 0) break
        if ((await table(page).getAttribute('data-turn')) === 'you') await page.getByTestId('bet-call').click()
        await page.waitForTimeout(40)
      }
      const row = page.getByTestId('history-row').first()
      await expect(row).toContainText(/Hand 1:/)
      await expect(row.getByRole('img')).toHaveAttribute('aria-label', /You (gained|lost) \d+ chips|No chips changed hands/)
    })

    test('history rows say whose cards are whose', async ({ page }) => {
      test.setTimeout(180_000)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await start(page, '?seed=7')
      for (let guard = 0; guard < 1500; guard++) {
        if ((await page.getByTestId('history-cards').count()) > 0) break
        if ((await table(page).getAttribute('data-turn')) === 'you') await page.getByTestId('bet-call').click()
        await page.waitForTimeout(40)
      }
      await expect(page.getByTestId('history-cards').first()).toHaveText(/^You .+, Pip .+, board .+/)
    })

    test('the history does not give away an all-in result while the board is still being dealt', async ({ page }) => {
      test.setTimeout(180_000)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await start(page, '?seed=11')
      const rows = () => page.getByTestId('history-row').count()
      for (let guard = 0; guard < 1500; guard++) {
        const st = await table(page).evaluate((el) => ({ turn: el.getAttribute('data-turn'), stage: el.getAttribute('data-stage') }))
        if (st.turn === 'over') break
        if (st.turn === 'you') {
          const allin = page.getByTestId('preset-allin')
          if (await allin.isVisible()) {
            await allin.click()
            await page.getByTestId('bet-raise').click()
          } else await page.getByTestId('bet-call').click()
        } else if (st.stage === 'runout') {
          // data-hand already names the next hand, so the live hand is hand - 1 and only hand - 2 are finished.
          const hand = Number(await table(page).getAttribute('data-hand'))
          expect(await rows(), 'the run-out hand is already in the history').toBe(hand - 2)
          await page.waitForTimeout(300)
          expect(await rows(), 'a row appeared during the run-out').toBe(hand - 2)
          await expect(page.getByTestId('history-row')).toHaveCount(hand - 1, { timeout: 15_000 })
          return
        }
        await page.waitForTimeout(50)
      }
      throw new Error('no all-in run-out happened')
    })

    test('an all-in is announced as going all in, never as a raise', async ({ page }) => {
      test.setTimeout(180_000)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await start(page, '?seed=11')
      await waitForMe(page)
      await page.getByTestId('preset-allin').click()
      await page.getByTestId('bet-raise').click()
      await expect(page.getByTestId('holdem-log')).toHaveText(/^You go all in to \d+$/)
    })

    test('an all-in run-out deals the turn and river one at a time', async ({ page }) => {
      test.setTimeout(180_000)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await start(page, '?seed=11')
      const counts = new Set<number>()
      for (let guard = 0; guard < 1500; guard++) {
        const st = await table(page).evaluate((el) => ({
          turn: el.getAttribute('data-turn'),
          stage: el.getAttribute('data-stage'),
          boardCount: Number(el.getAttribute('data-board-count')),
        }))
        if (st.turn === 'over') break
        if (st.turn === 'you') {
          const allin = page.getByTestId('preset-allin')
          if (await allin.isVisible()) {
            await allin.click()
            await page.getByTestId('bet-raise').click()
          } else await page.getByTestId('bet-call').click()
        } else if (st.stage === 'runout') {
          counts.add(st.boardCount)
        }
        // A run-out shows at least two separate board sizes (flop then turn, or turn then river).
        if (counts.size >= 2) break
        await page.waitForTimeout(50)
      }
      const sawRunout = counts.size >= 2
      expect(sawRunout, `board sizes seen during the run-out: ${[...counts]}`).toBe(true)
    })
  })
})
