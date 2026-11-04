import { gzipSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import { PRODUCT } from '@duelwise/core/src/product.ts'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record.ts'
import { ALL_LEVELS, learnsFromHumans, publishedLevels } from './published-levels'
import { readFileSync } from 'node:fs'
import { limitsSentence, limitsText, strengthLine } from '../src/games/arena/strength.ts'

// Path of the paid clip file (apps/web/src/games/arena/render/opponent.ts PAID_CLIPS_PATH); keyed on the path so any VITE_PAID_ASSETS_URL base works.
const PAID_CLIPS_PATH = 'arena/quaternius/universal-animation-library/ual1-shooter.glb'

// T36: the arena play page. Fixed-step 60 Hz loop, pointer lock and mouse aim, the buy menu, the agent in a
// worker, the match record. ?seed=N makes an unrated match; ?speed=N runs the sim N times faster (tests only,
// honoured only with a seed); ?renderer=debug forces the labelled top-down debug view.

const SLUG = PRODUCT.games.arena.slug
const UNITS_PER_COUNT_AT_1 = 0.022 * (8192 / 360)

const CORE_URL = `/@fs${import.meta.dirname.replace(/\/apps\/web\/e2e$/, '')}/packages/core/src/games/arena/core.ts`

/**
 * An independent replay of a record: the loop core/replay.ts runs (a recorded action holds until the next one), run
 * inside the page because the sim loads its map as JSON, which only the bundler resolves.
 */
function replayHash(page: Page, r: MatchRecordV1): Promise<{ hash: string; winner: number | null }> {
  return page.evaluate(
    async ([url, rec]) => {
      const core = (await import(/* @vite-ignore */ url as string)).arenaCore
      const record = rec as MatchRecordV1
      let s = core.init(record.seed)
      const held: [number | null, number | null] = [null, null]
      let i = 0
      for (let tick = 0; !core.terminal(s); tick++) {
        while (i < record.actions.length && record.actions[i]![0] === tick) {
          const [, seat, a] = record.actions[i]!
          held[seat] = a
          i++
        }
        s = core.step(s, [held[0] === null ? null : core.decodeAction(held[0]), held[1] === null ? null : core.decodeAction(held[1])])
      }
      return { hash: core.hash(s) as string, winner: core.result(s)!.winner as number | null }
    },
    [CORE_URL, r] as const,
  )
}

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.location().url.endsWith(PAID_CLIPS_PATH)) errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

async function startMatch(page: Page, query: string) {
  await page.goto(`/play/${SLUG}?${query}`)
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId('arena-stage')).toHaveAttribute('data-phase', 'playing', { timeout: 60_000 })
}

const handle = <T,>(page: Page, f: (a: NonNullable<Window['__arena']>) => T) => page.evaluate(`(${f.toString()})(window.__arena)`) as Promise<T>
const frame = (page: Page) => handle(page, (a) => a.frame)
const waitPhase = (page: Page, phase: number, round?: number) =>
  page.waitForFunction(([p, r]) => window.__arena && window.__arena.phase === p && (r === null || window.__arena.round === r), [phase, round ?? null] as const, { timeout: 120_000 })

/**
 * Playwright's Chromium refuses element.requestPointerLock() with WrongDocumentError (checked on a bare page too), so
 * the lock is stood in for: a request locks the element and fires pointerlockchange, exitPointerLock releases it, and
 * mouse movement is delivered as mousemove events with movementX and movementY, which is what the page reads from a real lock.
 */
async function fakePointerLock(page: Page) {
  await page.addInitScript(() => {
    let locked: Element | null = null
    Object.defineProperty(document, 'pointerLockElement', { get: () => locked, configurable: true })
    Element.prototype.requestPointerLock = function (this: Element) {
      locked = this
      document.dispatchEvent(new Event('pointerlockchange'))
      return Promise.resolve()
    } as never
    document.exitPointerLock = () => {
      if (!locked) return
      locked = null
      document.dispatchEvent(new Event('pointerlockchange'))
    }
  })
}

const moveMouse = (page: Page, dx: number, dy: number) =>
  page.evaluate(([x, y]) => document.dispatchEvent(new MouseEvent('mousemove', { movementX: x, movementY: y })), [dx, dy] as const)

async function capture(page: Page) {
  await page.getByTestId('arena-stage').click({ position: { x: 300, y: 300 } })
  await expect(page.getByTestId('arena-stage')).toHaveAttribute('data-locked', 'true')
}

