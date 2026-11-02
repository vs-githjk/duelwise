import { expect, test, type Page } from '@playwright/test'
import { wordCore } from '@duelwise/core/src/games/word/core.ts'
import { PRODUCT } from '@duelwise/core/src/product.ts'
import { webPort } from '../port.ts'

// The Sunroom build: the adventure path, the name, the call, the result sheet, the voice, the share, the board, the learn graph and settings.

const origin = `http://localhost:${webPort()}`
const guidesSeen = {
  cookies: [],
  origins: [{ origin, localStorage: Object.keys(PRODUCT.games).map((game) => ({ name: `duelwise.how-to-play.${game}`, value: 'seen' })) }],
}

// Seed 2: the Easy opponent needs 5 rounds, so a wrong guess then the answer is a win (same seed the visual spec uses). Not a counted match.
const SEED = 2
const answer = wordCore.init(SEED).answer
const wrong = ['crane', 'slate', 'house'].find((w) => w !== answer)!

/** On Settings (the one place a name is changed after the welcome): types a name and waits for the save. Under a full-suite load the field can be filled before the page hydrates, so the blur never saves; retry until it does. */
async function saveName(page: Page, name: string) {
  await page.goto('/settings')
  await expect(async () => {
    await page.getByTestId('name-field').fill(name)
    await page.getByTestId('name-field').blur()
    await expect(page.getByTestId('name-help')).toHaveText('Saved for the board.', { timeout: 5_000 })
  }).toPass({ timeout: 30_000 })
}

async function guess(page: Page, word: string) {
  await page.getByTestId('word-input').fill(word)
  await page.getByTestId('word-input').press('Enter')
}

async function winAgainstPip(page: Page) {
  await page.goto(`/play/word-duel?seed=${SEED}`)
  await page.getByRole('button', { name: /Start match/ }).click()
  await expect(page.getByTestId('word-input')).toBeVisible()
  await guess(page, wrong)
  await expect(page.locator('[data-testid="lane-you"] [data-letter-cell]')).toHaveCount(5)
  await guess(page, answer)
  await expect(page.getByTestId('result-panel')).toBeVisible()
}

test.describe('adventure path (locks are on)', () => {
  test.use({ storageState: guidesSeen })

  test('a new player starts at Pip: the other three are locked and say what unlocks them', async ({ page }) => {
    await page.goto('/play/word-duel')
    const path = page.getByTestId('path-card')
    await expect(path).toBeVisible()
    await expect(path.getByTestId('path-stop-easy')).toHaveAttribute('data-state', 'current')
    await expect(path.getByTestId('path-stop-easy')).toContainText('You are here')
    for (const [level, prev] of [['medium', 'Pip'], ['hard', 'Marlow'], ['champion', 'Vesper']] as const) {
      await expect(path.getByTestId(`path-stop-${level}`)).toHaveAttribute('data-state', 'locked')
      await expect(path.getByTestId(`path-stop-${level}`)).toContainText(`Locked, beat ${prev}`)
      const radio = page.getByTestId('level-picker').locator(`input[value="${level}"]`)
      await expect(radio).toBeDisabled()
      await expect(page.getByTestId(`path-locked-${level}`)).toContainText(`Locked. Beat ${prev}`)
    }
    await expect(page.getByRole('button', { name: 'Start match vs Pip' })).toBeVisible()
    // Locked avatars are fully opaque (greyed, never see-through), so the connector never shows through them.
    for (const level of ['medium', 'hard', 'champion']) {
      const op = await path.getByTestId(`persona-avatar-${level}`).evaluate((el) => [getComputedStyle(el).opacity, getComputedStyle(el.querySelector('svg')!).opacity])
      expect(op).toEqual(['1', '1'])
    }
    // The current ring is concentric with the avatar and nothing clips it: the ring sits inside its stop with room to spare.
    const geo = await path.getByTestId('path-stop-easy').evaluate((li) => {
      const av = li.querySelector('[data-testid="persona-avatar-easy"]')!.getBoundingClientRect()
      const ring = li.querySelector('[data-testid="path-ring-easy"]')!.getBoundingClientRect()
      const shadow = getComputedStyle(av.width ? li.querySelector('[data-testid="persona-avatar-easy"]')!.parentElement! : li).boxShadow
      return { dx: Math.abs(av.left + av.width / 2 - (ring.left + ring.width / 2)), dy: Math.abs(av.top + av.height / 2 - (ring.top + ring.height / 2)), pad: Math.min(av.left - ring.left, ring.right - av.right, av.top - ring.top, ring.bottom - av.bottom), shadow }
    })
    expect(geo.dx).toBeLessThan(0.5)
    expect(geo.dy).toBeLessThan(0.5)
    expect(geo.pad).toBeGreaterThanOrEqual(6)
    expect(geo.shadow).toContain('6px')
    // No call is made for the player: nothing is checked until they tap one.
    await expect(page.getByTestId('call-picker').locator('input:checked')).toHaveCount(0)
  })

  test('?any=1 opens every stop for testing and is never linked from the page', async ({ page }) => {
    await page.goto('/play/word-duel')
    await expect(page.locator('a[href*="any=1"]')).toHaveCount(0)
    await page.goto('/play/word-duel?any=1')
    await expect(page.getByTestId('level-picker').locator('input[value="champion"]')).toBeEnabled()
  })

  test('an accepted win over Pip shows the clear, unlocks Marlow and offers to play Marlow next (result sheet with a counted upload)', async ({ page }) => {
    await page.goto('/dev/result?game=word&level=easy&outcome=win&call=medium')
    const panel = page.getByTestId('result-panel')
    await expect(panel).toHaveAttribute('data-outcome', 'win')
    await expect(page.getByTestId('result-headline')).toContainText('You beat Pip.')
    await expect(page.getByTestId('result-ladder').getByTestId('ladder-easy')).toContainText('Beaten')
    await expect(page.getByTestId('says-sub')).toHaveText('Marlow is unlocked.')
    await expect(page.getByRole('button', { name: 'Rematch Pip' })).toBeVisible()
    await expect(page.getByTestId('play-next')).toBeVisible()
  })

  test('a win with a fixed test seed is unrated: it clears nothing and unlocks nothing, so back at setup Pip is still the current stop', async ({ page }) => {
    await winAgainstPip(page)
    await expect(page.getByTestId('result-ladder').getByTestId('ladder-easy')).not.toContainText('Beaten')
    await expect(page.getByTestId('says-sub')).toHaveCount(0)
    await expect(page.getByTestId('play-next')).toHaveCount(0)
    await page.getByRole('button', { name: 'Change level' }).click()
    await expect(page.getByTestId('path-stop-easy')).toHaveAttribute('data-state', 'current')
    await expect(page.getByTestId('path-stop-medium')).toHaveAttribute('data-state', 'locked')
    await expect(page.getByTestId('level-picker').locator('input[value="medium"]')).toBeDisabled()
  })
})

