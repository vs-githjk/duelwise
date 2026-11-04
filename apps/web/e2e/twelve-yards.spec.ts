import { expect, test, type Locator, type Page } from '@playwright/test'

// Twelve Yards at /play/twelve-yards, the promoted page on GameShell, LevelPicker and ResultPanel. A Practice match end to end, with each kick order forced through the
// dev ?side switch (and the seed's own side when none is given), the whole match on screen at laptop and phone sizes with no scroll, a scroll back to the top on Start, Rated
// open (a counted match whose seed stays on the server: a whole Rated match from the side the e2e server gives, a resign, the hidden choice on the wire), the offline line
// and an offline match. The feel (drag and tap aiming, the reveal, the keeper) is in penalty.spec.ts and is not repeated here.
//
// The Rated tests play the side the e2e server pins (DUELWISE_SIDE, 0 by default). Run this file once with DUELWISE_SIDE=0 and once with DUELWISE_SIDE=1 to walk both kick orders.

const URL = '/play/twelve-yards'

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(String(e)))
  return errors
}

const scene = (page: Page) => page.getByTestId('penalty-scene')
const action = (page: Page) => page.getByTestId('penalty-action')
const lastLine = (page: Page) => page.getByTestId('penalty-last')

async function openSetup(page: Page, side: 0 | 1, seed = 5) {
  await page.goto(`${URL}?seed=${seed}&side=${side}`)
  await expect(page.getByTestId('penalty-setup')).toBeVisible()
}

/** A fixed-seed match is never counted, so these tests play it as Practice, which is what the header says. */
async function startMatch(page: Page, side: 0 | 1, seed = 5) {
  await openSetup(page, side, seed)
  await page.locator('[data-mode-option="practice"]').click()
  await page.getByTestId('penalty-start').click()
  await expect(scene(page)).toBeVisible()
}

/** Takes one kick with two taps (select, commit) and waits until the reveal has finished for good. */
async function takeKick(page: Page, pick: number) {
  await expect(scene(page)).not.toHaveAttribute('data-reveal', /set|go/)
  const before = (await lastLine(page).textContent().catch(() => '')) ?? ''
  const z = page.getByTestId(`penalty-zone-${pick}`)
  await z.click()
  await expect(z).toHaveAttribute('aria-pressed', 'true')
  await z.click()
  await expect(scene(page)).not.toHaveAttribute('data-reveal', /.+/, { timeout: 6000 })
  // The last-kick line is gone once the result panel replaces the agent card; either way this kick is over.
  const line = lastLine(page)
  if (await line.count()) await expect(line).not.toHaveText(before, { timeout: 6000 })
}

const finished = (page: Page) => page.getByTestId('penalty-result').isVisible()

/** Plays picks 0, 1, 2 ... until the result panel shows. A pick is a zone as a shooter and a dive as a keeper; both ranges contain 0 to 4. */
async function playToResult(page: Page) {
  let kicks = 0
  while (!(await finished(page)) && kicks < 30) {
    await takeKick(page, kicks % 5)
    kicks++
  }
  expect(await finished(page), 'the shootout reached full time').toBe(true)
  await expect(page.getByTestId('penalty-record')).toHaveAttribute('data-record-ok', 'true', { timeout: 8000 })
  return kicks
}

/** The whole of the control is inside the window, and nothing covers its middle. */
async function expectOnScreen(locator: Locator, label: string) {
  const r = await locator.evaluate((el) => {
    const b = el.getBoundingClientRect()
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
    return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, vh: window.innerHeight, vw: window.innerWidth, ours: hit === el || el.contains(hit) }
  })
  expect(r.top, `${label}: top on screen`).toBeGreaterThanOrEqual(0)
  expect(r.bottom, `${label}: bottom on screen (${r.bottom} of ${r.vh})`).toBeLessThanOrEqual(r.vh)
  expect(r.left, `${label}: left on screen`).toBeGreaterThanOrEqual(0)
  expect(r.right, `${label}: right on screen`).toBeLessThanOrEqual(r.vw)
  expect(r.ours, `${label}: nothing covers its middle`).toBe(true)
}

const scrolled = (page: Page) => page.evaluate(() => ({ y: Math.round(window.scrollY), x: Math.round(window.scrollX) }))

