import { expect, test, type Page } from '@playwright/test'
import { wordCore } from '@duelwise/core/src/games/word/core.ts'
import { feedback } from '@duelwise/core/src/games/word/feedback.ts'

const SEED = 7
const answer = wordCore.init(SEED).answer
const wrongWord = ['crane', 'slate', 'house'].find((w) => w !== answer)!
const SHAPE = ['dash', 'ring', 'dot']

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

async function startMatch(page: Page, seed = SEED) {
  await page.goto(`/play/word-duel?seed=${seed}`)
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId('word-input')).toBeVisible()
}

async function guess(page: Page, word: string) {
  await page.getByTestId('word-input').fill(word)
  await page.getByTestId('word-input').press('Enter')
}

test.describe('Word Duel play page', () => {
  test('uses a native text input and has no tile grid and no on-screen keyboard', async ({ page }) => {
    const errors = watchConsole(page)
    await startMatch(page)
    const input = page.getByTestId('word-input')
    expect(await input.evaluate((el) => el.tagName)).toBe('INPUT')
    await expect(input).toHaveAttribute('type', 'text')
    await expect(input).toHaveAttribute('maxlength', '5')

    // No grid before any guess: no letter cells and no placeholder rows.
    await expect(page.locator('[data-letter-cell]')).toHaveCount(0)
    await guess(page, wrongWord)
    await expect(page.locator('[data-testid="lane-you"] [data-letter-cell]')).toHaveCount(5)
    // Only guessed rows exist: never a 5x6 board of cells.
    expect(await page.locator('[data-letter-cell]').count()).toBeLessThan(30)
    expect(await page.locator('[role="grid"], [role="gridcell"], table').count()).toBe(0)
    // No on-screen keyboard: no single-letter buttons anywhere.
    const letterButtons = await page.getByRole('button').evaluateAll((els) => els.filter((e) => /^[a-zA-Z]$/.test((e.textContent ?? '').trim())).length)
    expect(letterButtons).toBe(0)
    expect(errors).toEqual([])
  })

  test('markers are shape plus colour, and the opponent lane shows markers without letters', async ({ page }) => {
    await startMatch(page)
    await guess(page, wrongWord)
    const mine = page.locator('[data-testid="lane-you"] [data-marker]')
    await expect(mine).toHaveCount(5)
    const expected = Array.from(feedback(wrongWord, answer)).map((k) => SHAPE[k])
    expect(await mine.evaluateAll((els) => els.map((e) => e.getAttribute('data-shape')))).toEqual(expected)
    // Each marker also has an accessible text label so colour is never the only cue.
    for (const label of await mine.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))) expect(label).toMatch(/right spot|in the word|not in the word/)

    const theirs = page.locator('[data-testid="lane-ai"]')
    await expect(theirs.locator('[data-marker]')).toHaveCount(5)
    await expect(theirs.locator('[data-letter-cell]')).toHaveCount(0)

    // Shape and colour both differ between marker kinds (compare any two kinds that appeared).
    const seen = await page.locator('[data-marker]').evaluateAll((els) => els.map((e) => ({ shape: e.getAttribute('data-shape'), color: getComputedStyle(e).color })))
    const byShape = new Map<string | null, string>()
    for (const s of seen) byShape.set(s.shape, s.color)
    expect(new Set(byShape.values()).size).toBe(byShape.size)
  })

  test('rejects a word that is not in the list without spending a round', async ({ page }) => {
    await startMatch(page)
    await guess(page, 'zzzzz')
    await expect(page.getByTestId('guess-error')).toContainText('Not in the word list')
    await expect(page.locator('[data-letter-cell]')).toHaveCount(0)
    await guess(page, 'abc')
    await expect(page.getByTestId('guess-error')).toContainText('Five letters')
  })

  test('plays to the end and the match record replays to its final hash', async ({ page }) => {
    await startMatch(page)
    await guess(page, wrongWord)
    await expect(page.locator('[data-testid="lane-you"] [data-letter-cell]')).toHaveCount(5)
    await guess(page, answer)
    const record = page.getByTestId('word-record')
    await expect(page.getByTestId('result-panel')).toBeVisible()
    await expect(record).toHaveAttribute('data-record-ok', 'true')
    await expect(record).toHaveAttribute('data-final-hash', /^[0-9a-f]{16}$/)
    await expect(record).toHaveAttribute('data-seed', String(SEED))
    // The agent's letters are revealed only after the match, along with the word.
    await expect(page.getByTestId('word-answer')).toContainText(answer)
    await page.getByRole('button', { name: /Rematch/ }).click()
    await expect(page.getByTestId('result-panel')).toHaveCount(0)
    await expect(page.getByTestId('word-input')).toBeVisible()
    await expect(page.locator('[data-letter-cell]')).toHaveCount(0)
  })

  test('works at 360 px with no horizontal scroll, before and after a guess', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto(`/play/word-duel?seed=${SEED}`)
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(await overflow()).toBeLessThanOrEqual(0)
    await page.getByRole('button', { name: 'Start match' }).click()
    await guess(page, wrongWord)
    await expect(page.locator('[data-testid="lane-ai"] [data-marker]')).toHaveCount(5)
    expect(await overflow()).toBeLessThanOrEqual(0)
    const box = await page.getByTestId('word-input').boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(360)
    const lanes = [await page.getByTestId('lane-you').boundingBox(), await page.getByTestId('lane-ai').boundingBox()]
    for (const b of lanes) expect(b!.x + b!.width).toBeLessThanOrEqual(360)
  })

  test('respects reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await startMatch(page)
    await guess(page, wrongWord)
    await expect(page.locator('[data-testid="lane-ai"] [data-marker]')).toHaveCount(5)
    // The flip and marker reveals are skipped: nothing on the lanes is animating right after they appear.
    const running = await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === 'running' && (a.effect as KeyframeEffect | null)?.target?.closest('[data-testid^="lane-"]')).length,
    )
    expect(running).toBe(0)
  })

  test('the letter tracker lists found and ruled-out letters and is not a keyboard', async ({ page }) => {
    await startMatch(page)
    await expect(page.getByTestId('letter-tracker')).toHaveCount(0)
    await guess(page, wrongWord)
    const tracker = page.getByTestId('letter-tracker')
    await expect(tracker).toBeVisible()
    const marks = Array.from(feedback(wrongWord, answer))
    const best = new Map<string, number>()
    Array.from(wrongWord).forEach((c, i) => best.set(c, Math.max(best.get(c) ?? 0, marks[i]!)))
    for (const [c, k] of best) {
      await expect(tracker.locator(`[data-letter="${c}"]`)).toHaveAttribute('data-state', ['out', 'elsewhere', 'placed'][k]!)
    }
    // Only tried letters are listed and none of them is a button.
    expect(await tracker.locator('[data-letter]').count()).toBe(best.size)
    expect(await tracker.getByRole('button').count()).toBe(0)
  })

  test('a refused word shakes the row, and reduced motion keeps the message but skips the movement', async ({ page }) => {
    await startMatch(page)
    await guess(page, 'zzzzz')
    await expect(page.getByTestId('guess-error')).toContainText('Not in the word list')
    await expect(page.getByTestId('guess-row-input')).toHaveAttribute('data-refused', '1')
    const shaking = await page.evaluate(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.target?.getAttribute?.('data-testid') === 'guess-row-input').length)
    expect(shaking).toBe(1)
    await page.waitForFunction(() => document.getAnimations().every((a) => (a.effect as KeyframeEffect | null)?.target?.getAttribute?.('data-testid') !== 'guess-row-input'))

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await guess(page, 'yyyyy')
    await expect(page.getByTestId('guess-row-input')).toHaveAttribute('data-refused', '2')
    const still = await page.evaluate(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.target?.getAttribute?.('data-testid') === 'guess-row-input').length)
    expect(still).toBe(0)
    await expect(page.getByTestId('guess-error')).toContainText('Not in the word list')
  })

  test('the answer is revealed inside the result card', async ({ page }) => {
    await startMatch(page)
    await guess(page, answer)
    const panel = page.getByTestId('result-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('word-answer')).toContainText(answer)
    await expect(panel.getByTestId('word-answer').locator('.tile')).toHaveCount(5)
  })

  test('with a phone keyboard open (a short viewport) the guess row stays in view', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    // Seed 2 (answer RUDDY): the Easy opponent solves it in round 5, so two guesses never end the match. Seed 7 let it solve in round 2.
    await startMatch(page, 2)
    await guess(page, 'crane')
    await guess(page, 'slate')
    // The keyboard takes about 300 px: shrink the visible height and let the page react.
    await page.setViewportSize({ width: 390, height: 440 })
    await page.getByTestId('word-input').focus()
    const row = page.getByTestId('guess-row-input')
    await expect.poll(async () => row.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight })).toBe(true)
  })

  test('a counted match never sends the hidden word to the browser before it ends', async ({ page }) => {
    const bodies: Array<{ url: string; text: string }> = []
    const sent: string[] = []
    page.on('request', (req) => {
      const post = req.postData()
      if (post && post.includes('guesses')) sent.push(post)
    })
    page.on('response', async (res) => {
      const t = res.request().resourceType()
      if (t !== 'fetch' && t !== 'xhr') return
      bodies.push({ url: res.url(), text: await res.text().catch(() => '') })
    })
    await page.goto('/play/word-duel')
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(page.getByTestId('word-input')).toBeVisible()
    const words = ['crane', 'slate', 'house', 'pilot', 'mound', 'fjord']
    let n = 0
    while ((await page.getByTestId('result-panel').count()) === 0 && n < words.length) {
      await guess(page, words[n++]!)
      await expect.poll(async () => (await page.getByTestId('result-panel').count()) + (await page.locator('[data-testid="lane-you"] [data-letter-cell]').count()), { timeout: 15_000 }).toBeGreaterThanOrEqual(5 * n)
    }
    await expect(page.getByTestId('result-panel')).toBeVisible()
    const hidden = (await page.getByTestId('word-answer').textContent())!.replace('The word was', '').trim().toLowerCase()
    expect(hidden).toMatch(/^[a-z]{5}$/)
    // Before the last marking call, no response carries the word; the last one (the reveal) does.
    const marks = bodies.filter((b) => !b.url.includes('/play/') && b.text.length > 0)
    const mentions = (t: string) => new RegExp(`(?<![a-z])${hidden}(?![a-z])`, 'i').test(t)
    expect(marks.length).toBeGreaterThan(1)
    // The start reply withholds the seed (the word is a function of it), so nothing in it can be turned into the word.
    const started = marks.find((b) => b.text.includes('matchId'))!
    expect(started.text).toContain('sealed')
    // Only my own words go to the server, and the opponent's words come back only in the final reveal.
    expect(sent.length).toBeGreaterThan(0)
    for (const body of sent) expect(body).not.toContain('agentGuesses')
    const withAgentWords = marks.filter((b) => b.text.includes('agentGuesses'))
    expect(withAgentWords.length).toBe(1)
    expect(withAgentWords[0]).toBe(marks.find((b) => b.text.includes('reveal')))
    expect(started.text).not.toMatch(/"?seed"?\s*[:=]\s*[1-9]/)
    const lastReveal = marks.map((b, i) => (mentions(b.text) ? i : -1)).filter((i) => i >= 0)
    expect(lastReveal.length).toBeGreaterThan(0)
    expect(Math.min(...lastReveal)).toBeGreaterThanOrEqual(marks.findIndex((b) => b.text.includes('reveal')))
  })

  test('announces your marks and the opponent progress after each guess, in a polite live region', async ({ page }) => {
    await startMatch(page)
    const live = page.getByTestId('word-announce')
    await expect(live).toHaveAttribute('aria-live', 'polite')
    await expect(live).toHaveText('')
    await guess(page, wrongWord)
    await expect(live).toContainText('Round 1 of 6.')
    await expect(live).toContainText(`You guessed ${wrongWord.toUpperCase()}`)
    await expect(live).toContainText(/(right spot|not in the word|wrong spot)/)
    await expect(live).toContainText(/(letters in the right spot in its best row|solved the word)/)
  })

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 412, height: 839 }, hasTouch: true, isMobile: true })

    test('the score stays in view through a match, with the keyboard open too', async ({ page }) => {
      await startMatch(page, 2)
      const seen = (id: string) => page.getByTestId(id).evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight })
      for (const word of ['crane', 'slate', 'pilot']) {
        await guess(page, word)
        await page.waitForTimeout(600)
        expect(await seen('race-bar'), `score after ${word}`).toBe(true)
        expect(await seen('word-input'), `input after ${word}`).toBe(true)
      }
      await page.setViewportSize({ width: 412, height: 500 })
      await page.getByTestId('word-input').focus()
      await expect.poll(() => seen('race-bar')).toBe(true)
      await expect.poll(() => seen('word-input')).toBe(true)
    })

    test('nothing at the top is under 14 px and the opponent header is not cut off', async ({ page }) => {
      await page.goto('/play/word-duel?seed=2')
      await page.getByRole('radio', { name: /^Vesper Hard/ }).check({ force: true }) // the pinned Start bar sits over the row on a phone screen
      await page.getByRole('button', { name: 'Start match' }).click()
      await expect(page.getByTestId('word-input')).toBeVisible()
      await guess(page, 'crane')
      await expect(page.locator('[data-testid="lane-you"] [data-letter-cell]')).toHaveCount(5)
      const small = await page.evaluate(() => {
        const out: string[] = []
        for (const root of document.querySelectorAll('[data-testid="race-bar"], [data-testid="word-ledger"], [data-testid="letter-tracker"], [data-testid="play-hud"], [data-testid="header-persona"]')) {
          for (const e of root.querySelectorAll('*')) {
            if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())) continue
            if (e.closest('.sr-only')) continue
            if (parseFloat(getComputedStyle(e).fontSize) < 14) out.push(`${e.textContent} ${getComputedStyle(e).fontSize}`)
          }
        }
        return out
      })
      expect(small).toEqual([])
      const cut = await page.getByTestId('ledger-opponent').evaluate((el) => el.scrollWidth > el.clientWidth)
      expect(cut).toBe(false)
      await expect(page.getByTestId('ledger-opponent')).toContainText('Vesper')
    })

    test('the result panel shows both sides\' final score', async ({ page }) => {
      const answer2 = wordCore.init(2).answer
      await startMatch(page, 2)
      await guess(page, answer2)
      const score = page.getByTestId('word-result-score')
      await expect(score).toBeVisible()
      await expect(score).toContainText('Solved in 1')
      await expect(page.getByTestId('result-panel').getByTestId('word-result-score')).toHaveCount(1)
    })
  })
})