test.describe('name, call, result sheet, voice and share', () => {
  test('the name is checked, remembered in the browser and kept by the server (changed in Settings)', async ({ page }) => {
    await page.goto('/settings')
    const field = page.getByTestId('name-field')
    // Filling before the page has hydrated drops the blur handler, so retry until the check answers.
    await expect(async () => {
      await field.fill('me@example.com')
      await field.blur()
      await expect(page.getByTestId('name-help')).toHaveText('Just a name, no links or emails.', { timeout: 3_000 })
    }).toPass({ timeout: 30_000 })
    await field.fill('  Mika   R. ')
    await field.blur()
    await expect(field).toHaveValue('Mika R.')
    await expect(page.getByTestId('name-help')).toHaveText('Saved for the board.')
    await page.reload()
    await expect(page.getByTestId('name-field')).toHaveValue('Mika R.')
    // The server has it too: clearing the browser copy and reloading brings it back from the guest row (same cookie).
    await page.evaluate(() => localStorage.removeItem('duelwise.name'))
    await page.reload()
    await expect(page.getByTestId('name-field')).toHaveValue('Mika R.')
  })

  test('the call is compared with the result, the line is the opponent\'s, and the share text has three lines', async ({ page }) => {
    await page.goto('/play/word-duel')
    await page.getByTestId('call-picker').getByText('Vesper', { exact: true }).click()
    await winAgainstPip(page)
    await expect(page.getByTestId('result-call')).toHaveText('You called Vesper.')
    await expect(page.getByTestId('result-headline')).toContainText('You beat Pip.')
    await expect(page.getByTestId('result-chip')).toHaveText(/^Win in \d+ guesses$/)
    // A win is warm, never snarky.
    const line = (await page.getByTestId('says-line').innerText()).trim()
    expect(line.length).toBeLessThanOrEqual(90)
    expect(line).not.toMatch(/[\u2013\u2014]/)
    const lines = (await page.getByTestId('share-text').innerText()).trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^Duelwise Word Duel, [A-Z][a-z]{2} \d{1,2}$/)
    expect(lines[1]).toMatch(/^Called Vesper\. Beat Pip in \d+ guesses\.$/)
    expect(lines[2]).toMatch(/\/c\/word-duel\/vesper$/)
    // Unranked (not counted) matches never show a rank.
    expect(lines[1]).not.toContain('#')
    await page.getByRole('button', { name: 'Rematch Pip' }).click()
    await expect(page.getByTestId('result-panel')).toHaveCount(0)
  })

  test('a rematch keeps the same call', async ({ page }) => {
    await page.goto('/play/word-duel')
    await page.getByTestId('call-picker').getByText('Sable', { exact: true }).click()
    await winAgainstPip(page)
    await page.getByRole('button', { name: 'Rematch Pip' }).click()
    await expect(page.getByTestId('call-card')).toContainText('Sable')
  })

  test('the opponent speaks the line once with the browser voice, follows the voice switch and says nothing when it is off', async ({ page }) => {
    await page.addInitScript(() => {
      const spoken: string[] = []
      ;(window as unknown as { __spoken: string[] }).__spoken = spoken
      class U {
        text: string
        voice: unknown = null
        lang = ''
        rate = 1
        pitch = 1
        constructor(t: string) {
          this.text = t
        }
      }
      ;(window as unknown as Record<string, unknown>).SpeechSynthesisUtterance = U
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: { speak: (u: U) => spoken.push(u.text), cancel() {}, getVoices: () => [{ name: 'Samantha', lang: 'en-US' }], addEventListener() {} },
      })
    })
    await page.goto('/play/word-duel')
    // The first click anywhere arms the voice (browsers need a gesture): Start match is that click.
    await winAgainstPip(page)
    const line = (await page.getByTestId('says-line').innerText()).trim()
    await expect(page.getByTestId('voice-toggle')).toHaveText('Voice on')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken)).toEqual([line])
    await page.getByTestId('voice-toggle').click()
    await expect(page.getByTestId('voice-toggle')).toHaveText('Voice off')
    expect(await page.evaluate(() => localStorage.getItem('duelwise.voice'))).toBe('off')
    // Toggling it off never speaks again, and turning it back on speaks the same line once at once (that click is the gesture).
    expect(await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.length)).toBe(1)
    await page.getByTestId('voice-toggle').click()
    await expect(page.getByTestId('voice-toggle')).toHaveText('Voice on')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken)).toEqual([line, line])
  })

  test('where the browser has no speech engine the voice chip is not shown and the line is still text', async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance
    })
    await winAgainstPip(page)
    await expect(page.getByTestId('says-line')).toBeVisible()
    await expect(page.getByTestId('voice-toggle')).toHaveCount(0)
  })

  test('a shared link opens the game with the call preset (the name is never asked on a game page)', async ({ page }) => {
    await page.goto('/c/word-duel/vesper')
    await expect(page).toHaveURL(/\/play\/word-duel$/)
    await expect(page.getByTestId('call-picker').locator('input[value="hard"]')).toBeChecked()
    await expect(page.getByTestId('name-field')).toHaveCount(0)
  })

  test('an unknown share link answers a real 404 and still shows the friendly page', async ({ page, request }) => {
    for (const path of ['/c/nope/vesper', '/c/word-duel/nobody']) {
      expect((await request.get(path)).status(), path).toBe(404)
    }
    const res = await page.goto('/c/nope/vesper')
    expect(res!.status()).toBe(404)
    await expect(page.getByText('Page not found')).toBeVisible()
    expect((await request.get('/c/word-duel/vesper')).status()).toBe(200)
    expect((await request.get('/play/nope')).status()).toBe(404)
    expect((await request.get('/play/word-duel')).status()).toBe(200)
  })

  test.describe('a first-time visitor (not yet welcomed)', () => {
    test.use({ storageState: guidesSeen })
    test('a shared link asks for the name once, framed as the challenge, then opens that game at that level', async ({ page }) => {
      await page.goto('/c/word-duel/vesper')
      await expect(page.getByTestId('welcome-intro')).toHaveText('You have been challenged: Word Duel against Vesper.')
      await expect(page.getByTestId('welcome-continue')).toHaveText('Play Word Duel')
      await page.getByTestId('name-field').fill('Challenger')
      await page.getByTestId('welcome-continue').click()
      await expect(page).toHaveURL(/\/play\/word-duel$/)
      await expect(page.getByTestId('call-picker').locator('input[value="hard"]')).toBeChecked()
      expect(await page.evaluate(() => localStorage.getItem('duelwise.name'))).toBe('Challenger')
      // The welcome is done for good: the next shared link and Step in go straight through.
      await page.goto('/c/word-duel/pip')
      await expect(page).toHaveURL(/\/play\/word-duel$/)
      await page.goto('/play')
      await expect(page.getByTestId('welcome')).toHaveCount(0)
    })
  })
})

