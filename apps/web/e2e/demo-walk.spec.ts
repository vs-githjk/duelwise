import { visibleRegistry } from '../src/lib/strength-gates'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { PRODUCT, type GameId } from '@duelwise/core/src/product.ts'
import { LEVELS } from '../src/lib/level-info'

// T42b: fixes from the demo walk (plan/preview/demo-walk.md), one assertion group per item.

const REGISTRY_DIR = join(import.meta.dirname, '..', '..', '..', 'packages', 'agents', 'registry')
const GAMES = Object.keys(PRODUCT.games) as GameId[]

function registryOf(game: GameId): any | null {
  const p = join(REGISTRY_DIR, `${game}.json`)
  return existsSync(p) ? visibleRegistry(JSON.parse(readFileSync(p, 'utf8'))) : null
}
const championPublished = (game: GameId) => {
  const reg = registryOf(game)
  return Boolean(reg?.levels?.champion && reg?.measured?.champion)
}

async function devSignIn(page: Page, name: string) {
  await page.goto('/signin')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Dev sign in' }).click()
  await expect(page).toHaveURL(/\/play$/)
}

async function playFourToEnd(page: Page) {
  await page.goto('/play/four-in-a-row')
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId('four-board')).toBeVisible()
  for (let i = 0; i < 44; i++) {
    if (await page.getByTestId('result-panel').isVisible()) break
    await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', /you|over/)
    await expect(page.getByTestId('four-board')).not.toHaveAttribute('data-settling', 'true')
    if (await page.getByTestId('result-panel').isVisible()) break
    const col = await page.locator('[data-testid^="col-"]:not([aria-disabled="true"])').first().getAttribute('data-testid')
    await page.getByTestId(col!).click()
    await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', /you|over/)
    await expect(page.getByTestId('four-board')).not.toHaveAttribute('data-settling', 'true')
  }
  await expect(page.getByTestId('result-panel')).toBeVisible()
}

