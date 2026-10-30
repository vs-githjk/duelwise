import { expect, test, type Page } from '@playwright/test'
import { PRODUCT } from '@duelwise/core/src/product.ts'

// JB2: fonts, leaderboard reach, dark-mode contrast, screen-reader announcements, folds, small fixes.

const CHESS = '/play/chess'
const FOUR = '/play/four-in-a-row'
const slugs = Object.values(PRODUCT.games).map((g) => g.slug)

/** Contrast ratio of two CSS colours, read through the browser so every colour syntax works. */
async function contrast(page: Page, a: string, b: string): Promise<number> {
  return page.evaluate(
    ([fg, bg]) => {
      const c = document.createElement('canvas').getContext('2d')!
      const rgb = (css: string) => {
        c.clearRect(0, 0, 1, 1)
        c.fillStyle = '#000'
        c.fillStyle = css
        c.fillRect(0, 0, 1, 1)
        const [r, g, bl] = c.getImageData(0, 0, 1, 1).data
        return [r!, g!, bl!]
      }
      const lum = ([r, g, b2]: number[]) => {
        const f = (v: number) => {
          const s = v / 255
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        }
        return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b2!)
      }
      const l1 = lum(rgb(fg!))
      const l2 = lum(rgb(bg!))
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    },
    [a, b],
  )
}

