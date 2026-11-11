import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { visibleRegistry } from '../src/lib/strength-gates'
import { publishedLevels } from './published-levels'
import { wordCore } from '@duelwise/core/src/games/word/core.ts'

// JB1: one opponent name, honest copy, no internals.

test.describe('opponent is named by persona, never by the product', () => {
  test('chess result sentence and side card say Pip', async ({ page }) => {
    await page.goto(`/play/chess?seed=3&fen=${encodeURIComponent('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1')}`)
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(page.getByTestId('agent-card')).toContainText('Pip')
    await expect(page.getByTestId('agent-card')).not.toContainText('Duelwise')
    await page.getByTestId('sq-a1').click()
    await page.getByTestId('sq-a8').click()
    await expect(page.getByTestId('result-panel')).toBeVisible()
    const reason = await page.getByTestId('result-reason').innerText()
    expect(reason).not.toContain('Duelwise')
    expect(reason).toContain('Pip')
  })

  test('word and four play pages never show the product as the opponent', async ({ page }) => {
    for (const slug of ['word-duel', 'four-in-a-row']) {
      await page.goto(`/play/${slug}`)
      await page.getByRole('radio', { name: /Easy/ }).check()
      await page.getByRole('button', { name: 'Start match' }).click()
      await expect(page.getByTestId('agent-card')).toBeVisible()
      await expect(page.getByTestId('agent-card')).toContainText('Pip')
      await expect(page.getByTestId('agent-card')).not.toContainText('Duelwise')
    }
  })

  test('four, word and hold\'em result panels name the persona and never the product', async ({ page }) => {
    test.setTimeout(180_000)
    const named = async () => {
      await expect(page.getByTestId('result-panel')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('result-persona')).toContainText('Pip')
      const reason = await page.getByTestId('result-reason').innerText()
      expect(reason).not.toContain('Duelwise')
      // The share text carries the product name on purpose (it is what a friend reads); everywhere else the opponent is a persona.
      const panelText = await page.getByTestId('result-panel').evaluate((el) => {
        const clone = el.cloneNode(true) as HTMLElement
        clone.querySelector('[data-testid="share-block"]')?.remove()
        return clone.innerText ?? clone.textContent ?? ''
      })
      expect(panelText).not.toContain('Duelwise')
    }
    // Four in a Row: resign.
    await page.goto('/play/four-in-a-row?seed=3')
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    await page.getByRole('button', { name: /^resign$/i }).click()
    await page.getByRole('button', { name: 'Yes, resign' }).click()
    await named()
    // Word Duel: one wrong guess, then the answer.
    await page.goto('/play/word-duel?seed=7')
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    const answer = wordCore.init(7).answer
    const wrong = ['crane', 'slate', 'house'].find((w) => w !== answer)!
    for (const w of [wrong, answer]) {
      await page.getByTestId('word-input').fill(w)
      await page.getByTestId('word-input').press('Enter')
    }
    await named()
    // Hold'em: concede.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/play/heads-up-holdem?seed=3')
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(page.getByTestId('holdem-table')).toHaveAttribute('data-turn', /you|over/, { timeout: 20_000 })
    await page.getByRole('button', { name: 'Concede' }).click()
    await page.getByRole('button', { name: 'Yes, concede' }).click()
    await named()
  })
})

test.describe('training copy and site Elo', () => {
  test("dismissing the Hold'em notice does not hide the full notice and switch on a game that trains", async ({ page }) => {
    await page.goto('/play/heads-up-holdem')
    await page.getByTestId('training-notice').getByRole('button', { name: 'Got it' }).click()
    await expect(page.getByTestId('training-notice')).toHaveCount(0)
    await page.goto('/play/four-in-a-row')
    const notice = page.getByTestId('training-notice')
    await expect(notice).toBeVisible()
    await expect(notice.getByRole('switch')).toHaveCount(1)
    await expect(notice).toContainText('may use it to train')
  })

  test('every game whose agent does not learn from humans yet says so and offers no switch', async ({ page }) => {
    for (const slug of ['chess', 'word-duel', 'tinderbox', 'coldstore']) {
      await page.goto(`/play/${slug}`)
      const notice = page.getByTestId('training-notice')
      await expect(notice, slug).toContainText('does not learn from human matches yet')
      await expect(notice, slug).not.toContainText('may use it to train')
      await expect(notice.getByRole('switch'), slug).toHaveCount(0)
    }
  })

  test('Glasscut says its matches are Practice and not used to train anything, and offers no training switch', async ({ page }) => {
    await page.goto('/play/glasscut')
    const prematch = page.getByTestId('prematch')
    await expect(prematch).toBeVisible()
    await expect(prematch).not.toContainText('may use it to train')
    await expect(prematch).toContainText(/not (from|used)|does not learn|Practice/)
    await expect(page.getByRole('switch')).toHaveCount(0)
    // The note under the level cards appears only while a Glasscut level is in training; A9 published Pip and Marlow, so it follows the registry.
    if (publishedLevels('puck').length < 4) await expect(page.getByTestId('practice-note')).toContainText('Levels in training have not passed our strength test')
    else await expect(page.getByTestId('practice-note')).toHaveCount(0)
  })

  test("Hold'em says its matches are not used for training and offers no switch", async ({ page }) => {
    await page.goto('/play/heads-up-holdem')
    const notice = page.getByTestId('training-notice')
    await expect(notice).toContainText('not used to train')
    await expect(notice.getByRole('switch')).toHaveCount(0)
  })

  test('site Elo is explained in plain words wherever it is shown', async ({ page }) => {
    // The picker shows the explainer only while a level has a verified strength (R43); the agents page always does.
    const chess = visibleRegistry(JSON.parse(readFileSync(new globalThis.URL('../../../packages/agents/registry/chess.json', import.meta.url), 'utf8')))
    const anyMeasured = (['easy', 'medium', 'hard', 'champion'] as const).some((l) => chess.levels[l] && chess.measured[l])
    await page.goto('/play/chess')
    await expect(page.getByTestId('level-picker').getByTestId('elo-explainer')).toHaveCount(anyMeasured ? 1 : 0)
    await page.goto('/agents/chess')
    const ex = page.getByTestId('elo-explainer').first()
    await ex.locator('summary').click()
    await expect(ex).toContainText('Easy is pinned at 1000')
    await expect(ex).toContainText('200 points')
    await expect(ex).toContainText('not a FIDE or chess.com rating')
  })

  test('chess agents page says Easy and Medium learned from Lichess, and shows no job names to a guest', async ({ page }) => {
    await page.goto('/agents/chess')
    await expect(page.getByTestId('learns-note')).toContainText('Lichess human games')
    await expect(page.getByTestId('learns-note')).not.toContainText(/self-play only/i)
    await expect(page.getByTestId('card-jobs')).toHaveCount(0)
    await expect(page.getByTestId('elo-explainer').first()).toBeVisible()
  })

  test('every Coldstore level is published, so none wears an In training or Preview badge', async ({ page }) => {
    // Every level of every game is published now; a level that is in training would show the In training badge alone, never also a Preview one.
    await page.goto('/play/coldstore')
    // The zero count below proves nothing unless the picker rendered with all four levels.
    const picker = page.getByTestId('level-picker')
    await expect(picker).toBeVisible()
    await expect(picker.locator('label[data-persona]')).toHaveCount(4)
    await expect(picker.getByTestId('preview-badge')).toHaveCount(0)
  })
})
