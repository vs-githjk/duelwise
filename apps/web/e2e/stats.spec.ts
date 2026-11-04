import { visibleRegistry } from '../src/lib/strength-gates'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { PRODUCT, type GameId } from '@duelwise/core/src/product.ts'

const REGISTRY_DIR = join(import.meta.dirname, '..', '..', '..', 'packages', 'agents', 'registry')
import { LEVELS } from '../src/lib/level-info'
const GAMES = Object.keys(PRODUCT.games) as GameId[]

function registryOf(game: GameId): any | null {
  const p = join(REGISTRY_DIR, `${game}.json`)
  return existsSync(p) ? visibleRegistry(JSON.parse(readFileSync(p, 'utf8'))) : null
}

/** The one rule: a game's matches are used for training when its registry says learnsFromHumans. */
function learnsOf(game: GameId): boolean {
  return registryOf(game)?.learnsFromHumans === true
}

function supervisorJobs(): Record<string, { state: string }> | null {
  try {
    const git = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const file = join(resolve(import.meta.dirname, git, '..'), 'runs', 'status.json')
    return JSON.parse(readFileSync(file, 'utf8')).jobs ?? null
  } catch {
    return null
  }
}

const num = async (page: Page, id: string) => Number((await page.getByTestId(id).innerText()).trim())

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
  await expect(page.getByTestId('four-record')).toHaveAttribute('data-record-ok', 'true')
  const text = (await page.getByTestId('result-panel').innerText()).toLowerCase()
  return text.includes('you won') ? 'win' : 'other'
}

