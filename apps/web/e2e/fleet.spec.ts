import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishedLevels } from './published-levels'

// Stormglass dev page (internal id fleet): playable at /dev/fleet on a dev server and, since promotion, at /play/stormglass for players.
// ?hold=0 removes the opponent's 700 ms pause so a whole match fits in the test timeout.
test.use({ viewport: { width: 360, height: 780 } })

/** A new player's path: the shared e2e state opens every stop, so this takes that key away before the page loads. */
const lockPath = (page: Page) => page.addInitScript(() => localStorage.removeItem('duelwise.any'))

const shipCellsNow = (page: Page) => page.locator('[data-testid^="fleet-setup-"][data-state="ship"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')).join())

test.describe('fleet dev page and promotion', () => {
  test('is promoted: listed on /play, played at /play/stormglass, no route at the internal id', async ({ page }) => {
    await page.goto('/play')
    await expect(page.getByRole('heading', { name: 'Chess' }).first()).toBeVisible()
    await expect(page.getByText(/stormglass/i).first()).toBeVisible()
    await page.goto('/play/stormglass')
    await expect(page.getByTestId('fleet-page')).toBeVisible()
    // The play page sits in the shared shell: back link, guide button and sound control.
    await expect(page.getByTestId('game-shell')).toHaveAttribute('data-game', 'fleet')
    await expect(page.getByTestId('game-back')).toBeVisible()
    await expect(page.getByTestId('game-sound-button')).toBeVisible()
    await expect(page.getByRole('button', { name: 'How to play' })).toBeVisible()
    const res = await page.goto('/play/fleet')
    expect(res?.status()).toBe(404)
    await expect(page.getByTestId('fleet-page')).toHaveCount(0)
  })

  test('setup on a phone: Ready is on screen before any scroll, and the page runs intro, hidden-fleet line, play mode, fleet', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 })
    await page.goto('/play/stormglass')
    const ready = page.getByTestId('fleet-ready')
    await expect(ready).toBeVisible()
    await expect(ready).toHaveText(/^Start match vs \S+$/)
    expect(await page.evaluate(() => scrollY)).toBe(0)
    await expect(ready).toBeInViewport({ ratio: 1 })
    const y = async (l: ReturnType<Page['getByTestId']>) => (await l.boundingBox())!.y
    const intro = page.getByText('Hide five ships on your grid')
    const hidden = page.getByText('In counted matches the server keeps both fleets hidden until the match ends.')
    await expect(hidden).toBeVisible()
    const order = [await y(intro), await y(hidden), await y(page.getByTestId('play-mode')), await y(page.getByTestId('fleet-placement'))]
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  test('setup: shuffle changes the fleet and Ready starts the match', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    const ships = page.locator('[data-testid^="fleet-setup-"][data-state="ship"]')
    await expect(ships).toHaveCount(17)
    const before = await shipCellsNow(page)
    await page.getByTestId('fleet-shuffle').click()
    await expect(ships).toHaveCount(17)
    expect(await shipCellsNow(page)).not.toBe(before)
    await page.getByTestId('fleet-ready').click()
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-phase', 'play')
  })

  test('setup: selecting a ship and tapping it again turns it, so its cells change', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    const ships = page.locator('[data-testid^="fleet-setup-"][data-state="ship"]')
    let turned = false
    // A turn is refused when it would cross another ship, so shuffle until one is accepted.
    for (let attempt = 0; attempt < 12 && !turned; attempt++) {
      await page.getByTestId('fleet-shuffle').click()
      const before = await shipCellsNow(page)
      await ships.first().click()
      await expect(page.getByTestId('fleet-rotate')).toContainText(/across|down/)
      await ships.first().click()
      const after = await shipCellsNow(page)
      turned = after !== before
    }
    expect(turned).toBe(true)
    await expect(ships).toHaveCount(17)
  })

  test('setup: dragging a ship moves it by exactly the drag offset', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    const read = async () =>
      new Set(
        await page
          .locator('[data-testid^="fleet-setup-"][data-state="ship"]')
          .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-testid')!.split('-').pop()))),
      )
    const centre = async (n: number) => {
      const box = (await page.getByTestId(`fleet-setup-${n}`).boundingBox())!
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    let proven = false
    // One drag per shuffle with nothing selected, onto open water: only the drag branch can move a ship then.
    for (let attempt = 0; attempt < 40 && !proven; attempt++) {
      await page.getByTestId('fleet-shuffle').click()
      const before = await read()
      const grab = Math.max(...before)
      for (const delta of [10, -10, 1, -1]) {
        const to = grab + delta
        if (to < 0 || to > 99 || before.has(to)) continue
        const a = await centre(grab)
        const b = await centre(to)
        await page.mouse.move(a.x, a.y)
        await page.mouse.down()
        await page.mouse.move(b.x, b.y, { steps: 4 })
        await page.mouse.up()
        // WebKit paints the moved ship after mouse.up resolves. A refused drop never changes the cells, so the wait is bounded and that case still falls through below.
        let after = await read()
        for (let wait = 0; wait < 10 && [...before].every((x) => after.has(x)); wait++) {
          await page.waitForTimeout(30)
          after = await read()
        }
        if ([...before].every((x) => after.has(x))) break
        // Exactly one straight ship through the grabbed cell moved by the drag offset; every other cell stayed.
        const shifted = (ship: number[]) => new Set([...before].filter((x) => !ship.includes(x)).concat(ship.map((x) => x + delta)))
        const same = (u: Set<number>, v: Set<number>) => u.size === v.size && [...u].every((x) => v.has(x))
        const fits = [1, 10].some((step) =>
          [2, 3, 4, 5].some((len) =>
            Array.from({ length: len }, (_, k) => grab - k * step).some((start) => {
              const ship = Array.from({ length: len }, (_, k) => start + k * step)
              return ship.every((x) => before.has(x)) && same(shifted(ship), after)
            }),
          ),
        )
        expect(fits).toBe(true)
        proven = true
        break
      }
    }
    expect(proven).toBe(true)
  })

  test('setup: a keyboard can select and turn a ship (Enter, no pointer)', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    const ships = page.locator('[data-testid^="fleet-setup-"][data-state="ship"]')
    await expect(page.getByTestId('fleet-rotate')).toBeDisabled()
    let turned = false
    for (let attempt = 0; attempt < 12 && !turned; attempt++) {
      await page.getByTestId('fleet-shuffle').click()
      const before = await shipCellsNow(page)
      await ships.first().focus()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('fleet-rotate')).toBeEnabled()
      await page.keyboard.press('Space')
      turned = (await shipCellsNow(page)) !== before
    }
    expect(turned).toBe(true)
  })

  test('plays a whole match to a result at 360 wide without the page ever shifting', async ({ page }) => {
    test.setTimeout(150_000)
    await page.goto('/dev/fleet?hold=0')
    await page.getByTestId('fleet-shuffle').click()
    await page.getByTestId('fleet-ready').click()
    const root = page.getByTestId('fleet-page')
    await expect(root).toHaveAttribute('data-turn', 'you')
    // Start from the top so the end-of-match scroll into view is really needed.
    await page.evaluate(() => scrollTo(0, 0))
    // Then the design's own fit test (section 2.2): scroll so the HUD is at the top, which keeps the board, Fire and the click targets in view with the In training badge in the header.
    await page.getByTestId('fleet-hud').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY))

    const board = page.getByTestId('fleet-cell-board')
    const fire = page.getByTestId('fleet-fire')
    const own = page.getByTestId('fleet-own')
    const rect = async () => ({
      board: await board.boundingBox(),
      fire: await fire.boundingBox(),
      own: await own.boundingBox(),
    })
    const start = await rect()
    expect(start.board!.width).toBeGreaterThan(300)
    // No horizontal scroll at 360.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    // Fire is disabled until a square is aimed; the aimed square shows in the chip.
    await expect(fire).toBeDisabled()

    let hits = 0
    let misses = 0
    for (let i = 0; i < 100; i++) {
      if ((await root.getAttribute('data-turn')) === 'over') break
      await expect(root).toHaveAttribute('data-turn', /you|over/)
      if ((await root.getAttribute('data-turn')) === 'over') break
      const cell = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').first()
      const id = (await cell.getAttribute('data-testid'))!
      await cell.click()
      await expect(cell).toHaveAttribute('data-aimed', '')
      await expect(page.getByTestId('fleet-aim-chip')).not.toBeEmpty()
      // Alternate the two ways to fire: tap again, or press Fire.
      if (i % 2 === 0) await cell.click()
      else await fire.click()
      await expect(page.getByTestId(id)).not.toHaveAttribute('data-state', 'open')
      const state = await page.getByTestId(id).getAttribute('data-state')
      if (state === 'hit') hits++
      else misses++
      // The board and the Fire bar never move or resize; the own-waters card holds still too until the result card mounts above it.
      const turnBefore = await root.getAttribute('data-turn')
      const now = await rect()
      const turnAfter = await root.getAttribute('data-turn')
      if (turnBefore !== 'over' && turnAfter !== 'over') {
        expect(now.board).toEqual(start.board)
        expect(now.fire).toEqual(start.fire)
        expect(now.own).toEqual(start.own)
      }
    }
    await expect(page.getByTestId('result-panel')).toBeVisible()
    await expect(page.getByTestId('result-reason')).toContainText(/sank/)
    // The result panel brings itself into view: no manual scroll is needed to reach the rematch button.
    await expect(page.getByTestId('rematch')).toBeInViewport()
    // The reveal holds the two-board strip.
    await expect(page.getByTestId('fleet-reveal')).toBeVisible()
    await expect(page.getByTestId('fleet-end-theirs-board')).toBeVisible()
    await expect(page.getByTestId('fleet-end-yours-board')).toBeVisible()
    // Both reveal boards draw each ship as one hull, under the marks.
    await expect(page.getByTestId('fleet-end-theirs-board').locator('[data-hull]')).toHaveCount(5)
    await expect(page.getByTestId('fleet-end-yours-board').locator('[data-hull]')).toHaveCount(5)
    await expect(fire).toBeDisabled()
    expect(hits + misses).toBeGreaterThan(10)
    // The hit/miss feedback marks exist on the board; at the end the whole enemy fleet is shown.
    await expect(page.locator('[data-testid^="fleet-cell-"][data-state="hit"]').first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await page.getByTestId('rematch').click()
    await expect(root).toHaveAttribute('data-phase', 'setup')
  })

  test('their opponent pause is real by default and the layout holds still through it', async ({ page }) => {
    await page.goto('/dev/fleet')
    await page.getByTestId('fleet-ready').click()
    const board = page.getByTestId('fleet-cell-board')
    const before = await board.boundingBox()
    const cell = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').first()
    await cell.click()
    await cell.click()
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'ai')
    expect(await board.boundingBox()).toEqual(before)
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'you')
    expect(await board.boundingBox()).toEqual(before)
    await expect(page.getByTestId('fleet-event')).toContainText(/fired at/)
  })

  test('resigning ends the match: Fire is off, the shot count holds, and no fleet is claimed to be shown', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    await page.getByTestId('fleet-ready').click()
    const cell = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').first()
    await cell.click()
    await expect(page.getByTestId('fleet-fire')).toBeEnabled()
    await page.getByTestId('fleet-resign').click()
    // One tap only asks: the match goes on until the confirm is answered.
    await expect(page.getByTestId('result-panel')).toHaveCount(0)
    await expect(page.getByTestId('fleet-resign-yes')).toHaveText('Yes, resign')
    await expect(page.getByTestId('fleet-resign-keep')).toBeInViewport({ ratio: 1 })
    await expect(page.getByTestId('fleet-resign-yes')).toBeInViewport({ ratio: 1 })
    await page.getByTestId('fleet-resign-keep').click()
    await expect(page.getByTestId('result-panel')).toHaveCount(0)
    await expect(page.getByTestId('fleet-fire')).toBeEnabled()
    await expect(page.getByTestId('fleet-resign')).toBeVisible()
    await page.getByTestId('fleet-resign').click()
    await page.getByTestId('fleet-resign-yes').click()
    await expect(page.getByTestId('result-panel')).toContainText('You resigned.')
    await expect(page.getByTestId('fleet-fire')).toBeDisabled()
    await expect(page.getByTestId('fleet-aim-chip')).toBeEmpty()
    await expect(page.getByTestId('fleet-shot-count')).toHaveText('Shot 0')
    await expect(page.getByTestId('fleet-reveal')).toHaveCount(0)
    await page.getByTestId('fleet-fire').click({ force: true })
    await cell.click({ force: true })
    await expect(page.getByTestId('fleet-shot-count')).toHaveText('Shot 0')
  })
})

