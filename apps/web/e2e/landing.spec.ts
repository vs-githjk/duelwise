import { visibleRegistry } from '../src/lib/strength-gates'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import { PRODUCT, type GameId } from '@duelwise/core/src/product.ts'
import { webPort } from '../port.ts'

const WEB = join(import.meta.dirname, '..')
const ROOT = join(WEB, '..', '..')
const REGISTRY_DIR = join(ROOT, 'packages', 'agents', 'registry')
const GAMES = Object.keys(PRODUCT.games) as GameId[]
const LEVELS = ['easy', 'medium', 'hard', 'champion'] as const

function registryOf(game: GameId): any | null {
  const p = join(REGISTRY_DIR, `${game}.json`)
  return existsSync(p) ? visibleRegistry(JSON.parse(readFileSync(p, 'utf8'))) : null
}

const measuredCount = (game: GameId) => {
  const reg = registryOf(game)
  return reg ? LEVELS.filter((l) => reg.levels?.[l] && reg.measured?.[l]).length : 0
}

const PERSONAS = JSON.parse(readFileSync(join(WEB, 'src', 'personas', 'personas.json'), 'utf8')).personas as Record<string, { name: string }>

/** The persona the card leads with: the first level that is published and measured, else Easy. */
const firstName = (game: GameId) => {
  const reg = registryOf(game)
  const level = LEVELS.find((l) => reg?.levels?.[l] && reg.measured?.[l]) ?? 'easy'
  return PERSONAS[level].name
}

const playable = (game: GameId) => existsSync(join(WEB, 'src', 'games', game, 'index.tsx'))

async function devSignIn(page: Page, name: string) {
  await page.goto('/signin')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Dev sign in' }).click()
  await expect(page).toHaveURL(/\/play$/)
  await expect(page.getByTestId('user-menu')).toContainText(name)
}

