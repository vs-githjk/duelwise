import { expect, test } from '@playwright/test'

// A match opens at the top of the page. A player who scrolled down the level list to the lowest level they can pick (Vesper or Sable) and pressed Start must not land part-way down the
// play screen with the header and HUD above the fold (laptop widths).
const GAMES = [
  { name: 'chess', url: '/play/chess', board: 'chess-board', hud: 'play-hud' },
  { name: 'four', url: '/play/four-in-a-row', board: 'four-board', hud: 'play-hud' },
  { name: 'crosscurrent', url: '/play/crosscurrent', board: 'slack-board', hud: 'play-hud' },
] as const

for (const g of GAMES) {
  for (const [vw, vh, practice] of [[1280, 800, false], [1366, 657, true]] as const) {
    for (const reduce of [false, true]) {
      test(`${g.name} opens at the top after Start from the lowest level, ${vw} by ${vh}${practice ? ', Practice' : ''}${reduce ? ', reduced motion' : ''}`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' })
        await page.setViewportSize({ width: vw, height: vh })
        await page.goto(`${g.url}?seed=3&side=seed`)
        if (practice) await page.locator('[data-mode-option="practice"]').click()
        const lowest = page.getByTestId('level-picker').locator('input[type=radio]:not([disabled])').last()
        await lowest.check({ force: true })
        const start = page.getByRole('button', { name: /Start match/ })
        await start.scrollIntoViewIfNeeded()
        // where the setup page scrolls at all (it does not at 1280 by 800 for Four and Crosscurrent), it is scrolled down to Start first
        if (g.name === 'chess') expect(await page.evaluate(() => window.scrollY), 'the setup page was scrolled down first').toBeGreaterThan(0)
        await start.click()
        await expect(page.getByTestId(g.board)).toBeVisible()
        await expect(page.getByTestId(g.hud)).toBeVisible()
        // Crosscurrent on a 657 tall screen cannot fit its Place bar (board at its 320 floor), so it keeps its own scroll of just far enough to show the bar (under 48)
        const allowed = g.name === 'crosscurrent' && vh < 700 ? 48 : 0
        expect(await page.evaluate(() => window.scrollY), 'scrollY after Start').toBeLessThanOrEqual(allowed)
        const top = (await page.getByTestId('game-shell').locator('header').boundingBox())!
        expect(top.y).toBeGreaterThanOrEqual(0)
        expect((await page.getByTestId(g.hud).boundingBox())!.y).toBeGreaterThanOrEqual(0)
      })
    }
  }
}