test.describe('fleet dev page at desktop width', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  for (const [width, height] of [[1024, 768], [1280, 800], [1440, 900]] as const) {
    test(`setup at ${width}: the fleet card sits left at 420 px, the picker to its right, and no badge leaves its card`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await lockPath(page)
      await page.goto('/play/stormglass')
      await expect(page.getByTestId('path-stop-champion')).toHaveAttribute('data-state', 'locked')
      const card = (await page.getByTestId('fleet-placement').boundingBox())!
      const picker = (await page.getByTestId('setup-picker').boundingBox())!
      expect(Math.abs(card.width - 420)).toBeLessThan(1)
      expect(picker.x).toBeGreaterThanOrEqual(card.x + card.width)
      expect(Math.abs(picker.y - card.y)).toBeLessThan(2)
      // Every published level shows its measured strength in the card's right-hand slot (the In training badge is gone once a level is published); it must sit inside the card, unclipped.
      const published = publishedLevels('fleet')
      expect(published.length).toBeGreaterThan(0)
      const rows = await page.locator('label[data-persona]').evaluateAll((els) =>
        els.map((row) => {
          const slot = row.querySelector(':scope > span:last-child')!
          const range = document.createRange()
          range.selectNodeContents(slot)
          const text = range.getBoundingClientRect()
          const card = row.getBoundingClientRect()
          const badge = slot.querySelector('[data-testid="preview-badge"]')
          const badgeBox = badge?.getBoundingClientRect()
          return {
            level: row.getAttribute('data-persona'),
            strength: (slot.textContent ?? '').trim(),
            left: card.left,
            right: card.right,
            textLeft: text.left,
            textRight: text.right,
            textEmpty: text.width === 0,
            slotClipped: slot.scrollWidth > slot.clientWidth,
            badgeRight: badgeBox?.right ?? null,
          }
        }),
      )
      expect(rows.map((r) => r.level)).toEqual(published)
      // The locked path has the longest labels, and its four portraits and their labels each keep clear of the next stop.
      const stops = await page.getByTestId('path-stops').evaluate((ol) => {
        const textRect = (el: Element) => {
          const range = document.createRange()
          range.selectNodeContents(el)
          return range.getBoundingClientRect()
        }
        const items = [...ol.querySelectorAll(':scope > li')]
        return {
          scrollWidth: ol.scrollWidth,
          clientWidth: ol.clientWidth,
          portraits: items.map((li) => li.querySelector('[data-testid^="persona-avatar-"]')!.getBoundingClientRect().toJSON() as DOMRect),
          names: items.map((li) => textRect(li.querySelector(':scope > b')!).toJSON() as DOMRect),
          states: items.map((li) => textRect(li.querySelector(':scope > span:last-child')!).toJSON() as DOMRect),
        }
      })
      expect(stops.portraits).toHaveLength(4)
      expect(stops.scrollWidth).toBeLessThanOrEqual(stops.clientWidth)
      for (const i of [0, 1, 2]) {
        expect(stops.portraits[i + 1]!.left - stops.portraits[i]!.right, `portrait gap after stop ${i}`).toBeGreaterThanOrEqual(16)
        expect(stops.names[i + 1]!.left - stops.names[i]!.right, `name gap after stop ${i}`).toBeGreaterThan(0)
        expect(stops.states[i + 1]!.left - stops.states[i]!.right, `state label gap after stop ${i}`).toBeGreaterThan(0)
      }
      for (const r of rows) {
        expect(r.strength, `${r.level} shows its published strength`).toMatch(/^(In training)?\s*site Elo \d+$/)
        expect(r.textEmpty, `${r.level} strength text has a box`).toBe(false)
        expect(r.textLeft, `${r.level} strength starts inside its card`).toBeGreaterThanOrEqual(r.left)
        expect(r.textRight, `${r.level} strength`).toBeLessThanOrEqual(r.right)
        expect(r.slotClipped, `${r.level} strength text clipped`).toBe(false)
        if (r.badgeRight !== null) expect(r.badgeRight, `${r.level} badge`).toBeLessThanOrEqual(r.right)
      }
      // The picker's blocks stay in their own places: none lands on another, and Ready keeps its button height.
      // Ready sits first in the picker column, above the path and the levels, and is not pinned over them: no block lands on another at any scroll.
      const blocks = await Promise.all(['fleet-placement', 'level-picker', 'identity-card', 'fleet-ready', 'learn-graph'].map(async (id) => ({ id, box: (await page.getByTestId(id).boundingBox())! })))
      for (const [i, a] of blocks.entries())
        for (const b of blocks.slice(i + 1)) {
          const overlap = a.box.x < b.box.x + b.box.width && b.box.x < a.box.x + a.box.width && a.box.y < b.box.y + b.box.height && b.box.y < a.box.y + a.box.height
          expect(overlap, `${a.id} over ${b.id}`).toBe(false)
        }
      expect(blocks.find((b) => b.id === 'fleet-ready')!.box.height).toBeLessThanOrEqual(64)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      // Ready stays in its own slot at the top of the column, clear of the levels and the blocks after them, at the top of the page and at the foot.
      const ready = (await page.getByTestId('fleet-ready').boundingBox())!
      const levels = (await page.getByTestId('level-picker').boundingBox())!
      expect(ready.y + ready.height).toBeLessThanOrEqual(levels.y)
      const before = ready.y + (await page.evaluate(() => scrollY))
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      const after = (await page.getByTestId('fleet-ready').boundingBox())!.y + (await page.evaluate(() => scrollY))
      expect(after).toBe(before)
    })
  }

  for (const [width, height] of [[1024, 768], [1280, 800], [1440, 900]] as const) {
    test(`setup at ${width} x ${height}: Ready is above the fold`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await lockPath(page)
      await page.goto('/play/stormglass')
      await expect(page.getByTestId('fleet-ready')).toBeVisible()
      expect(await page.evaluate(() => scrollY)).toBe(0)
      await expect(page.getByTestId('fleet-ready')).toBeInViewport({ ratio: 1 })
    })
  }

  test('two boards sit side by side with Fire under the left one', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    await page.getByTestId('fleet-ready').click()
    const theirs = (await page.getByTestId('fleet-cell-board').boundingBox())!
    const mine = (await page.getByTestId('fleet-own-board').boundingBox())!
    const fire = (await page.getByTestId('fleet-fire').boundingBox())!
    expect(mine.x).toBeGreaterThan(theirs.x + theirs.width - 1)
    expect(Math.abs(mine.y - theirs.y)).toBeLessThan(2)
    expect(theirs.width).toBeGreaterThan(330)
    expect(Math.abs(mine.width - theirs.width)).toBeLessThan(2)
    expect(fire.y).toBeGreaterThan(theirs.y + theirs.height)
    expect(fire.x).toBeLessThan(mine.x)
    expect(fire.x + fire.width).toBeLessThanOrEqual(theirs.x + theirs.width + 1)
    await expect(page.getByTestId('fleet-status-row')).toBeHidden()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })
})