test.describe('landing', () => {
  test('the hero is the fight card: the challenge, four opponents with real records, one Step in to the game picker', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Can you beat my agents?')
    await expect(page).toHaveTitle(new RegExp(PRODUCT.tagline.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    for (const level of LEVELS) {
      const card = page.getByTestId(`fighter-${level}`)
      await expect(card).toBeVisible()
      await expect(card).toContainText(PERSONAS[level].name)
      // A record shows only once people have played that opponent; an empty store says so instead of showing zeros.
      await expect(page.getByTestId(`fighter-record-${level}`)).toHaveText(/^(No matches yet|[\d,]+ W [\d,]+ L)$/)
    }
    // "Step in" opens the pick-your-game grid, never one game.
    const stepIn = page.getByTestId('step-in')
    await expect(stepIn).toHaveText('Step in')
    await expect(stepIn).toHaveAttribute('href', '/play')
    await expect(page.getByTestId('hero-start')).toHaveCount(0)
    await stepIn.click()
    await expect(page).toHaveURL(/\/play$/)
    await expect(page.getByRole('heading', { name: 'Pick a game' })).toBeVisible()
    for (const game of GAMES) await expect(page.getByTestId(`game-card-${game}`)).toBeVisible()
  })

  test('the landing describes the six games but nothing on it links into a game', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    for (const game of GAMES) {
      const info = page.getByTestId(`game-info-${game}`)
      await expect(info).toBeVisible()
      await expect(info.getByRole('heading', { name: PRODUCT.games[game].displayName })).toBeVisible()
      await expect(info.getByTestId(`tile-art-${game}`)).toBeVisible()
      await expect(info.getByTestId(`info-note-${game}`)).not.toBeEmpty()
      await expect(info.locator('a, button')).toHaveCount(0)
      await expect(page.getByTestId(`game-card-${game}`)).toHaveCount(0)
    }
    // No anchor anywhere on the landing goes to a game page, a shared-card link or the stand-alone training link.
    const hrefs = await page.locator('a[href]').evaluateAll((els) => els.map((a) => a.getAttribute('href') ?? ''))
    expect(hrefs.filter((h) => /^\/play\/.+/.test(h) || h.startsWith('/c/')), 'links into a game').toEqual([])
    // The four opponents, the path, the leaderboard and the learning each have their place.
    await expect(page.getByTestId('landing-path')).toBeVisible()
    for (const level of LEVELS) await expect(page.getByTestId(`path-info-${level}`)).toBeVisible()
    await expect(page.getByTestId('landing-board')).toBeVisible()
    await expect(page.getByTestId('how-it-learns')).toBeVisible()
    await expect(page.getByTestId('game-info-fighter')).not.toContainText('Phone and desktop')
    await expect(page.getByTestId('game-info-arena')).not.toContainText('Phone and desktop')
    await expect(page.getByText('Desktop', { exact: true })).toHaveCount(0)
    // Step in is the one door.
    await expect(page.getByTestId('step-in')).toHaveAttribute('href', '/play')
  })

  test('the landing strip says what it can back: counts from the store or Opening week, and the honest learning line', async ({ page }) => {
    await page.goto('/')
    const strip = page.getByTestId('landing-strip')
    await expect(strip).toBeVisible()
    await expect(strip.getByTestId('strip-count').first()).toHaveText(/^(Opening week|[\d,]+)$/)
    await expect(page.getByTestId('strip-learning')).toContainText('self-play')
  })

  for (const route of ['/play']) {
    test(`${route} shows six cards with status and numbers from config and registry`, async ({ page }) => {
      await page.goto(route)
      await page.waitForLoadState('networkidle')
      for (const game of GAMES) {
        const card = page.getByTestId(`game-card-${game}`)
        await expect(card).toBeVisible()
        await expect(card.getByRole('heading', { name: PRODUCT.games[game].displayName })).toBeVisible()
        const reg = registryOf(game)
        // JB2: the opponent is the cast, not a version string.
        await expect(card).not.toContainText('Opponent')
        await expect(card.getByTestId(`card-version-${game}`)).toHaveCount(0)
        await expect(card.getByTestId(`card-cast-${game}`)).toContainText(`Start with ${firstName(game)}`)
        await expect(card.getByTestId(`card-cast-${game}`).locator('[data-testid^="persona-avatar-"]')).toHaveCount(4)
        await expect(card.getByTestId(`card-levels-${game}`)).toHaveText(`${measuredCount(game)} of 4 levels measured`)
        await expect(card.getByTestId('preview-badge')).toHaveCount(measuredCount(game) === 0 ? 1 : 0)
        if (playable(game)) {
          await expect(card.getByRole('link', { name: `Play ${firstName(game)}` })).toHaveAttribute('href', `/play/${PRODUCT.games[game].slug}`)
        } else {
          await expect(card.getByRole('link', { name: 'Play' })).toHaveCount(0)
          await expect(card).toContainText('In development')
        }
        await expect(card.getByRole('link', { name: 'The AI' })).toHaveAttribute('href', `/agents/${PRODUCT.games[game].slug}`)
        await expect(card).not.toContainText('Phone and desktop')
      }
    })
  }

  test('how the AI learns names the honest steps and no invented number', async ({ page }) => {
    await page.goto('/')
    const section = page.getByTestId('how-it-learns')
    await expect(section.getByRole('heading', { level: 2 })).toHaveText('How the AI learns')
    await expect(section.locator('li')).toHaveCount(3)
    await expect(section).not.toContainText(/\d\s*(%|Elo)/)
  })

  test('no banned terms, dashes or the rejected name on either page', async ({ page }) => {
    const banned = JSON.parse(readFileSync(join(ROOT, 'scripts', 'banned-terms.json'), 'utf8'))
    for (const route of ['/', '/play']) {
      await page.goto(route)
      await page.waitForLoadState('networkidle')
      const text = await page.locator('body').innerText()
      const html = await page.content()
      for (const term of banned.terms as string[]) {
        const cs = (banned.caseSensitive as string[]).includes(term)
        const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, cs ? '' : 'i')
        expect(re.test(text), `${term} on ${route}`).toBe(false)
        expect(re.test(html), `${term} in markup of ${route}`).toBe(false)
      }
      for (const name of banned.rejectedNames as string[]) expect(text.includes(name)).toBe(false)
      expect(/[–—]/.test(text)).toBe(false)
    }
  })

  test('no horizontal scroll at phone width and the cards stay readable', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    for (const route of ['/', '/play']) {
      await page.goto(route)
      await page.waitForLoadState('networkidle')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, route).toBeLessThanOrEqual(0)
    }
  })

  test('a signed-in player sees their record on the dashboard, a guest does not', async ({ page }) => {
    await page.goto('/play')
    await expect(page.getByTestId('my-record')).toHaveCount(0)
    await devSignIn(page, 'Dash Player')
    await expect(page.getByTestId('my-record')).toBeVisible()
    await expect(page.getByTestId('my-record')).toContainText('No matches yet')
  })
})

