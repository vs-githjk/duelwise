import { visibleRegistry } from '../src/lib/strength-gates'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PRODUCT, type GameId } from '@duelwise/core/src/product.ts'

const REGISTRY_DIR = join(import.meta.dirname, '..', '..', '..', 'packages', 'agents', 'registry')
import { LEVELS } from '../src/lib/level-info'
const GAMES = Object.keys(PRODUCT.games) as GameId[]
const CAST = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'src', 'personas', 'personas.json'), 'utf8')).personas as Record<(typeof LEVELS)[number], { name: string; style: Record<string, string> }>

function registryOf(game: GameId): any | null {
  const p = join(REGISTRY_DIR, `${game}.json`)
  return existsSync(p) ? visibleRegistry(JSON.parse(readFileSync(p, 'utf8'))) : null
}

test.describe('personas', () => {
  test('the picker shows every level as its persona, with an avatar and the game-specific style line', async ({ page }) => {
    await page.goto('/play/chess')
    const picker = page.getByTestId('level-picker')
    for (const level of LEVELS) {
      await expect(picker.getByTestId(`persona-name-${level}`)).toHaveText(CAST[level].name)
      await expect(picker.locator('label').getByTestId(`persona-avatar-${level}`).locator('svg')).toBeVisible()
    }
    await expect(picker.locator('input[value=easy]')).toBeChecked()
    const reg = registryOf('chess')
    for (const level of LEVELS) {
      await picker.getByTestId(`persona-name-${level}`).click()
      const row = picker.locator('label').filter({ has: page.locator(`input[value="${level}"]`) })
      await expect(row.locator('input')).toBeChecked()
      await expect(row).toContainText(reg?.levels?.[level] && reg?.measured?.[level] ? CAST[level].style.chess! : 'In training')
    }
  })

  test('the match header and the result panel name the opponent', async ({ page }) => {
    await page.goto('/play/four-in-a-row')
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(page.getByTestId('header-persona')).toContainText(CAST.easy.name)
    await expect(page.getByTestId('header-persona').locator('svg')).toBeVisible()
    await page.getByRole('button', { name: 'Resign', exact: true }).click()
    await page.getByRole('button', { name: 'Yes, resign' }).click()
    await expect(page.getByTestId('result-persona')).toContainText(CAST.easy.name)
  })

  test('the cast page lists four personas and a table that equals the registries', async ({ page }) => {
    await page.goto('/ai')
    for (const level of LEVELS) {
      const card = page.getByTestId(`cast-card-${level}`)
      await expect(card).toContainText(CAST[level].name)
      await expect(card.locator('svg')).toBeVisible()
      for (const g of GAMES) {
        const reg = registryOf(g)
        await expect(card).toContainText(reg?.levels?.[level] && reg?.measured?.[level] ? CAST[level].style[g]! : 'In training: this opponent\'s strength is still being checked.')
      }
    }
    for (const game of GAMES) {
      const reg = registryOf(game)
      const cells = page.getByTestId(`cast-row-${game}`).locator('td')
      await expect(cells).toHaveCount(LEVELS.length)
      for (const [i, level] of LEVELS.entries()) {
        const measured = reg?.measured?.[level]
        if (measured && reg.levels?.[level]) {
          const realtime = game === 'fighter' || game === 'arena' || game === 'puck'
          if (realtime) await expect(cells.nth(i).getByTestId('cast-strength')).not.toContainText('site Elo')
          else await expect(cells.nth(i).getByTestId('cast-strength')).toHaveText(`site Elo ${Math.round(measured.siteElo)}`)
        } else {
          await expect(cells.nth(i)).toHaveAttribute('data-state', 'in-training')
          if (game === 'fighter' || game === 'arena') {
            await expect(cells.nth(i)).toContainText('In training')
            await expect(cells.nth(i)).not.toContainText('Practice')
          } else await expect(cells.nth(i)).toContainText('In training')
        }
      }
    }
  })

  test('realtime games show Practice for unpublished levels and never a site Elo, on /ai and the agent page', async ({ page }) => {
    const PRACTICE = 'In training: an early version that has not passed our strength test yet.'
    await page.goto('/ai')
    const tinder = page.getByTestId('cast-row-fighter')
    const cold = page.getByTestId('cast-row-arena')
    for (const [game, row] of [['fighter', tinder], ['arena', cold]] as const) {
      const reg = registryOf(game)
      for (const [i, level] of LEVELS.entries()) {
        const cell = row.locator('td').nth(i)
        if (!reg?.levels?.[level] || !reg?.measured?.[level]) await expect(cell).toContainText('In training')
        await expect(cell).not.toContainText('Practice')
      }
    }
    await expect(tinder).not.toContainText('still being measured')
    await expect(cold).not.toContainText('still being measured')
    await expect(tinder).not.toContainText('site Elo')
    await expect(cold).not.toContainText('site Elo')
    await page.goto('/agents/tinderbox')
    const detail = page.getByTestId('agent-detail')
    await expect(detail).toBeVisible()
    await expect(detail).not.toContainText(/site Elo/i)
    await expect(detail).not.toContainText('still being measured')
    if (!registryOf('fighter')?.levels?.easy) await expect(page.getByTestId('level-row-easy')).toContainText(PRACTICE)
    await expect(page.getByTestId('level-row-easy')).not.toContainText('In training')
    await expect(page.getByTestId('site-elo-hard')).toHaveCount(0)
    await expect(page.getByText('What is site Elo?')).toHaveCount(0)
  })

  test('the cast page fits a phone without sideways page scroll', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/ai')
    await expect(page.getByTestId('cast-page')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})