interface Ship { id: number; length: number; cell: number; vertical: boolean }

/** The enemy fleet of a fixed-seed match, from the same agent and seed the page uses, so a test can sink a chosen ship on a chosen shot. */
function enemyFleet(seed: number): Ship[] {
  return JSON.parse(execFileSync('bun', [join(import.meta.dirname, 'fleet-enemy.bun.ts'), String(seed)], { encoding: 'utf8' })) as Ship[]
}

const shipCells = (p: Ship): number[] => Array.from({ length: p.length }, (_, i) => p.cell + i * (p.vertical ? 10 : 1))

const SEED = 4242

async function seededMatch(page: Page, hold: number) {
  const fleet = enemyFleet(SEED)
  await page.goto(`/play/stormglass?seed=${SEED}&hold=${hold}`)
  await page.getByTestId('fleet-ready').click()
  await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'you')
  return fleet
}

async function fireAt(page: Page, cell: number) {
  const c = page.getByTestId(`fleet-cell-${cell}`)
  await c.click()
  await c.click()
}

test.describe('the sink, the moment of the game', () => {
  test('one hull surfaces across its cells, the sea darkens, the tally strikes through, and nothing moves', async ({ page }) => {
    const fleet = await seededMatch(page, 0)
    const small = fleet.find((p) => p.length === 2)!
    const board = page.getByTestId('fleet-cell-board')
    const before = await board.boundingBox()
    const [first, last] = shipCells(small)
    await fireAt(page, first!)
    await expect(page.getByTestId(`fleet-cell-${first}`)).toHaveAttribute('data-state', 'hit')
    await expect(page.getByTestId(`fleet-cell-${first}`).locator('[data-mark="flame"]')).toBeVisible()
    await expect(board.locator('[data-hull]')).toHaveCount(0)
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'you')
    await fireAt(page, last!)
    const hull = board.locator('[data-hull][data-surfacing]')
    await expect(hull).toHaveCount(1)
    await expect(board.locator('[data-sea-dark]')).toHaveCount(1)
    await expect(page.getByTestId('fleet-tally-enemy').locator('[data-fresh]')).toHaveCount(1)
    const animations = await page.evaluate(() => {
      const name = (q: string) => getComputedStyle(document.querySelector(q)!).animationName
      return { sea: name('[data-sea-dark]'), hull: name('[data-surfacing]'), strike: name('[data-fresh] .fleet-strike') }
    })
    expect(animations).toEqual({ sea: 'fleet-sea-dark', hull: 'fleet-surface', strike: 'fleet-strike' })
    // The hull lies over exactly its two cells, in one piece.
    const a = (await page.getByTestId(`fleet-cell-${first}`).boundingBox())!
    await expect(board.locator('[data-sea-dark]')).toHaveCount(0)
    const box = (await board.locator('[data-hull]').boundingBox())!
    const z = (await page.getByTestId(`fleet-cell-${last}`).boundingBox())!
    expect(Math.abs(box.x - a.x)).toBeLessThan(2)
    expect(Math.abs(box.y - a.y)).toBeLessThan(2)
    expect(Math.abs(box.x + box.width - (z.x + z.width))).toBeLessThan(2)
    expect(Math.abs(box.y + box.height - (z.y + z.height))).toBeLessThan(2)
    // The moment ends on the spec's end state: the silhouette at 70 percent, the strike still there.
    await expect(board.locator('[data-hull][data-surfacing]')).toHaveCount(0)
    await expect(board.locator('[data-hull]')).toHaveCSS('opacity', '0.7')
    await expect(page.getByTestId('fleet-tally-enemy').locator('[data-sunk]')).toHaveCount(1)
    expect(await board.boundingBox()).toEqual(before)
  })

  test('reduced motion keeps the end state and removes every movement', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const fleet = await seededMatch(page, 0)
    const [first, last] = shipCells(fleet.find((p) => p.length === 2)!)
    const board = page.getByTestId('fleet-cell-board')
    await page.getByTestId(`fleet-cell-${first}`).click()
    const noCrossMotion = await page.evaluate(() => getComputedStyle(document.querySelector('[data-cross]')!).transitionDuration)
    expect(parseFloat(noCrossMotion)).toBeLessThan(0.001)
    await page.getByTestId(`fleet-cell-${first}`).click()
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'you')
    await fireAt(page, last!)
    await expect(board.locator('[data-hull]')).toHaveCount(1)
    const motion = await page.evaluate(() =>
      [...document.querySelectorAll('.fleet-land, [data-surfacing], [data-fresh], .fleet-strike, .fleet-ping, .play-hud-seat')].map((e) => getComputedStyle(e).animationName).filter((n) => n !== 'none'),
    )
    expect(motion).toEqual([])
    await expect(board.locator('[data-sea-dark]')).toBeHidden()
    await expect(board.locator('[data-hull]')).toHaveCSS('opacity', '0.7')
  })

  test('the winning shot plays its sink before the result covers the board, and the reveal says how it ended', async ({ page }) => {
    const fleet = await seededMatch(page, 1)
    const cells = fleet.flatMap(shipCells)
    for (const cell of cells.slice(0, -1)) {
      await fireAt(page, cell)
      await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'you')
    }
    await fireAt(page, cells.at(-1)!)
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'over')
    await expect(page.getByTestId('fleet-cell-board').locator('[data-hull][data-surfacing]')).toHaveCount(1)
    await expect(page.getByTestId('result-panel')).toHaveCount(0)
    await expect(page.getByTestId('result-panel')).toBeVisible()
    await expect(page.getByTestId('result-reason')).toContainText('sank')
    await expect(page.getByTestId('fleet-luck')).toContainText('should hit about')
  })

  test('the luck line arrives after the result without moving anything: its slot is reserved, so the panel and the slot keep their boxes', async ({ page, context }) => {
    const fleet = await seededMatch(page, 0)
    const cells = fleet.flatMap(shipCells)
    // A slow phone: scoring takes long enough that the page is seen without the line first.
    await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 6 })
    for (const cell of cells) {
      await fireAt(page, cell)
      if (cell !== cells.at(-1)) await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'you')
    }
    const panel = page.getByTestId('result-panel')
    const slot = page.getByTestId('fleet-luck-slot')
    await expect(slot).toBeAttached()
    // Sizes and document height: the page may scroll the result into view meanwhile, which moves y but not what is laid out.
    const boxes = async () => {
      const [p, sl] = [await panel.boundingBox(), await slot.boundingBox()]
      return { panel: [p!.width, p!.height], slot: [sl!.width, sl!.height], doc: await page.evaluate(() => document.documentElement.scrollHeight) }
    }
    await expect(panel).toBeVisible()
    expect(await page.getByTestId('fleet-luck').textContent()).toBe('')
    const before = await boxes()
    await expect(page.getByTestId('fleet-luck')).toContainText('should hit about')
    // Let the fade finish, then compare: the line is in its reserved slot.
    await expect(page.getByTestId('fleet-luck')).toHaveCSS('opacity', '1')
    expect(await boxes()).toEqual(before)
  })
})

