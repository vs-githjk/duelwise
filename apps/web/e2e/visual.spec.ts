import { expect, test, type Page } from '@playwright/test'
import { makeRng } from '@duelwise/core/src/rng.ts'
import { fourCore } from '@duelwise/core/src/games/four/core.ts'
import { wordCore } from '@duelwise/core/src/games/word/core.ts'

/**
 * Design v2 play surfaces (T42c): chess, Four in a Row and Word Duel, each at 1440 and 390 in both
 * themes, plus DOM checks for the shared HUD, the result panel and the per-game surface parts.
 * Baselines live in e2e/__screens__. Motion is reduced and the clock is masked so a shot is stable.
 */
test.describe.configure({ timeout: 180_000 })

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
] as const
const SCHEMES = ['light', 'dark'] as const

/** Photographs `[data-testid="game-shell"]` in every viewport and theme without restarting the match. */
async function shoot(page: Page, name: string) {
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height })
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await expect(page.getByTestId('game-shell')).toHaveScreenshot(`${name}-${vp.name}-${scheme}.png`, {
        animations: 'disabled',
        mask: [page.locator('[data-volatile]')],
        maxDiffPixelRatio: 0.01,
      })
    }
  }
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
}

async function dismissNotice(page: Page) {
  await page.getByRole('button', { name: 'Got it' }).click({ timeout: 5000 }).catch(() => {})
}

function winSeed(): number {
  for (let seed = 1; seed < 5000; seed++) {
    const rng = makeRng(seed)
    let state = fourCore.init(seed)
    let ok = true
    for (let i = 0; i < 4 && ok; i++) {
      if (!fourCore.legal(state, 0).includes(0)) { ok = false; break }
      state = fourCore.step(state, [0, null])
      if (fourCore.terminal(state)) break
      const legal = fourCore.legal(state, 1)
      const column = legal[rng.int(legal.length)]!
      state = fourCore.step(state, [null, column])
      if (fourCore.terminal(state)) ok = false
    }
    if (ok && fourCore.result(state)?.winner === 0) return seed
  }
  throw new Error('no seed found')
}

test.describe('Design v2 play surfaces', () => {
  test('chess: lit board, shaded pieces, last-move tint, HUD, result panel', async ({ page }) => {
    await page.goto(`/play/chess?seed=3&fen=${encodeURIComponent('r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4')}`)
    await dismissNotice(page)
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    const board = page.getByTestId('chess-board')
    await expect(board).toBeVisible({ timeout: 90_000 })
    await expect(board).toHaveAttribute('data-turn', 'you')
    await expect(page.getByTestId('play-hud')).toBeVisible()
    await expect(page.getByTestId('play-hud-clock')).toBeVisible()
    await expect(page.getByTestId('board-frame')).toBeVisible()
    await expect(page.locator('[data-testid="piece"]').first().locator('[data-piece-shadow]')).toHaveCount(1)
    await shoot(page, 'chess-play')
    await noHorizontalScroll(page)
  })

  test('chess: the last move is tinted and the result panel follows a mate', async ({ page }) => {
    await page.goto(`/play/chess?seed=3&fen=${encodeURIComponent('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1')}`)
    await dismissNotice(page)
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    const board = page.getByTestId('chess-board')
    await expect(board).toBeVisible({ timeout: 90_000 })
    await page.getByTestId('sq-f7').click()
    await page.getByTestId('sq-g7').click()
    await expect(page.getByTestId('result-panel')).toBeVisible()
    await expect(page.getByTestId('sq-f7')).toHaveAttribute('data-last', '')
    await expect(page.getByTestId('sq-g7')).toHaveAttribute('data-last', '')
    await expect(page.getByTestId('sq-h8')).toHaveAttribute('data-check', '')
    await expect(page.getByTestId('result-panel').locator('[data-result-stripe]')).toHaveCount(1)
    await shoot(page, 'chess-over')
  })

  test('four: depth, landing ghost, winning-line glow, HUD, result panel', async ({ page }) => {
    await page.goto(`/play/four-in-a-row?seed=${winSeed()}&opponent=random`)
    await dismissNotice(page)
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    const board = page.getByTestId('four-board')
    await expect(board).toBeVisible()
    await expect(page.getByTestId('play-hud')).toBeVisible()
    await expect(page.getByTestId('four-slab')).toBeVisible()
    await page.getByTestId('col-0').hover()
    await expect(page.getByTestId('landing-ghost')).toHaveCount(1)
    for (let i = 0; i < 4; i++) {
      await expect(board).toHaveAttribute('data-turn', /you|over/)
      await expect(board).not.toHaveAttribute('data-settling', 'true')
      if (i === 2) await shoot(page, 'four-play')
      await page.getByTestId('col-0').click()
    }
    await expect(page.getByTestId('result-panel')).toBeVisible()
    await expect(page.getByTestId('win-line')).toHaveCount(1)
    await page.mouse.move(0, 0)
    // Guard: no frame layer may cover a stone. With the column overlay out of the way, the topmost
    // element at each disc centre must be inside a disc.
    await page.addStyleTag({ content: '[data-testid="four-board"] > div { pointer-events: none !important; }' })
    const hidden = await page.evaluate(() => {
      const bad: number[] = []
      document.querySelectorAll('[data-testid="disc"]').forEach((d, i) => {
        const r = d.getBoundingClientRect()
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        if (!top || !top.closest('[data-testid="disc"]')) bad.push(i)
      })
      return { bad, total: document.querySelectorAll('[data-testid="disc"]').length }
    })
    expect(hidden.total).toBeGreaterThanOrEqual(7)
    expect(hidden.bad).toEqual([])
    await shoot(page, 'four-over')
  })

  test('word: round ledger, tiles, round card, result panel', async ({ page }) => {
    // Seed 2 (answer RUDDY): the Easy opponent needs 5 rounds, so a wrong guess then the answer is a win. Seed 7 let it solve in round 2 (a draw) since the answer list changed.
    const answer = wordCore.init(2).answer
    const wrong = ['crane', 'slate', 'house'].find((w) => w !== answer)!
    await page.goto('/play/word-duel?seed=2')
    await dismissNotice(page)
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(page.getByTestId('word-input')).toBeVisible()
    await expect(page.getByTestId('play-hud')).toBeVisible()
    await expect(page.getByTestId('race-bar')).toBeVisible()
    await page.getByTestId('word-input').fill(wrong)
    await page.getByTestId('word-input').press('Enter')
    await expect(page.locator('[data-testid="lane-you"] [data-letter-cell]')).toHaveCount(5)
    await expect(page.locator('[data-testid="lane-you"] [data-tile]').first()).toBeVisible()
    await expect(page.getByTestId('word-ledger')).toHaveAttribute('data-paper', '')
    await expect(page.getByTestId('race-bar-you')).toHaveAttribute('data-guesses', '1')
    await shoot(page, 'word-play')
    await page.getByTestId('word-input').fill(answer)
    await page.getByTestId('word-input').press('Enter')
    await expect(page.getByTestId('result-panel')).toBeVisible()
    await expect(page.getByTestId('race-bar-you')).toHaveAttribute('data-solved', 'true')
    await shoot(page, 'word-over')
  })
})