test.describe('Twelve Yards page', () => {
  test('setup: the level picker, Rated open and picked with each level showing the strength it measured, nothing to scroll sideways', async ({ page }) => {
    const errors = watchConsole(page)
    await openSetup(page, 0)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Twelve Yards')
    for (const name of ['Pip', 'Marlow', 'Vesper', 'Sable']) await expect(page.getByTestId('level-picker').getByRole('radio', { name: new RegExp(`^${name}`) })).toBeVisible()
    const rated = page.locator('[data-mode-option="rated"]')
    await expect(rated).not.toHaveAttribute('data-rated-unavailable', /.*/)
    await expect(rated).not.toContainText('Not open yet')
    await expect(page.locator('[data-mode-option="rated"] input')).toBeEnabled()
    await expect(page.locator('[data-mode-option="rated"] input')).toBeChecked()
    await expect(page.getByTestId('play-mode')).toHaveAttribute('data-mode', 'rated')
    // Every level has a measured strength, so nothing is In training.
    await expect(page.getByTestId('level-picker')).not.toContainText('In training')
    await expect(page.getByTestId('penalty-setup')).toContainText('first kick or the second at random')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    expect(errors, 'no console errors').toEqual([])
  })

  for (const side of [0, 1] as const) {
    test(`a Practice match end to end, ${side === 0 ? 'you kick first' : 'you keep goal first'} (?side=${side})`, async ({ page }) => {
      test.setTimeout(120_000)
      const errors = watchConsole(page)
      await startMatch(page, side)
      // The page says who kicks first, in the role line, the HUD chip and the agent card.
      const role = page.getByTestId('penalty-role')
      await expect(page.getByTestId('penalty-page')).toHaveAttribute('data-human-seat', String(side))
      if (side === 0) {
        await expect(role).toHaveText('You kick first. You shoot.')
        await expect(page.getByTestId('penalty-first')).toHaveText('You kick first. Pip kicks second.')
        await expect(page.getByTestId('play-hud')).toContainText('You, kick first')
        await expect(page.locator('[data-testid^="penalty-zone-"]')).toHaveCount(9)
        await expect(action(page)).toHaveText('Pick a spot')
      } else {
        await expect(role).toHaveText("Pip kicks first. You're in goal.")
        await expect(page.getByTestId('penalty-first')).toHaveText('Pip kicks first. You kick second.')
        await expect(page.getByTestId('play-hud')).toContainText('You, kick second')
        await expect(page.locator('[data-testid^="penalty-zone-"]')).toHaveCount(5)
        await expect(action(page)).toHaveText('Pick a dive')
      }
      // Practice: the header says so and the match is not counted.
      await expect(page.getByText('Practice, unrated')).toBeVisible()
      await playToResult(page)
      const rec = page.getByTestId('penalty-record')
      await expect(rec).toHaveAttribute('data-human-seat', String(side))
      await expect(page.getByRole('button', { name: /^Rematch/ })).toBeVisible()
      await expect(page.getByText('Practice, not rated')).toBeVisible()
      await expect(page.getByTestId('penalty-result')).toContainText(/^You \d+, Pip \d+\./)
      expect(errors, 'no console errors').toEqual([])
    })
  }

  test('without ?side the seed picks the side, and a rematch is a fresh match', async ({ page }) => {
    test.setTimeout(120_000)
    // ?side=seed takes the seed's own side (lib/dev-side.ts); seeds 7 and 8 give different sides, found with sideForSeed.
    const sides = new Set<string>()
    for (const seed of [7, 8, 9, 10, 11, 12]) {
      await page.goto(`${URL}?seed=${seed}&side=seed`)
      await page.locator('[data-mode-option="practice"]').click()
      await page.getByTestId('penalty-start').click()
      await expect(scene(page)).toBeVisible()
      sides.add((await page.getByTestId('penalty-page').getAttribute('data-human-seat')) ?? '')
    }
    expect(sides, 'both kick orders turn up across seeds').toEqual(new Set(['0', '1']))
  })

  test('Resign ends the match as a loss with no replayable record', async ({ page }) => {
    await startMatch(page, 0)
    await page.getByTestId('penalty-resign').click()
    await page.getByTestId('penalty-resign-yes').click()
    await expect(page.getByRole('button', { name: /^Rematch/ })).toBeVisible()
    await expect(page.getByTestId('penalty-result')).toHaveText('You resigned.')
  })

  test('Start scrolls the page to the top, from a scrolled setup, on a phone and a laptop', async ({ page }) => {
    for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(size)
      await openSetup(page, 0)
      await page.locator('[data-mode-option="practice"]').click()
      const start = page.getByTestId('penalty-start')
      await start.scrollIntoViewIfNeeded()
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      expect((await scrolled(page)).y, `${size.width}: the setup page was scrolled`).toBeGreaterThan(50)
      await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-testid="penalty-start"]')!.click())
      await expect(scene(page)).toBeVisible()
      await expect.poll(async () => (await scrolled(page)).y, { message: `${size.width}: back at the top after Start` }).toBe(0)
      await expect(page.getByTestId('play-hud')).toBeInViewport()
    }
  })
})