test.describe('welcome: the name is asked once, at the first Step in', () => {
  test.use({
    storageState: {
      cookies: [],
      origins: [{ origin: `http://localhost:${webPort()}`, localStorage: GAMES.map((g) => ({ name: `duelwise.how-to-play.${g}`, value: 'seen' })) }],
    },
  })

  test('first Step in shows the welcome, skipping goes to the picker, the second Step in goes straight to the picker', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('step-in').click()
    await expect(page).toHaveURL(/\/play$/)
    await expect(page.getByTestId('welcome')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'What should we call you?' })).toBeVisible()
    await expect(page.getByTestId('name-field')).toBeVisible()
    await expect(page.getByTestId('game-card-chess')).toHaveCount(0)
    await page.getByTestId('welcome-skip').click()
    await expect(page.getByRole('heading', { name: 'Pick a game' })).toBeVisible()
    await expect(page.getByTestId('welcome')).toHaveCount(0)
    // A skip is remembered: the next Step in, even after a reload, goes straight to the picker.
    await page.goto('/')
    await page.getByTestId('step-in').click()
    await expect(page.getByRole('heading', { name: 'Pick a game' })).toBeVisible()
    await expect(page.getByTestId('welcome')).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Pick a game' })).toBeVisible()
    await expect(page.getByTestId('welcome')).toHaveCount(0)
    // No name was given, so the header shows none.
    await expect(page.getByTestId('header-name')).toHaveCount(0)
  })

  test('a name given in the welcome is checked, saved, shown in the header and found in Settings', async ({ page }) => {
    await page.goto('/play')
    await expect(page.getByTestId('welcome')).toBeVisible()
    // Filling before the page has hydrated can drop the submit, so retry until the check answers.
    await expect(async () => {
      await page.getByTestId('name-field').fill('me@example.com')
      await page.getByTestId('welcome-continue').click()
      await expect(page.getByTestId('name-help')).toHaveText('Just a name, no links or emails.', { timeout: 3_000 })
    }).toPass({ timeout: 30_000 })
    await expect(page.getByTestId('welcome')).toBeVisible()
    await page.getByTestId('name-field').fill('  Mika   R. ')
    await page.getByTestId('welcome-continue').click()
    await expect(page.getByRole('heading', { name: 'Pick a game' })).toBeVisible()
    const header = page.getByTestId('header-name')
    await expect(header).toHaveText('Mika R.')
    await expect(header).toHaveAttribute('href', '/settings')
    // Remembered: a reload goes straight to the picker with the name still in the header.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Pick a game' })).toBeVisible()
    await expect(page.getByTestId('header-name')).toHaveText('Mika R.')
    await page.getByTestId('header-name').click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByTestId('name-settings').getByTestId('name-field')).toHaveValue('Mika R.')
  })

  test('a game page has no name field, only the per-game call', async ({ page }) => {
    await page.goto('/play/chess')
    await expect(page.getByTestId('call-picker')).toBeVisible()
    await expect(page.getByTestId('name-field')).toHaveCount(0)
    await expect(page.getByLabel('Your name')).toHaveCount(0)
  })
})

test.describe('landing bundle', () => {
  test.setTimeout(180_000)
  test('landing JS is at most 200 KB gzip in the production build', async ({ browser }) => {
    execFileSync('bun', ['run', 'build'], { cwd: WEB, stdio: 'ignore' })
    const port = 3290 + Math.floor(Math.random() * 9)
    const server = spawn('node', [join(WEB, '.output', 'server', 'index.mjs')], {
      cwd: WEB,
      env: { ...process.env, PORT: String(port), DUELWISE_DB: 'memory' },
      stdio: 'ignore',
    })
    try {
      const base = `http://localhost:${port}`
      for (let i = 0; i < 60; i++) {
        try {
          if ((await fetch(base)).ok) break
        } catch {
          await new Promise((r) => setTimeout(r, 500))
        }
      }
      const page = await browser.newPage()
      const files = new Set<string>()
      page.on('response', (r) => {
        const u = new URL(r.url())
        if (u.origin === base && u.pathname.endsWith('.js')) files.add(u.pathname)
      })
      await page.goto(base)
      await page.waitForLoadState('networkidle')
      await page.close()
      expect(files.size).toBeGreaterThan(0)
      const assets = join(WEB, '.output', 'public')
      let total = 0
      for (const f of files) {
        const p = join(assets, f)
        if (existsSync(p)) total += gzipSync(readFileSync(p)).length
      }
      expect(readdirSync(assets).length).toBeGreaterThan(0)
      console.log(`landing JS gzip bytes: ${total} in ${files.size} files`)
      expect(total).toBeLessThanOrEqual(200 * 1024)
    } finally {
      server.kill()
      // The dev server of a combined run watches this folder; leaving a production build behind upsets its glob imports.
      rmSync(join(WEB, '.output'), { recursive: true, force: true })
    }
  })
})