test.describe('agent stats', () => {
  // These specs read the public numbers, which leave Test traffic out (server/public-traffic.ts), so they play as an ordinary visitor: no test marker header.
  test.use({ extraHTTPHeaders: { 'x-dw-test': '0' } })
  test('every game page shows registry numbers as measured and unmeasured levels as in training', async ({ page }) => {
    for (const game of GAMES) {
      const reg = registryOf(game)
      await page.goto(`/agents/${PRODUCT.games[game].slug}`)
      await expect(page.getByTestId('agent-detail')).toHaveAttribute('data-game', game)
      for (const level of LEVELS) {
        const published = Boolean(reg?.levels?.[level] && reg?.measured?.[level])
        if (published) {
          if (PRODUCT.games[game].kind === 'realtime') await expect(page.getByTestId(`site-elo-${level}`)).toHaveCount(0)
          else await expect(page.getByTestId(`site-elo-${level}`)).toHaveText(String(Math.round(reg.measured[level].siteElo)))
          await expect(page.getByTestId(`in-training-${level}`)).toHaveCount(0)
        } else {
          if (PRODUCT.games[game].kind === 'realtime') await expect(page.getByTestId(`in-training-${level}`)).toContainText('In training')
          else await expect(page.getByTestId(`in-training-${level}`)).toContainText('In training')
          await expect(page.getByTestId(`site-elo-${level}`)).toHaveCount(0)
        }
      }
      await expect(page.getByTestId('tile-version')).toContainText(reg?.champion ?? 'none')
      const champion = reg?.measured?.champion
      if (champion && !PRODUCT.games[game].kind.includes('realtime')) {
        await expect(page.getByTestId('tile-champion')).toContainText(String(Math.round(champion.siteElo)))
      } else if (PRODUCT.games[game].kind === 'realtime') {
        // The reaction limit is a product constant, so the tile shows it whether or not the Champion is published.
        await expect(page.getByTestId('tile-champion')).toContainText(`${PRODUCT.championMinDelayFrames} frames`)
        if (champion) await expect(page.getByTestId('tile-champion')).not.toContainText('In training')
        else await expect(page.getByTestId('tile-champion')).toContainText('In training')
      } else if (!champion) {
        await expect(page.getByTestId('tile-champion')).toContainText('In training')
      }
      await expect(page.getByTestId('learns-note')).toContainText(learnsOf(game) ? 'Filtered human matches may be used to train this agent' : game === 'fleet' || game === 'slack' ? 'Scripted solver: does not learn from site matches' : 'Does not learn from site matches yet')
      if (game === 'word') await expect(page.getByTestId('learns-note')).not.toContainText(/self-play/i)
    }
  })

  test('word duel head to head and version history equal word.json', async ({ page }) => {
    const reg = registryOf('word')
    const champion = reg.versions.find((v: any) => v.version === reg.champion)
    const duels = champion.gate.duels as { lower: string; upper: string; n: number; score: number; ci95: [number, number] }[]
    await page.goto('/agents/word-duel')
    await expect(page.getByTestId('pairs-empty')).toHaveCount(0)
    await expect(page.locator('[data-testid^="pair-rate-"]')).toHaveCount(duels.length)
    for (const d of duels) {
      await expect(page.getByTestId(`pair-rate-${d.upper}`)).toHaveText(`${(d.score * 100).toFixed(1)}%`)
      await expect(page.getByTestId(`pair-ci-${d.upper}`)).toHaveText(`${(d.ci95[0] * 100).toFixed(1)}% to ${(d.ci95[1] * 100).toFixed(1)}%`)
      await expect(page.getByTestId(`pair-${d.upper}-${d.lower}`)).toContainText(`${d.n} games`)
    }
    for (const v of reg.versions) {
      const expected = v.humanMatchesUsed > 0 ? `${v.humanMatchesUsed} human matches used.` : v.trainedSteps > 0 ? 'Self-play only.' : 'No human matches used.'
      await expect(page.getByTestId(`version-humans-${v.version}`)).toHaveText(expected)
      if (!(v.trainedSteps > 0)) await expect(page.getByTestId(`version-${v.version}`)).not.toContainText('Self-play')
    }
    await expect(page.getByTestId('level-row-easy')).toContainText(`${reg.measured.easy.n} words`)
  })

  test('the agent strip has one entry per game and matches the registries and adapters file', async ({ page }) => {
    await page.goto('/agents/word-duel')
    await expect(page.getByTestId('agent-strip').locator('li[data-testid^="strip-"]')).toHaveCount(GAMES.length)
    for (const game of GAMES) {
      const reg = registryOf(game)
      await expect(page.getByTestId(`strip-version-${game}`)).toContainText(reg?.champion ?? 'none')
      const published = LEVELS.filter((l) => reg?.levels?.[l] && reg?.measured?.[l]).length
      const text = await page.getByTestId(`strip-levels-${game}`).innerText()
      expect(text).toContain(published === 4 ? 'all four' : published === 0 ? 'In training' : `${published} of 4`)
      await expect(page.getByTestId(`strip-learns-${game}`)).toHaveText(learnsOf(game) ? 'Trains on site matches' : game === 'fleet' || game === 'slack' ? 'Scripted' : 'Not yet')
    }
  })

  test('a finished match moves the counts by exactly one, and the chart shows its result', async ({ page }) => {
    await page.goto('/agents/four-in-a-row')
    const before = {
      played: await num(page, 'funnel-played'),
      finished: await num(page, 'funnel-finished'),
      passed: await num(page, 'funnel-passed'),
      allowed: await num(page, 'funnel-allowed'),
    }
    const outcome = await playFourToEnd(page)
    await page.goto('/agents/four-in-a-row')
    expect(await num(page, 'funnel-played')).toBe(before.played + 1)
    expect(await num(page, 'funnel-finished')).toBe(before.finished + 1)
    expect(await num(page, 'funnel-passed')).toBe(before.passed + 1)
    expect(await num(page, 'funnel-allowed')).toBe(before.allowed + 1)
    expect(await num(page, 'funnel-used')).toBe(0)
    await expect(page.getByTestId('tile-matches')).toContainText(String(before.passed + 1))
    const chart = page.getByTestId('winrate-chart')
    if (await page.getByTestId('winrate-chart-empty').count()) {
      await expect(page.getByTestId('winrate-chart-empty')).toBeVisible()
      return
    }
    await expect(chart).toBeVisible()
    const easy = chart.locator('table tbody tr', { has: page.getByRole('rowheader', { name: 'Easy' }) })
    const last = easy.locator('td').last()
    if (outcome === 'win') await expect(last).not.toHaveText('no matches')
    else await expect(last).toHaveText(/^\d+%(, n=\d+)?$|^no matches$/)
  })

  test('training jobs are hidden from a guest', async ({ page }) => {
    await page.goto('/agents/chess')
    await expect(page.getByTestId('agent-detail')).toBeVisible()
    await expect(page.getByTestId('card-jobs')).toHaveCount(0)
    await expect(page.locator('[data-testid^="job-"]')).toHaveCount(0)
    await expect(page.getByTestId('jobs-unavailable')).toHaveCount(0)
  })

  test('works at 360 px: no horizontal scroll, chart and funnel readable', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/agents/four-in-a-row')
    await expect(page.getByTestId('agent-detail')).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    for (const id of ['tile-hard', 'card-winrate', 'card-funnel']) {
      const box = await page.getByTestId(id).boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(360)
    }
    const chart = page.getByTestId('winrate-chart')
    if (await chart.count()) {
      const svg = await chart.locator('svg').boundingBox()
      expect(svg!.width).toBeGreaterThan(280)
      // Axis labels are 16 user units in a 400 unit viewBox; this is their on-screen size.
      expect((svg!.width / 400) * 16).toBeGreaterThanOrEqual(11)
    } else {
      await expect(page.getByTestId('winrate-chart-empty')).toBeVisible()
    }
  })

  test('the tab for another game opens that game', async ({ page }) => {
    await page.goto('/agents/four-in-a-row')
    await page.getByTestId('tab-word').click()
    await expect(page).toHaveURL(/\/agents\/word-duel$/)
    await expect(page.getByTestId('agent-detail')).toHaveAttribute('data-game', 'word')
  })
})