test.describe('fleet play details', () => {
  test('the aside prints the mean shots the script measured, never a number a fleet cannot go down in', async ({ page }) => {
    await seededMatch(page, 0)
    const reg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'packages', 'agents', 'registry', 'fleet.json'), 'utf8')) as { measured: { easy: { meanShots: { mean: number } } } }
    const text = (await page.getByTestId('fleet-strength').textContent())!
    const shown = Number(/in (\d+\.\d) shots/.exec(text)?.[1])
    expect(shown).toBeGreaterThanOrEqual(17)
    expect(shown).toBe(Number(reg.measured.easy.meanShots.mean.toFixed(1)))
  })

  test('the shared HUD with the hull swatch, a crosshair through the aim, and one hull per ship on setup', async ({ page }) => {
    await page.goto('/play/stormglass?hold=0')
    await expect(page.getByTestId('fleet-setup-board').locator('[data-hull]')).toHaveCount(5)
    await expect(page.getByText('You fire first.')).toBeVisible()
    await page.getByTestId('fleet-ready').click()
    const hud = page.getByTestId('fleet-hud').getByTestId('play-hud')
    await expect(hud.getByTestId('play-hud-clock')).toBeVisible()
    await expect(hud.locator('[data-swatch="you"]')).toHaveClass(/bg-hull/)
    const cross = page.locator('[data-cross][data-on]')
    await expect(cross).toHaveCount(0)
    await page.getByTestId('fleet-cell-34').click()
    await expect(cross).toHaveCount(2)
    await expect(cross.first()).toHaveCSS('opacity', '0.35')
    const cell = (await page.getByTestId('fleet-cell-34').boundingBox())!
    const row = (await page.locator('[data-cross="row"]').boundingBox())!
    const col = (await page.locator('[data-cross="col"]').boundingBox())!
    await expect.poll(async () => Math.abs((await page.locator('[data-cross="row"]').boundingBox())!.y - cell.y)).toBeLessThan(2)
    await expect.poll(async () => Math.abs((await page.locator('[data-cross="col"]').boundingBox())!.x - cell.x)).toBeLessThan(2)
    expect(row.height).toBeLessThan(cell.height + 2)
    expect(col.width).toBeLessThan(cell.width + 2)
  })

  test('the grid is one tab stop, arrow keys walk it, and Enter aims then fires', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    const setup = page.getByTestId('fleet-setup-board')
    await expect(setup).toHaveAttribute('role', 'grid')
    await expect(setup.locator('[role="row"]')).toHaveCount(10)
    await expect(setup.locator('[role="gridcell"]')).toHaveCount(100)
    await expect(setup.locator('[tabindex="0"]')).toHaveCount(1)
    await page.getByTestId('fleet-ready').click()
    const board = page.getByTestId('fleet-cell-board')
    await expect(board.locator('[tabindex="0"]')).toHaveCount(1)
    await page.getByTestId('fleet-cell-0').focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('fleet-cell-1')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('fleet-cell-11')).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('fleet-cell-10')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(page.getByTestId('fleet-cell-0')).toBeFocused()
    await expect(board.locator('[tabindex="0"]')).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('fleet-cell-0')).toHaveAttribute('data-aimed', '')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('fleet-cell-0')).not.toHaveAttribute('data-state', 'open')
    // Tab leaves the grid at once: the next stop is not another cell.
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).not.toBe('gridcell')
  })

  test('R turns the selected ship from the keyboard', async ({ page }) => {
    await page.goto('/dev/fleet?hold=0')
    const ships = page.locator('[data-testid^="fleet-setup-"][data-state="ship"]')
    let turned = false
    for (let attempt = 0; attempt < 12 && !turned; attempt++) {
      await page.getByTestId('fleet-shuffle').click()
      const before = await shipCellsNow(page)
      await ships.first().focus()
      await page.keyboard.press('Enter')
      await page.keyboard.press('r')
      turned = (await shipCellsNow(page)) !== before
    }
    expect(turned).toBe(true)
  })

  test('a shot whose reply never came stays aimed and locked, names its square, and Fire sends that same shot', async ({ page }) => {
    let drop = false
    await page.route(/_serverFn/, async (route) => {
      if (drop && (route.request().postData() ?? '').includes('actions')) await route.abort('failed')
      else await route.continue()
    })
    await page.goto('/play/stormglass')
    await page.getByTestId('fleet-ready').click()
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'you')
    expect(await page.getByTestId('fleet-page').getAttribute('data-counted')).toBe('true')
    drop = true
    const lost = page.getByTestId('fleet-cell-22')
    await lost.click()
    await lost.click()
    await expect(page.getByTestId('fleet-failure')).toHaveText('Shot at C3 not sent. Press Fire to send it again.')
    await expect(lost).toHaveAttribute('data-aimed', '')
    await expect(page.getByTestId('fleet-aim-chip')).toHaveText('C3')
    // Another square is not accepted: the aim stays on the lost shot and the line stays true.
    const other = page.getByTestId('fleet-cell-34')
    await other.click()
    await other.click()
    await expect(lost).toHaveAttribute('data-aimed', '')
    await expect(other).not.toHaveAttribute('data-aimed', '')
    await expect(page.getByTestId('fleet-aim-chip')).toHaveText('C3')
    await expect(page.getByTestId('fleet-failure')).toHaveText('Shot at C3 not sent. Press Fire to send it again.')
    drop = false
    await expect(page.getByTestId('fleet-fire')).toBeEnabled()
    await page.getByTestId('fleet-fire').click()
    await expect(page.getByTestId('fleet-failure')).toHaveCount(0)
    await expect(lost).not.toHaveAttribute('data-state', 'open')
    await expect(other).toHaveAttribute('data-state', 'open')
    await expect(page.getByTestId('fleet-aim-chip')).toHaveText('')
  })

  test('a reload that ends a counted match says so at the top of setup, once', async ({ page }) => {
    await page.goto('/play/stormglass')
    await page.getByTestId('fleet-ready').click()
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'you')
    const cell = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').first()
    await cell.click()
    await cell.click()
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'you')
    await page.reload()
    await expect(page.getByTestId('fleet-left-line')).toHaveText('Reloading ended the match. It counts as a loss.')
    await expect(page.getByTestId('resigned-notice')).toHaveCount(0)
    await page.getByTestId('fleet-ready').click()
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-phase', 'play')
    await expect(page.getByTestId('fleet-left-line')).toHaveCount(0)
  })

  test('a match opens at its HUD: HUD, board, Fire and your map are on the first screen of a phone, with the training notice shown and dismissed', async ({ page }) => {
    // Needed on screen: the top of the HUD down through the bottom of Fire is the always-on part; your map fits whole at 844 and 740 tall and is within 24 px of it at 664.
    const NEED: Array<[number, number, number]> = [[390, 844, 0], [390, 664, 24], [360, 740, 0]]
    for (const [w, h, mapSlack] of NEED) {
      for (const dismissed of [false, true]) {
        await page.setViewportSize({ width: w, height: h })
        await page.addInitScript((hide) => {
          try {
            if (hide) localStorage.setItem('duelwise.notice-hidden.fleet', '1')
            else localStorage.removeItem('duelwise.notice-hidden.fleet')
          } catch {}
        }, dismissed)
        await page.goto('/play/stormglass?hold=0')
        await expect(page.getByTestId('fleet-ready')).toBeVisible()
        await page.getByTestId('fleet-ready').click()
        await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-phase', 'play')
        await expect(page.getByTestId('fleet-cell-0')).toBeFocused()
        const box = async (id: string) => (await page.getByTestId(id).first().boundingBox())!
        const hud = await box('fleet-hud')
        const fire = await box('fleet-fire')
        const own = await box('fleet-own')
        expect.soft(hud.y, `${w}x${h} dismissed=${dismissed}: HUD at the top`).toBeLessThan(8)
        expect.soft(fire.y + fire.height, `${w}x${h} dismissed=${dismissed}: Fire on screen`).toBeLessThanOrEqual(h)
        expect.soft(own.y + own.height, `${w}x${h} dismissed=${dismissed}: your map on screen (at most ${mapSlack}px of its card below the fold)`).toBeLessThanOrEqual(h + mapSlack)
      }
    }
  })

  test('on a phone the hint under the placement board can be scrolled clear of the pinned Start button', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/play/stormglass')
    await expect(page.getByTestId('fleet-ready')).toBeVisible()
    const hint = page.getByText('Tap a ship to select it, tap it again')
    await hint.evaluate((el) => el.scrollIntoView({ block: 'end' }))
    const [h, start] = [(await hint.boundingBox())!, (await page.getByTestId('fleet-ready').boundingBox())!]
    expect(h.y + h.height).toBeLessThanOrEqual(start.y)
    expect(h.y).toBeGreaterThanOrEqual(0)
  })

  test('offline: every other page keeps the chip in its old bottom left corner', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    for (const path of ['/', '/play/chess']) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      await context.setOffline(true)
      await expect(page.getByTestId('offline-chip')).toHaveText('Offline: matches will sync later')
      const chip = (await page.getByTestId('offline-chip').boundingBox())!
      expect(chip.x).toBeLessThan(20)
      expect(chip.y + chip.height).toBeGreaterThan(844 - 20)
      await context.setOffline(false)
    }
  })

  test('offline: Rated does not start, Practice does, and the chip stays off the sticky Start and never takes its tap', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/play/stormglass')
    await expect(page.getByTestId('fleet-ready')).toHaveText(/^Start match vs/)
    await context.setOffline(true)
    const ready = page.getByTestId('fleet-ready')
    await expect(page.getByTestId('offline-chip')).toHaveText('Offline: Practice only')
    await expect(page.getByTestId('fleet-offline-line')).toBeVisible()
    await expect(ready).toBeDisabled()
    await expect(ready).toHaveText('Rated needs a connection')
    await page.getByTestId('play-mode').locator('[data-mode-option="practice"]').click()
    await expect(ready).toBeEnabled()
    await expect(ready).toHaveText(/^Start match vs/)
    const chip = (await page.getByTestId('offline-chip').boundingBox())!
    const start = (await ready.boundingBox())!
    expect(chip.y + chip.height <= start.y || start.y + start.height <= chip.y).toBe(true)
    const onTop = await ready.evaluate((el) => {
      const b = el.getBoundingClientRect()
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === el
    })
    expect(onTop).toBe(true)
    await ready.click()
    await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-phase', 'play')
    await context.setOffline(false)
  })
})