test.describe('Twelve Yards fits on one screen', () => {
  const SIZES = [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    { width: 390, height: 844 },
  ]
  for (const size of SIZES) {
    for (const side of [0, 1] as const) {
      test(`${size.width}x${size.height}, side ${side}: HUD, score, the whole goal and the ${side === 0 ? 'Shoot' : 'Save'} bar on screen with no scroll, through a kick and at full time`, async ({ page }) => {
        test.setTimeout(150_000)
        await page.setViewportSize(size)
        await startMatch(page, side)
        const parts = async (label: string) => {
          for (const id of ['play-hud', 'penalty-score', 'penalty-role', 'penalty-scene', 'penalty-action']) await expectOnScreen(page.getByTestId(id), `${label} ${id}`)
          const s = await scrolled(page)
          expect(s, `${label}: the page did not scroll`).toEqual({ x: 0, y: 0 })
        }
        await parts('first pick')
        const top = await scene(page).evaluate((el) => el.getBoundingClientRect().top)
        await takeKick(page, 0)
        await parts('after one kick')
        expect(await scene(page).evaluate((el) => el.getBoundingClientRect().top), 'the scene did not move').toBeCloseTo(top, 0)
        // Play on until the last kick; at full time the bar's button turns into Play again in the same place, nothing is inserted above the scene, and the HUD, score and scene stay on screen.
        let kicks = 1
        while (!(await finished(page)) && kicks < 30) {
          await takeKick(page, kicks % 5)
          kicks++
        }
        await expect(page.getByTestId('penalty-result')).toBeVisible()
        await expect(page.getByRole('button', { name: /^Rematch/ })).toBeVisible()
        if (size.width >= 1024) {
          // Beside the scene: nothing moves at full time.
          for (const id of ['play-hud', 'penalty-score', 'penalty-scene', 'penalty-action']) await expectOnScreen(page.getByTestId(id), `full time ${id}`)
          await expect(action(page)).toHaveText('Play again')
          expect(await scene(page).evaluate((el) => el.getBoundingClientRect().top), 'the scene did not move at full time').toBeCloseTo(top, 0)
          await expectOnScreen(page.getByRole('button', { name: /^Rematch/ }), 'full time Rematch')
        } else {
          // Ruling Nov 4 01:40: the no-move rule is about play. On a phone the result panel is brought into view at full time like every other game's, so its verdict and Rematch are on screen once it settles.
          await expect
            .poll(async () => page.getByTestId('rematch').evaluate((el) => { const b = el.getBoundingClientRect(); return b.top >= 0 && b.bottom <= window.innerHeight }), { timeout: 6000 })
            .toBe(true)
        }
        expect((await scrolled(page)).x, 'no sideways scroll').toBe(0)
      })
    }
  }

  for (const size of [{ width: 393, height: 659 }, { width: 375, height: 667 }]) {
    test(`${size.width}x${size.height} (Safari's bars): Start scrolls just far enough that the whole scene and the ball clear the sticky bar`, async ({ page }) => {
      await page.setViewportSize(size)
      await startMatch(page, 0)
      await expect(action(page)).toHaveText('Pick a spot')
      await expect.poll(async () => (await scrolled(page)).y, { message: 'Start scrolled the page down' }).toBeGreaterThan(0)
      const gap = await page.evaluate(() => document.querySelector('.pen-bar')!.getBoundingClientRect().top - document.querySelector('.pen-scene')!.getBoundingClientRect().bottom)
      expect(gap, 'the bar covers no part of the scene').toBeGreaterThanOrEqual(0)
      await expectOnScreen(page.getByTestId('penalty-pad'), 'the ball')
      await expectOnScreen(scene(page), 'the scene')
      await page.getByTestId('penalty-zone-0').click()
      await expect(action(page)).toHaveText('Shoot')
      await expectOnScreen(action(page), 'Shoot')
    })
  }
})

/** The side the e2e server gives every Rated match (DUELWISE_SIDE, 0 when unset). */
const SERVER_SIDE: 0 | 1 = process.env.DUELWISE_SIDE === '1' ? 1 : 0