test.describe('arena play page', () => {
  test('pointer lock and mouse aim at the set sensitivity; losing the lock pauses', async ({ page }) => {
    test.setTimeout(120_000)
    const errors = watchConsole(page)
    await fakePointerLock(page)
    await page.addInitScript(() => localStorage.setItem('duelwise.arena.settings', JSON.stringify({ sensitivity: 1 })))
    await startMatch(page, 'seed=21&renderer=debug')
    await expect(page.getByTestId('capture-hint')).toBeVisible()
    await capture(page)
    await expect(page.getByTestId('capture-hint')).toHaveCount(0)
    // Aim works in the buy phase. At sensitivity 1 a count turns 0.022 degrees; moving right turns the sim yaw down.
    const y0 = await handle(page, (a) => a.yaw)
    await moveMouse(page, 200, 0)
    await page.waitForTimeout(300)
    const y1 = await handle(page, (a) => a.yaw)
    const turned = (((y1 - y0 + 4096 + 8192) % 8192) - 4096) / UNITS_PER_COUNT_AT_1
    // 200 counts to the right turn the sim yaw down by 200 counts' worth of angle units (a little rounding is carried).
    expect(turned).toBeLessThan(-190)
    expect(turned).toBeGreaterThan(-210)
    // Losing the lock (Esc in a real browser) pauses the match.
    await page.evaluate(() => document.exitPointerLock())
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('WASD moves the player once the round is live', async ({ page }) => {
    test.setTimeout(120_000)
    const errors = watchConsole(page)
    await startMatch(page, 'seed=22&speed=10&renderer=debug')
    await waitPhase(page, 1)
    const a = await handle(page, (h) => [h.x, h.y])
    await page.keyboard.down('w')
    await page.waitForTimeout(500)
    await page.keyboard.up('w')
    const b = await handle(page, (h) => [h.x, h.y])
    expect(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!)).toBeGreaterThan(20)
    expect(errors).toEqual([])
  })

  test('sensitivity changes how far the same mouse movement turns the view', async ({ page }) => {
    test.setTimeout(120_000)
    await fakePointerLock(page)
    await page.goto(`/play/${SLUG}`)
    const turnFor = async (sens: number) => {
      await page.evaluate((s) => localStorage.setItem('duelwise.arena.settings', JSON.stringify({ sensitivity: s })), sens)
      await page.reload()
      await startMatch(page, `seed=${30 + sens}&renderer=debug`)
      await capture(page)
      const y0 = await handle(page, (a) => a.yaw)
      await moveMouse(page, 100, 0)
      await page.waitForTimeout(300)
      const y1 = await handle(page, (a) => a.yaw)
      return Math.abs((((y1 - y0 + 4096 + 8192) % 8192) - 4096))
    }
    const slow = await turnFor(1)
    const fast = await turnFor(3)
    expect(slow).toBeGreaterThan(0)
    expect(fast / slow).toBeGreaterThan(2)
    expect(fast / slow).toBeLessThan(4)
  })

  test('the buy menu shows in buy time with the real prices, and a purchase lands in a later round', async ({ page }) => {
    test.setTimeout(150_000)
    const errors = watchConsole(page)
    await startMatch(page, 'seed=23&speed=20&renderer=debug')
    // Round 1: $800 buys nothing, and the menu says so.
    await expect(page.getByTestId('buy-menu')).toBeVisible()
    await expect(page.getByTestId('buy-money')).toHaveText('$800')
    await expect(page.getByTestId('buy-ridgeline')).toBeDisabled()
    await expect(page.getByTestId('buy-armor')).toBeDisabled()
    await waitPhase(page, 1)
    await expect(page.getByTestId('buy-menu')).toHaveCount(0)
    // The loss bonus makes armour affordable in round 2, and key 3 buys it.
    await waitPhase(page, 0, 2)
    await expect(page.getByTestId('buy-armor')).toBeEnabled()
    await page.keyboard.press('3')
    await expect(page.getByTestId('armor')).toContainText('100')
    expect(errors).toEqual([])
  })

  test('a round end shows who won it, what each seat earned and the reaction line', async ({ page }) => {
    test.setTimeout(150_000)
    await startMatch(page, 'seed=23&speed=3&renderer=debug')
    await waitPhase(page, 2)
    const banner = page.getByTestId('round-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText(/Round (won|lost|drawn)/)
    await expect(banner).toContainText('+$')
    await expect(page.getByTestId('wins-you')).toBeVisible()
  })

  test('only what line of sight allows is drawn for the opponent', async ({ page }) => {
    test.setTimeout(120_000)
    await startMatch(page, 'seed=24&speed=6&renderer=debug')
    await waitPhase(page, 1)
    const seen = await page.evaluate(
      () =>
        new Promise<{ samples: number; drawnWhileHidden: number; hiddenWhileVisible: number; visible: number; hidden: number; minimapMismatch: number }>((resolve) => {
          const out = { samples: 0, drawnWhileHidden: 0, hiddenWhileVisible: 0, visible: 0, hidden: 0, minimapMismatch: 0 }
          const t0 = performance.now()
          const tick = () => {
            const a = window.__arena!
            out.samples++
            if (a.opponentVisible) out.visible++
            else out.hidden++
            if (a.opponentDrawn && !a.opponentVisible) out.drawnWhileHidden++
            if (!a.opponentDrawn && a.opponentVisible) out.hiddenWhileVisible++
            if ((document.querySelectorAll('[data-testid="minimap-opp"]').length > 0) !== a.opponentDrawn) out.minimapMismatch++
            if (performance.now() - t0 > 4000) resolve(out)
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }),
    )
    expect(seen.samples).toBeGreaterThan(100)
    expect(seen.hidden).toBeGreaterThan(0)
    expect(seen.drawnWhileHidden).toBe(0)
    // The HUD publishes every third frame, so the minimap may trail the canvas by a few frames, never lead it.
    expect(seen.minimapMismatch).toBeLessThan(seen.samples * 0.2)
  })

  test('a forced late worker does not stall the loop', async ({ page }) => {
    test.setTimeout(90_000)
    const errors = watchConsole(page)
    await startMatch(page, 'seed=25&agentlag=900&renderer=debug')
    const f0 = await frame(page)
    await page.waitForTimeout(5000)
    const f1 = await frame(page)
    expect(f1 - f0).toBeGreaterThanOrEqual(270)
    expect(errors).toEqual([])
    await page.waitForFunction(() => window.__arena!.lateReplies > 0, undefined, { timeout: 60_000 })
  })

  test('the match record replays to its final hash and gzips under 2 MB', async ({ page }) => {
    test.setTimeout(280_000)
    const errors = watchConsole(page)
    await startMatch(page, 'seed=26&speed=20&renderer=debug')
    await expect(page.getByTestId('result-panel')).toBeVisible({ timeout: 240_000 })
    await expect(page.getByTestId('arena-stage')).toHaveAttribute('data-record-ok', 'true')
    const record = await handle(page, (a) => a.record)
    expect(record).not.toBeNull()
    const out = await replayHash(page, record!)
    expect(out.hash).toBe(record!.finalHash)
    expect(out.winner).toBe(record!.result.winner)
    expect(record!.game).toBe('arena')
    expect(record!.actions.length).toBeGreaterThan(1)
    expect(gzipSync(JSON.stringify(record)).length).toBeLessThan(2 * 1024 * 1024)
    // "Try Champion" is offered after a win at a lower level, and only when the registry publishes Champion.
    await expect(page.getByRole('button', { name: 'Try Champion' })).toHaveCount(record!.result.winner === 0 && publishedLevels('arena').includes('champion') ? 1 : 0)
    expect(errors).toEqual([])
  })

  test('the pre-match screen lists every level with its real limits', async ({ page }) => {
    await page.goto(`/play/${SLUG}`)
    const picker = page.getByTestId('level-picker')
    await expect(picker).toBeVisible()
    await expect(picker.getByText(limitsText('easy'))).toBeVisible()
    await expect(picker.getByText('Waits 200 ms before reacting, like a sharp human, at most 240 actions a minute (not counting buttons it keeps held across a round restart), turns at most 540 degrees a second')).toBeVisible()
    await expect(picker.getByText('Waits 50 ms before reacting, faster than a person can react, no action cap, no aim limit')).toBeVisible()
    await expect(page.getByText(PRODUCT.games.arena.displayName, { exact: false }).first()).toBeVisible()
  })

  test('R32: a level the registry publishes shows no Practice label, every other level is playable as labelled Practice, with no site Elo', async ({ page }) => {
    await page.goto(`/play/${SLUG}`)
    const picker = page.getByTestId('level-picker')
    const published = publishedLevels('arena')
    for (const l of ALL_LEVELS) {
      const row = picker.locator(`label[data-persona="${l}"]`)
      if (published.includes(l)) await expect(row.getByTestId('preview-badge')).toHaveCount(0)
      else await expect(row.getByTestId('preview-badge')).toHaveText('In training')
      await expect(picker.locator(`input[value="${l}"]`)).toBeEnabled()
    }
    await expect(page.getByTestId('none-playable')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Start match' })).toBeEnabled()
    await expect(page.getByText(/site elo/i)).toHaveCount(0)
    // KC3: the picker note is the Practice copy ("have not passed our strength test", may play weaker than Easy), and only while a Practice level is listed.
    if (ALL_LEVELS.every((l) => published.includes(l))) await expect(page.getByTestId('practice-note')).toHaveCount(0)
    else {
      await expect(page.getByTestId('practice-note')).toContainText('Levels in training have not passed our strength test')
    }
  })

  test('KC2: the Champion card names its unlimited controls and Easy describes its slower limits', async ({ page }) => {
    await page.goto(`/play/${SLUG}?level=champion`)
    await expect(page.getByTestId('strength-line')).toContainText('It has no action cap and no aim limit')
    await expect(page.getByTestId('strength-line')).not.toContainText('cannot press')
    await expect(page.getByTestId('strength-line')).not.toContainText('cannot turn')
    await page.goto(`/play/${SLUG}?level=easy`)
    await expect(page.getByTestId('strength-line')).toContainText(limitsSentence('easy'))
  })

  test('a selected published persona shows its style line after the limits, a Practice one does not', async ({ page }) => {
    const cast = JSON.parse(readFileSync(new globalThis.URL('../src/personas/personas.json', import.meta.url), 'utf8')).personas as Record<string, { style: Record<string, string> }>
    const published = publishedLevels('arena')
    for (const level of ALL_LEVELS) {
      await page.goto(`/play/${SLUG}?level=${level}`)
      const line = page.getByTestId('strength-line')
      await expect(line).toContainText(limitsSentence(level))
      if (published.includes(level)) await expect(line).toContainText(cast[level]!.style.arena!)
      else await expect(line).not.toContainText(cast[level]!.style.arena!)
    }
  })

  test('KC3: the pre-match bullet comes from the registry (this game does not learn from human matches yet)', async ({ page }) => {
    await page.goto(`/play/${SLUG}`)
    if (learnsFromHumans('arena')) return
    await expect(page.getByText('Finished matches are stored for your report and are not used to train the agent.')).toBeVisible()
    await expect(page.locator('body')).not.toContainText('help train the next version')
  })

  test('picking a Practice level shows the practice line and a persona name', async ({ page }) => {
    const practice = ALL_LEVELS.find((l) => !publishedLevels('arena').includes(l))
    test.skip(practice === undefined, 'every Coldstore level is published')
    await page.goto(`/play/${SLUG}?level=${practice}`)
    const picker = page.getByTestId('level-picker')
    await expect(picker.locator(`input[value="${practice}"]`)).toBeChecked()
    await expect(picker.getByText('In training', { exact: true }).first()).toBeVisible()
    await expect(picker.locator(`label[data-persona="${practice}"]`).getByTestId('preview-badge')).toHaveText('In training')
    await expect(page.getByTestId('strength-line')).toContainText(strengthLine(null, practice!))
    await expect(page.getByTestId('agent-name')).not.toContainText('Duelwise')
    await expect(page.getByRole('button', { name: 'Start match' })).toBeEnabled()
  })

  test('the settings panel shows centimetres per 360 and previews the crosshair on three backgrounds', async ({ page }) => {
    await page.goto(`/play/${SLUG}`)
    await page.getByRole('button', { name: 'Sensitivity and crosshair' }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('cm360')).toContainText('cm of mouse travel at 800 DPI')
    await expect(dialog.getByLabel('Crosshair preview').locator('figure')).toHaveCount(3)
    const before = await page.getByTestId('cm360').textContent()
    await dialog.getByLabel('Sensitivity').fill('4')
    await expect(page.getByTestId('cm360')).not.toHaveText(before!)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('shows the HUD: score, timer, health, ammo, minimap and the opponent card with its limits', async ({ page }) => {
    test.setTimeout(90_000)
    await startMatch(page, 'seed=27&level=hard&renderer=debug')
    for (const id of ['score-box', 'round-timer', 'hp', 'armor', 'money', 'ammo', 'minimap', 'ai-pill']) await expect(page.getByTestId(id)).toBeVisible()
    await expect(page.getByTestId('ai-pill')).toContainText('200 ms')
    await expect(page.getByTestId('ai-pill')).toContainText('240')
    await page.keyboard.down('Tab')
    await expect(page.getByTestId('scoreboard')).toBeVisible()
    await expect(page.getByTestId('scoreboard')).toContainText('replays to the same final state')
    await page.keyboard.up('Tab')
    await expect(page.getByTestId('scoreboard')).toHaveCount(0)
  })

  test('pause freezes the sim and resumes it; Escape closes a panel instead of resuming', async ({ page }) => {
    test.setTimeout(90_000)
    await startMatch(page, 'seed=28&renderer=debug')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible()
    const a = await frame(page)
    await page.waitForTimeout(600)
    expect(await frame(page)).toBe(a)
    await page.getByRole('button', { name: 'Controls' }).click()
    await expect(page.getByRole('dialog', { name: 'Controls' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Controls' })).toHaveCount(0)
    await expect(page.getByTestId('arena-stage')).toHaveAttribute('data-paused', 'true')
    await page.getByRole('button', { name: 'Resume' }).click()
    await page.waitForTimeout(600)
    expect(await frame(page)).toBeGreaterThan(a)
  })

  test('falls back to a labelled debug view when the 3D scene is forced off', async ({ page }) => {
    test.setTimeout(90_000)
    const errors = watchConsole(page)
    await startMatch(page, 'seed=29&renderer=debug')
    await expect(page.getByTestId('renderer-label')).toHaveText('debug view')
    const f0 = await frame(page)
    await page.waitForTimeout(2000)
    expect((await frame(page)) - f0).toBeGreaterThanOrEqual(90)
    expect(errors).toEqual([])
  })

  test('leaving during loading does not leave a match running behind the player', async ({ page }) => {
    test.setTimeout(90_000)
    await page.route('**/agents/arena/**', async (route) => {
      await new Promise((r) => setTimeout(r, 4000))
      await route.continue()
    })
    await page.goto(`/play/${SLUG}?seed=18&renderer=debug`)
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(page.getByText('Loading Coldstore and the opponent')).toBeVisible()
    await page.waitForTimeout(800)
    await page.getByRole('link', { name: 'All games' }).click()
    await expect(page.getByTestId('arena-stage')).toHaveCount(0)
    await page.waitForTimeout(6000)
    const a = await page.evaluate(() => window.__arena?.frame)
    await page.waitForTimeout(1500)
    const b = await page.evaluate(() => window.__arena?.frame)
    expect(a === undefined || a === b).toBe(true)
  })
})

test.describe('arena play page with the 3D scene', () => {
  test('starts the first person scene with no console errors', async ({ page }) => {
    test.setTimeout(120_000)
    const errors = watchConsole(page)
    await startMatch(page, 'seed=41')
    await expect(page.getByTestId('renderer-label')).toBeHidden()
    await expect(page.getByTestId('arena-stage').locator('canvas')).toHaveCount(1)
    await page.waitForTimeout(2000)
    expect((await frame(page))).toBeGreaterThan(60)
    expect(errors).toEqual([])
  })
})

test.describe('arena play page on a touch phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('shows no desktop notice and offers the setup screen (touch controls are covered in touch.spec.ts)', async ({ page }) => {
    await page.goto(`/play/${SLUG}`)
    await expect(page.getByTestId('desktop-only')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Start match|Choose your fighter/ }).first()).toBeVisible()
    await expect(page.getByTestId('arena-stage')).toBeHidden()
  })
})

test.describe('arena laptop keys: arrows move, F fires', () => {
  const ammo = async (page: Page) => Number((await page.getByTestId('ammo').textContent())!.match(/\d+/)![0])
  const pose = (page: Page) => handle(page, (a) => ({ x: a.x, y: a.y }))
  const intoFight = async (page: Page, seed: number) => {
    await startMatch(page, `seed=${seed}&renderer=debug`)
    await expect(page.getByTestId('buy-menu')).toHaveCount(0, { timeout: 30_000 })
  }

  test('the arrow keys move the player like WASD, and F fires while held and stops on release', async ({ page }) => {
    test.setTimeout(120_000)
    await intoFight(page, 41)
    const p0 = await pose(page)
    await page.keyboard.down('ArrowUp')
    await page.waitForTimeout(700)
    await page.keyboard.up('ArrowUp')
    const p1 = await pose(page)
    expect(Math.hypot(p1.x - p0.x, p1.y - p0.y), 'moved with the arrow key').toBeGreaterThan(0.3)

    const a0 = await ammo(page)
    await page.keyboard.down('f')
    await page.waitForTimeout(900)
    await page.keyboard.up('f')
    const a1 = await ammo(page)
    expect(a1, 'held F fires').toBeLessThan(a0)
    await page.waitForTimeout(600)
    expect(await ammo(page), 'releasing F stops firing').toBe(a1)
  })

  test('F fires while moving with the arrows, with no mouse click', async ({ page }) => {
    test.setTimeout(120_000)
    await intoFight(page, 42)
    const a0 = await ammo(page)
    const p0 = await pose(page)
    await page.keyboard.down('ArrowRight')
    await page.keyboard.down('f')
    await page.waitForTimeout(700)
    await page.keyboard.up('f')
    await page.keyboard.up('ArrowRight')
    const p1 = await pose(page)
    expect(Math.hypot(p1.x - p0.x, p1.y - p0.y)).toBeGreaterThan(0.2)
    expect(await ammo(page)).toBeLessThan(a0)
  })

  test('Fire is rebindable in Controls and the old key stops firing', async ({ page }) => {
    test.setTimeout(120_000)
    await intoFight(page, 43)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Controls' }).click()
    const dialog = page.getByRole('dialog', { name: 'Controls' })
    await expect(dialog.getByText('A mouse or trackpad aims.')).toBeVisible()
    await dialog.getByRole('button', { name: /^Fire \(or left click\): F\. Change/ }).click()
    await page.keyboard.press('g')
    await expect(dialog.getByRole('button', { name: /^Fire \(or left click\): G\. Change/ })).toBeVisible()
    // Every action still has exactly one home: no label shows a key another action also shows.
    const labels = await dialog.getByRole('button', { name: /Change$/ }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!))
    const keyOf = (l: string) => l.split(': ')[1]!.replace('. Change', '').split(' or ')
    const seen = labels.flatMap(keyOf)
    expect(new Set(seen).size).toBe(seen.length)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Resume' }).click()
    const a0 = await ammo(page)
    await page.keyboard.down('f')
    await page.waitForTimeout(600)
    await page.keyboard.up('f')
    expect(await ammo(page), 'F no longer fires').toBe(a0)
    await page.keyboard.down('g')
    await page.waitForTimeout(700)
    await page.keyboard.up('g')
    expect(await ammo(page), 'G fires').toBeLessThan(a0)
  })

  test('the Controls copy and the How to play controls name the trackpad, F and the arrows', async ({ page }) => {
    await page.goto(`/play/${SLUG}?renderer=debug`)
    await expect(page.getByText('A mouse or trackpad aims; left click or F fires.')).toBeVisible()
    await page.getByRole('button', { name: 'How to play' }).first().click()
    const guide = page.getByRole('dialog', { name: /How to play/ })
    await expect(guide.getByText('W A S D or arrows')).toBeVisible()
    await expect(guide.getByText('Left click or F')).toBeVisible()
    await expect(guide.getByText('Mouse or trackpad', { exact: true })).toBeVisible()
  })
})

test.describe('leaving a live match from the pause menu', () => {
  test('All games asks first; Stay keeps the match, Leave match goes to /play', async ({ page }) => {
    test.setTimeout(90_000)
    await startMatch(page, 'seed=44&renderer=debug')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible()
    await page.getByTestId('pause-back').click()
    await expect(page.getByTestId('pause-leave-confirm')).toContainText('Leave this match?')
    await expect(page).toHaveURL(/\/play\/coldstore/)
    await page.getByRole('button', { name: 'Stay' }).click()
    await expect(page.getByTestId('pause-leave-confirm')).toHaveCount(0)
    await expect(page.getByTestId('arena-stage')).toHaveAttribute('data-paused', 'true')
    await page.getByTestId('pause-back').click()
    await page.getByTestId('pause-leave').click()
    await expect(page).toHaveURL(/\/play$/)
  })
})