test.describe('board, learn graph and settings', () => {
  test('the board has a column per opponent, for everybody, with honest empty states and a segmented game switch', async ({ page }) => {
    await page.goto('/leaderboard/word-duel')
    await expect(page.getByTestId('board-title')).toHaveText('Word Duel board, last 30 days')
    for (const level of ['easy', 'medium', 'hard', 'champion']) await expect(page.getByTestId(`board-col-${level}`)).toBeVisible()
    // Earlier specs in the same run may have left matches in the in-memory store, so the numbers are not fixed: an empty column says so, a full one lists rows.
    await expect(page.getByTestId('board-players-easy')).toHaveText(/^[\d,]+ played, [\d,]+ won$/)
    await expect(page.getByTestId('board-rows-easy').or(page.getByTestId('board-empty-easy'))).toBeVisible()
    if (await page.getByTestId('board-empty-easy').count()) await expect(page.getByTestId('board-empty-easy')).toHaveText('No wins at Easy yet. Be the first.')
    await expect(page.getByTestId('leaderboard-switcher').getByRole('link')).toHaveCount(Object.keys(PRODUCT.games).length)
    await page.getByTestId('leaderboard-switcher').getByRole('link', { name: 'Chess' }).click()
    await expect(page).toHaveURL(/\/leaderboard\/chess$/)
    // Real-time games are listed too, and say their records are not re-checked yet.
    await page.goto('/leaderboard/tinderbox')
    await expect(page.getByTestId('board-note')).toContainText('not re-checked on the server yet')
  })

  test('the learn graph is honest per game: Four in a Row learns from people, Word Duel says self-play and test bots', async ({ page }) => {
    await page.goto('/agents/four-in-a-row')
    const four = page.getByTestId('learn-graph')
    await expect(four).toHaveAttribute('data-learns', 'true')
    await expect(four.getByTestId('learn-copy')).toContainText('This game learns from your matches.')
    await expect(four.getByTestId('learn-versions')).toContainText('v2')
    await page.goto('/agents/word-duel')
    const word = page.getByTestId('learn-graph')
    await expect(word).toHaveAttribute('data-learns', 'false')
    await expect(word.getByTestId('learn-copy')).toContainText('trains by self-play and against test bots, not from your matches yet')
    await expect(word).not.toContainText(/every match/i)
    // Pick another opponent for the graph. A click before the page hydrates is lost, so retry until it takes.
    await expect(async () => {
      await word.getByText('Vesper', { exact: true }).click()
      await expect(word.getByTestId('learn-chart-title')).toHaveText('Human win rate vs Vesper, by week', { timeout: 2_000 })
    }).toPass({ timeout: 20_000 })
  })

  test('the game page carries the compact learn card and the same honest words', async ({ page }) => {
    await page.goto('/play/chess')
    const card = page.getByTestId('learn-graph')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('learn-copy')).toContainText('Chess trains by self-play and against test bots')
  })

  test('settings: the name, keep my name, training, leaderboard, sound with voice, and forget me', async ({ page }) => {
    await saveName(page, 'Tomas')
    await expect(page.getByTestId('header-name')).toHaveText('Tomas')
    await expect(page.getByTestId('name-settings').getByTestId('name-field')).toHaveValue('Tomas')
    await expect(page.getByTestId('keep-name')).toContainText('remembered by this browser only')
    await expect(page.getByTestId('keep-name').getByRole('link', { name: 'Continue with Google' })).toBeVisible()
    await expect(page.getByTestId('training-settings').getByRole('switch')).toBeVisible()
    await expect(page.getByTestId('board-settings').getByRole('switch', { name: 'Show me on the leaderboard' })).toBeChecked()
    await expect(page.getByTestId('sound-settings').getByRole('switch', { name: 'Sound' })).toBeChecked()
    await page.getByTestId('forget-me').getByRole('button', { name: 'Forget me here' }).click()
    await expect(page.getByTestId('forget-me')).toContainText('This browser has forgotten you.')
    expect(await page.evaluate(() => localStorage.getItem('duelwise.name'))).toBeNull()
    expect((await page.context().cookies()).some((c) => c.name === 'dw_guest')).toBe(false)
  })

  test('a guest can hide themselves from the board in settings and it sticks', async ({ page }) => {
    await saveName(page, 'Hidey')
    const sw = page.getByTestId('board-settings').getByRole('switch', { name: 'Show me on the leaderboard' })
    await sw.uncheck()
    await expect(sw).not.toBeChecked()
    await page.reload()
    await expect(page.getByTestId('board-settings').getByRole('switch', { name: 'Show me on the leaderboard' })).not.toBeChecked()
  })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('landing, game page, board, learn graph and settings do not scroll sideways at 390', async ({ page }) => {
    for (const route of ['/', '/play', '/play/word-duel', '/leaderboard/word-duel', '/agents/four-in-a-row', '/settings']) {
      await page.goto(route)
      await page.waitForLoadState('networkidle')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, route).toBeLessThanOrEqual(0)
    }
  })
  test('the Word Duel ledger and result sheet fit a phone', async ({ page }) => {
    await winAgainstPip(page)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    for (const id of ['result-panel', 'share-block']) {
      const box = await page.getByTestId(id).boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    }
  })
})