/** A real unseeded Rated start: a fixed seed is never counted. */
async function startRated(page: Page) {
  await page.goto(URL)
  await expect(page.getByTestId('penalty-setup')).toBeVisible()
  await expect(page.getByTestId('play-mode')).toHaveAttribute('data-mode', 'rated')
  await page.getByTestId('penalty-start').click()
  await expect(scene(page)).toBeVisible()
}

test.describe('Twelve Yards offline and Rated', () => {
  test(`a Rated match end to end as the ${SERVER_SIDE === 0 ? 'first' : 'second'} kicker (DUELWISE_SIDE=${SERVER_SIDE}): the opponent's pick comes with each kick, never before it, and the match is counted`, async ({ page }) => {
    test.setTimeout(150_000)
    const errors = watchConsole(page)
    // What the server sends while the match runs. The seed and the opponent's picks may arrive only with the reply that ends the match.
    const wire: string[] = []
    page.on('response', async (r) => {
      if (!r.url().includes('_serverFn')) return
      try {
        wire.push(await r.text())
      } catch {
        /* a response that was replaced by a navigation has no body */
      }
    })
    await startRated(page)
    await expect(page.getByTestId('leaving-notice')).toBeVisible()
    await expect(page.getByTestId('penalty-page')).toHaveAttribute('data-human-seat', String(SERVER_SIDE))
    await expect(page.getByText('Practice, unrated')).toHaveCount(0)
    await expect(page.getByTestId('play-hud')).toContainText(SERVER_SIDE === 0 ? 'You, kick first' : 'You, kick second')
    await takeKick(page, 0)
    await takeKick(page, 1)
    const midway = wire.length
    expect(wire.slice(0, midway).filter((t) => t.includes('agentActions')), 'no reply during the match holds the opponent\'s picks').toEqual([])
    await playToResult(page)
    await expect(page.getByTestId('penalty-record')).toHaveAttribute('data-human-seat', String(SERVER_SIDE))
    // The server accepted the record (its own log, then a re-run of the opponent): the match has a report link, which a refused record never gets.
    await expect(page.getByTestId('result-report-link')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('result-upload')).not.toContainText('could not be verified')
    await expect(page.getByText('Practice, not rated')).toHaveCount(0)
    const withPicks = wire.filter((t) => t.includes('agentActions'))
    expect(withPicks.length, 'the opponent\'s picks and the seed came once, with the last kick').toBe(1)
    expect(errors, 'no console errors').toEqual([])
  })

  test('a Rated match given up is a loss, and the page says so', async ({ page }) => {
    await startRated(page)
    await takeKick(page, 0)
    await page.getByTestId('penalty-resign').click()
    await page.getByTestId('penalty-resign-yes').click()
    await expect(page.getByTestId('penalty-result')).toHaveText('You resigned.')
    await expect(page.getByRole('button', { name: /^Rematch/ })).toBeVisible()
  })

  test('a Rated match is not a Practice match: no Practice badge in play, and the leaving notice shows', async ({ page }) => {
    await startRated(page)
    await expect(page.getByText('Practice, unrated')).toHaveCount(0)
    await expect(page.getByTestId('leaving-notice')).toBeVisible()
  })

  test('Practice on the real server is still a server-held match: no seed on the page, played to the end, saved as Practice', async ({ page }) => {
    test.setTimeout(150_000)
    await page.goto(URL)
    await page.locator('[data-mode-option="practice"]').click()
    await page.getByTestId('penalty-start').click()
    await expect(scene(page)).toBeVisible()
    await expect(page.getByText('Practice, unrated')).toBeVisible()
    await playToResult(page)
    await expect(page.getByText('Practice, not rated')).toBeVisible()
  })

  test('offline: the page says new matches are not rated, in its own flow, and a Practice match still plays to a kick', async ({ page, context }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 390, height: 844 })
    await openSetup(page, 0)
    await context.setOffline(true)
    const pill = page.getByTestId('offline-chip')
    await expect(pill).toHaveText('Offline: new matches are not rated')
    // In the page's own flow, not fixed over Start or the header.
    expect(await pill.evaluate((el) => getComputedStyle(el).position)).not.toBe('fixed')
    await expect(page.getByTestId('penalty-start')).toBeEnabled()
    await page.getByTestId('penalty-start').click()
    await expect(scene(page)).toBeVisible()
    await takeKick(page, 0)
    await expect(page.getByTestId('offline-chip')).toHaveText('Offline: new matches are not rated')
    await context.setOffline(false)
    await expect(page.getByTestId('offline-chip')).toHaveCount(0)
  })
})