test.describe('demo walk fixes', () => {
  test('1. the level picker says it in plain words for each level', async ({ page }) => {
    const reg = registryOf('chess')
    await page.goto('/play/chess')
    const picker = page.getByTestId('level-picker')
    for (const level of LEVELS) {
      const row = picker.locator('label').filter({ has: page.locator(`input[value="${level}"]`) })
      await expect(row.locator('input')).toBeEnabled()
      if (!reg?.levels?.[level] || !reg?.measured?.[level]) await expect(row).toContainText('Practice')
    }
    const text = await picker.innerText()
    expect(text).not.toMatch(/in training/i)
    expect(text).not.toMatch(/\d\.\d{4}|interval|games,|\[\d/i)
  })

  test('2. the card promotion line is plain, and hidden for a game without a published Champion', async ({ page }) => {
    await page.goto('/play')
    await page.waitForLoadState('networkidle')
    for (const game of GAMES) {
      const line = page.getByTestId('game-card-' + game).getByTestId('card-promotion-' + game)
      if (championPublished(game)) {
        await expect(line).toHaveText(/^Champion v\d+ promoted [A-Z][a-z]{2} \d{1,2}( after beating the previous version)?\.$/)
      } else {
        await expect(line).toHaveCount(0)
      }
    }
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const above = await page.locator('section[aria-labelledby="six-games-h"]').innerText()
    expect(above).not.toMatch(/gate|adjacent levels|cap \d+|Wilson|interval/i)
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`3. Four in a Row stones are amber and ink and stand out from the holes (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.goto('/play/four-in-a-row')
      await page.getByRole('radio', { name: /Easy/ }).check()
      await page.getByRole('button', { name: 'Start match' }).click()
      await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', 'you')
      await page.getByTestId('col-3').click()
      await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', 'you')
      const fills = await page.evaluate(() => {
        const fill = (el: Element | null | undefined) => (el ? getComputedStyle(el).fill : null)
        const board = document.querySelector('[data-testid=four-board] svg')!
        return {
          you: fill(document.querySelector('[data-testid=disc][data-seat="0"] circle')),
          ai: fill(document.querySelector('[data-testid=disc][data-seat="1"] circle')),
          hole: fill(board.querySelector('rect')),
        }
      })
      expect(fills.you).toBe('rgb(243, 184, 28)')
      expect(fills.ai).toBe('rgb(26, 24, 20)')
      const lum = (rgb: string) => {
        const c = rgb.match(/\d+/g)!.slice(0, 3).map((v) => Number(v) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
      }
      const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
      expect(ratio(fills.you!, fills.hole!)).toBeGreaterThanOrEqual(3)
      expect(ratio(fills.ai!, fills.hole!)).toBeGreaterThanOrEqual(3)
    })
  }

  for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`4. stats chart labels are 11 to 14 px, inside the chart and never overlap at ${vp.width}`, async ({ page }) => {
      await playFourToEnd(page)
      await page.setViewportSize(vp)
      // The real page: one finished match is one week of data, so it shows the chart or its empty state, never nothing.
      await page.goto('/agents/four-in-a-row')
      await expect(page.getByTestId('winrate-chart').or(page.getByTestId('winrate-chart-empty')).first()).toBeVisible()
      // The label geometry is checked on the chart drawn with eight weeks of fixture data (src/dev-views/chart.tsx).
      await page.goto('/dev/chart')
      const chart = page.getByTestId('winrate-chart')
      await expect(chart).toBeVisible()
      await expect(chart.locator('text[data-axis="x"]').first()).toBeVisible()
      await page.waitForTimeout(300)
      const boxes = await chart.locator('svg text').evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect()
          return { l: r.left, r: r.right, t: r.top, b: r.bottom, size: parseFloat(getComputedStyle(e).fontSize) * ((e as SVGGraphicsElement).ownerSVGElement!.getScreenCTM()?.a ?? 1) }
        }),
      )
      const svg = await chart.locator('svg').boundingBox()
      expect(boxes.length).toBeGreaterThan(5)
      for (const b of boxes) {
        expect(b.size).toBeGreaterThanOrEqual(11)
        expect(b.size).toBeLessThanOrEqual(14)
        expect(b.l).toBeGreaterThanOrEqual(svg!.x - 0.5)
        expect(b.r).toBeLessThanOrEqual(svg!.x + svg!.width + 0.5)
      }
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!
          const c = boxes[j]!
          const overlap = a.l < c.r && c.l < a.r && a.t < c.b && c.t < a.b
          expect(overlap, `label ${i} overlaps label ${j}`).toBe(false)
        }
    })
  }

  test('5. public stats pages show no supervisor internals', async ({ page }) => {
    for (const game of ['chess', 'four-in-a-row', 'word-duel']) {
      await page.goto(`/agents/${game}`)
      await expect(page.getByTestId('agent-detail')).toBeVisible()
      const text = await page.locator('body').innerText()
      expect(text, game).not.toMatch(/maxHours|heartbeat|stop requested|restart|timeout|cpu slot|supervisor|uses the GPU/i)
      await expect(page.getByTestId('card-jobs')).toHaveCount(0)
    }
  })

  test('6. result reasons are full sentences with a subject', async ({ page }) => {
    await playFourToEnd(page)
    const reason = await page.getByTestId('result-reason').innerText()
    expect(reason).toMatch(/^(You|Pip) connected four in a row\.$|^The board filled up with no winner\.$/)
  })

  test('7. Word Duel card art shows no timer', async ({ page }) => {
    await page.goto('/play')
    const art = page.getByTestId('game-card-word').getByTestId('tile-art-word')
    await expect(art).toBeAttached()
    expect(await art.textContent()).not.toMatch(/\d:\d\d/)
  })

  test('8. the phone top nav includes Settings', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Sections' })
    await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })

  test('9. the first-visit consent card leaves the chess board above the fold at 1440 x 900', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/play/chess')
    const notice = page.getByTestId('training-notice')
    await expect(notice).toBeVisible()
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    const board = page.getByTestId('chess-board')
    await expect(board).toBeVisible({ timeout: 45_000 })
    await expect(notice).toBeVisible()
    const box = await board.boundingBox()
    expect(box!.y + box!.height).toBeLessThanOrEqual(900)
  })

  test('10. dashboard day labels name the month', async ({ page }) => {
    await devSignIn(page, 'Month Player')
    const labels = page.getByTestId('my-day-label')
    await expect(labels).toHaveCount(7)
    for (const t of await labels.allInnerTexts()) expect(t).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/)
  })
})