async function startGame(page: Page, url: string, level = /Easy/) {
  await page.goto(url)
  await page.getByRole('radio', { name: level }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
}

test.describe('fonts and numerals', () => {
  test('Fraunces, Geist and Geist Mono load from this origin, with lining numerals', async ({ page, baseURL }) => {
    const fontUrls: string[] = []
    page.on('response', (r) => {
      if (/\.(woff2?|ttf|otf)(\?|$)/.test(r.url())) fontUrls.push(r.url())
    })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const faces = await page.evaluate(async () => {
      await Promise.all(['700 20px "Fraunces"', '400 15px "Geist"', '400 13px "Geist Mono"'].map((f) => document.fonts.load(f)))
      return [...document.fonts].map((f) => ({ family: f.family.replace(/"/g, ''), status: f.status }))
    })
    for (const family of ['Fraunces', 'Geist', 'Geist Mono']) {
      expect(faces.filter((f) => f.family === family && f.status === 'loaded').length, `${family} loaded`).toBeGreaterThan(0)
    }
    expect(fontUrls.length).toBeGreaterThan(0)
    for (const u of fontUrls) expect(u.startsWith(baseURL!)).toBe(true)
    const css = await page.evaluate(() => ({
      h1: getComputedStyle(document.querySelector('h1')!).fontFamily,
      body: getComputedStyle(document.body).fontFamily,
      nums: getComputedStyle(document.body).fontVariantNumeric,
    }))
    expect(css.h1).toMatch(/^"?Fraunces/)
    expect(css.body).toMatch(/^"?Geist/)
    expect(css.nums).toContain('lining-nums')
  })
})

test.describe('leaderboard is reachable', () => {
  test('from the nav, a game page, and the game switcher on the board', async ({ page }) => {
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Leaderboard' })
    await expect(nav).toHaveAttribute('href', /^\/leaderboard\/[a-z-]+$/)
    await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'The AI' })).toBeVisible()
    await page.goto(FOUR)
    await page.getByTestId('game-leaderboard-link').click()
    await expect(page).toHaveURL(/\/leaderboard\/four-in-a-row$/)
    const switcher = page.getByRole('navigation', { name: 'Choose a game' })
    for (const slug of slugs) await expect(switcher.locator(`a[href="/leaderboard/${slug}"]`)).toBeVisible()
    await expect(switcher.locator('a[aria-current="page"]')).toHaveAttribute('href', '/leaderboard/four-in-a-row')
    await switcher.locator('a[href="/leaderboard/word-duel"]').click()
    await expect(page).toHaveURL(/\/leaderboard\/word-duel$/)
    await expect(page.getByTestId('leaderboard')).toBeVisible()
  })

  test('the result panel links to the leaderboard and the share box is styled', async ({ page }) => {
    await page.goto('/signin')
    await page.waitForLoadState('networkidle')
    await page.getByLabel('Name').fill('polish-player')
    await page.getByRole('button', { name: 'Dev sign in' }).click()
    await expect(page.getByTestId('user-menu')).toContainText('polish-player')
    await startGame(page, FOUR)
    await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', 'you')
    for (let i = 0; i < 44; i++) {
      if (await page.getByTestId('result-panel').isVisible()) break
      const col = await page.locator('[data-testid^="col-"]:not([aria-disabled="true"])').first().getAttribute('data-testid')
      await page.getByTestId(col!).click({ trial: false })
      await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', /you|over/)
      await expect(page.getByTestId('four-board')).not.toHaveAttribute('data-settling', 'true')
    }
    await expect(page.getByTestId('result-panel')).toBeVisible()
    await expect(page.getByTestId('result-leaderboard-link')).toHaveAttribute('href', '/leaderboard/four-in-a-row')
    // win ring uses the `good` colour
    const ring = await page.evaluate(() => {
      const el = document.querySelector('.win-ring')
      if (!el) return null
      const probe = document.createElement('i')
      probe.style.color = 'var(--good)'
      document.body.appendChild(probe)
      const good = getComputedStyle(probe).color
      probe.remove()
      return { stroke: getComputedStyle(el).stroke, good }
    })
    if (ring) expect(ring.stroke).toBe(ring.good)
    await page.getByTestId('result-report-link').click()
    await expect(page.getByTestId('share-public')).toBeVisible()
    expect(await page.getByTestId('share-public').evaluate((el) => getComputedStyle(el).accentColor)).not.toBe('auto')
  })
})

test.describe('dark mode contrast', () => {
  for (const scheme of ['dark', 'light'] as const) {
    test(`chess swatches and board coordinates pass 3:1 in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await startGame(page, CHESS)
      await expect(page.getByTestId('chess-board')).toHaveAttribute('data-turn', 'you')
      const items = await page.evaluate(() => {
        const out: Array<{ kind: string; fg: string; bg: string }> = []
        const surface = (el: Element) => {
          for (let n: Element | null = el.parentElement; n; n = n.parentElement) {
            const bg = getComputedStyle(n).backgroundColor
            if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg
          }
          return getComputedStyle(document.body).backgroundColor
        }
        for (const el of document.querySelectorAll('[data-swatch]')) {
          const cs = getComputedStyle(el)
          const edge = cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none' ? cs.borderTopColor : cs.backgroundColor
          out.push({ kind: `swatch ${el.getAttribute('data-swatch')}`, fg: edge, bg: surface(el) })
          if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') out.push({ kind: `swatch-fill ${el.getAttribute('data-swatch')}`, fg: cs.backgroundColor, bg: surface(el) })
        }
        for (const el of document.querySelectorAll('[data-coord]')) {
          out.push({ kind: `coord ${el.textContent}`, fg: getComputedStyle(el).color, bg: getComputedStyle(el.parentElement!).backgroundColor })
        }
        return out
      })
      expect(items.filter((i) => i.kind.startsWith('swatch ')).length).toBeGreaterThanOrEqual(2)
      expect(items.filter((i) => i.kind.startsWith('coord')).length).toBe(16)
      for (const it of items) {
        if (it.kind.startsWith('swatch-fill')) continue
        // a swatch passes when its edge reaches 3:1 against its surface; the fill alone may be too close to it
        const edge = await contrast(page, it.fg, it.bg)
        expect(edge, `${scheme} ${it.kind}: ${it.fg} on ${it.bg}`).toBeGreaterThanOrEqual(3)
      }
    })
  }

  test('four swatches pass 3:1 in dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await startGame(page, FOUR)
    await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', 'you')
    const swatches = await page.evaluate(() =>
      [...document.querySelectorAll('[data-swatch]')].map((el) => {
        const cs = getComputedStyle(el)
        let bg = 'rgb(0,0,0)'
        for (let n: Element | null = el.parentElement; n; n = n.parentElement) {
          const b = getComputedStyle(n).backgroundColor
          if (b !== 'rgba(0, 0, 0, 0)') {
            bg = b
            break
          }
        }
        const hasBorder = cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none'
        return { name: el.getAttribute('data-swatch')!, edge: hasBorder ? cs.borderTopColor : cs.backgroundColor, bg }
      }),
    )
    expect(swatches.length).toBeGreaterThanOrEqual(2)
    for (const s of swatches) expect(await contrast(page, s.edge, s.bg), `${s.name} ${s.edge} on ${s.bg}`).toBeGreaterThanOrEqual(3)
  })
})

test.describe('screen readers', () => {
  test('chess announces the AI move and the board state', async ({ page }) => {
    await startGame(page, CHESS)
    const board = page.getByTestId('chess-board')
    await expect(board).toHaveAttribute('data-turn', 'you')
    await page.getByTestId('sq-e2').click()
    await page.getByTestId('sq-e4').click()
    await expect(board).toHaveAttribute('data-plies', '2', { timeout: 20_000 })
    await expect(board).toHaveAttribute('data-turn', 'you')
    const live = page.getByTestId('chess-announce')
    await expect(live).toHaveAttribute('aria-live', 'polite')
    await expect(live).toHaveText(/^Pip played \S+\. Your move\./)
    const summary = page.getByTestId('chess-board-summary')
    await expect(summary).toContainText('White: ')
    await expect(summary).toContainText('Black: ')
    await expect(summary).toContainText('pawn e4')
  })

  test('four announces the AI drop and each column states its stones', async ({ page }) => {
    await startGame(page, FOUR)
    await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', 'you')
    await page.getByTestId('col-3').click()
    await expect(page.getByTestId('four-board')).toHaveAttribute('data-moves', '2', { timeout: 20_000 })
    await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', 'you')
    await expect(page.getByTestId('four-announce')).toHaveText(/^Pip dropped a stone in column [1-7]\. Your move\./)
    await expect(page.getByTestId('col-3')).toHaveAttribute('aria-label', /Column 4, .*2 stones|Column 4, .*1 stone/)
    await expect(page.getByTestId('four-board-summary')).toContainText('Column 4')
  })
})

test.describe('folds and phone layout', () => {
  test('chess at 1440x900: the board is above the fold with the training notice shown', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await startGame(page, CHESS)
    await expect(page.getByTestId('chess-board')).toBeVisible()
    const notice = page.getByTestId('training-notice')
    await expect(notice).toBeVisible()
    expect((await notice.boundingBox())!.height).toBeLessThan(56)
    const box = (await page.getByTestId('board-frame').boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(900)
  })

  test('four at 1440x900: the board is above the fold', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await startGame(page, FOUR)
    await expect(page.getByTestId('four-board')).toBeVisible()
    const box = (await page.getByTestId('four-board').boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(900)
  })

  test('setup at 1440x900: Start match and the level picker are above the fold', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    for (const url of [CHESS, FOUR]) {
      await page.goto(url)
      const b = (await page.getByRole('button', { name: 'Start match' }).boundingBox())!
      expect(b.y + b.height, url).toBeLessThanOrEqual(900)
    }
  })

  test('chess at 390x844: the board is about 358 wide and Start match stays reachable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(CHESS)
    await page.getByRole('radio', { name: /Easy/ }).check()
    const start = page.getByRole('button', { name: 'Start match' })
    const b = (await start.boundingBox())!
    expect(b.y + b.height).toBeLessThanOrEqual(844)
    await start.click()
    await expect(page.getByTestId('chess-board')).toBeVisible()
    const board = (await page.getByTestId('chess-board').boundingBox())!
    expect(board.width).toBeGreaterThanOrEqual(352)
    expect(board.width).toBeLessThanOrEqual(366)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })

  test('the training notice is one line once a match has started', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(CHESS)
    const setupHeight = (await page.getByTestId('training-notice').boundingBox())!.height
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(page.getByTestId('chess-board')).toBeVisible()
    const h = (await page.getByTestId('training-notice').boundingBox())!.height
    expect(h).toBeLessThan(setupHeight)
    expect(h).toBeLessThan(96)
  })
})

test.describe('four input lock', () => {
  test('the board is locked from the moment the AI stone appears until it lands', async ({ page }) => {
    await startGame(page, FOUR)
    const board = page.getByTestId('four-board')
    await expect(board).toHaveAttribute('data-turn', 'you')
    const snap = page.evaluate(
      () =>
        new Promise<{ settling: string | null; disabled: string[] }>((resolve) => {
          const root = document.querySelector('[data-testid="four-board"]')!
          const mo = new MutationObserver(() => {
            if (root.querySelector('[data-testid="disc"][data-seat="1"]')) {
              mo.disconnect()
              resolve({ settling: root.getAttribute('data-settling'), disabled: [...root.querySelectorAll('[data-testid^="col-"]')].map((b) => b.getAttribute('aria-disabled') ?? '') })
            }
          })
          mo.observe(root, { childList: true, subtree: true })
        }),
    )
    await page.getByTestId('col-3').click()
    const s = await snap
    expect(s.settling).toBe('true')
    expect(s.disabled.every((d) => d === 'true')).toBe(true)
    await expect(board).toHaveAttribute('data-settling', 'false')
    await expect(page.getByTestId('col-0')).toHaveAttribute('aria-disabled', 'false')
  })
})

test.describe('small fixes', () => {
  test('every route has its own tab title that carries the product name', async ({ page }) => {
    const routes = ['/', '/play', CHESS, FOUR, '/agents/chess', '/leaderboard/chess', '/privacy', '/terms', '/settings', '/signin', '/ai']
    const titles: string[] = []
    for (const r of routes) {
      await page.goto(r)
      await expect.poll(() => page.title()).toContain(PRODUCT.name)
      titles.push(await page.title())
    }
    expect(new Set(titles).size, titles.join(' / ')).toBe(titles.length)
    for (const t of titles.slice(1)) expect(t).toMatch(new RegExp(`^.+ \\| ${PRODUCT.name}$`))
  })

  test('the privacy page does not point at a switch that is not on it', async ({ page }) => {
    await page.goto('/privacy')
    await expect(page.getByTestId('privacy')).toBeVisible()
    const hasSwitch = (await page.locator('[role="switch"]').count()) > 0
    const text = await page.getByTestId('privacy').innerText()
    if (!hasSwitch) expect(text).not.toMatch(/switch below/i)
  })

  test('the 404 page links back to the games and the footer sits at the bottom of a short page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/no/such/page')
    await expect(page.getByTestId('not-found').getByRole('link', { name: /games/i })).toHaveAttribute('href', '/play')
    const foot = (await page.locator('footer').boundingBox())!
    expect(Math.round(foot.y + foot.height)).toBeGreaterThanOrEqual(899)
  })

  test('a level table that overflows at 390 shows a scroll cue', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    for (const slug of slugs) {
      await page.goto(`/agents/${slug}`)
      await page.waitForLoadState('networkidle')
      const wrap = page.getByTestId('level-table')
      if (!(await wrap.count())) continue
      const over = await wrap.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
      if (over) await expect(page.getByTestId('scroll-cue')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    }
  })
})
