import { expect, test, type Page } from '@playwright/test'
import { wordCore } from '@duelwise/core/src/games/word/core.ts'

// Music and sound effects. Real sound is never asserted: the page keeps a test hook (window.__duelwiseAudio) with the music state and
// the stingers it was asked to play. The browsers here keep their sound on (see playwright.config.ts), so a run is audible.

interface Hook {
  events: Array<{ type: string; outcome?: string; played?: boolean; mood?: string; on?: boolean }>
  state: () => { mood: string; gestured: boolean; hidden: boolean; musicOn: boolean; sfxOn: boolean; duck: number; playing: Record<string, number> }
}
declare global {
  interface Window {
    __duelwiseAudio?: Hook
  }
}
const state = (page: Page) => page.evaluate(() => window.__duelwiseAudio!.state())
const stingers = (page: Page) => page.evaluate(() => window.__duelwiseAudio!.events.filter((e) => e.type === 'stinger'))
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('duelwise.audio') ?? '{}') as { music?: boolean; muted?: boolean })

async function ready(page: Page, url: string) {
  await page.goto(url)
  await page.waitForFunction(() => Boolean(window.__duelwiseAudio))
}

async function pick(page: Page, url: string) {
  await ready(page, url)
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
}

test.describe('music', () => {
  test('nothing plays before the first tap; the tap starts the lobby loop', async ({ page }) => {
    await ready(page, '/play')
    let s = await state(page)
    expect(s).toMatchObject({ mood: 'lobby', gestured: false, musicOn: true, sfxOn: true })
    expect(s.playing).toEqual({})
    await page.getByRole('heading').first().click()
    await expect.poll(async () => (await state(page)).gestured).toBe(true)
    await expect.poll(async () => Object.keys((await state(page)).playing)).toEqual(['lobby'])
    s = await state(page)
    expect(s.duck).toBe(1)
  })

  test('the loop follows the page: board for chess, poker for hold\'em, action for the real-time games, the lobby after', async ({ page }) => {
    await ready(page, '/play')
    await page.getByRole('heading').first().click()
    const mood = async () => (await state(page)).mood
    await page.getByTestId('nav-settings').click()
    expect(await mood()).toBe('lobby')
    for (const [path, want] of [['/play/chess', 'board'], ['/play/heads-up-holdem', 'poker'], ['/play/word-duel', 'board'], ['/play/tinderbox', 'action'], ['/play/coldstore', 'action']] as const) {
      // A client side move, so the page (and its music) is the same one the whole time.
      await page.evaluate((p) => { history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')) }, path)
      await expect.poll(mood).toBe(want)
    }
    await page.getByTestId('home-link').click()
    await expect.poll(mood).toBe('lobby')
    // The crossfade ends with one loop playing.
    await expect.poll(async () => Object.keys((await state(page)).playing), { timeout: 8000 }).toEqual(['lobby'])
  })

  test('the Settings switches are separate, default on and survive a reload', async ({ page }) => {
    await ready(page, '/settings')
    const music = page.getByTestId('music-switch')
    const sfx = page.getByTestId('sfx-switch')
    await expect(music).toBeChecked()
    await expect(sfx).toBeChecked()
    await music.uncheck()
    await expect(sfx).toBeChecked()
    expect(await saved(page)).toMatchObject({ music: false })
    await page.reload()
    await expect(page.getByTestId('music-switch')).not.toBeChecked()
    await expect(page.getByTestId('sfx-switch')).toBeChecked()
    expect((await state(page)).musicOn).toBe(false)
    await page.getByTestId('sfx-switch').uncheck()
    await page.getByTestId('music-switch').check()
    await page.reload()
    await expect(page.getByTestId('music-switch')).toBeChecked()
    await expect(page.getByTestId('sfx-switch')).not.toBeChecked()
    expect(await saved(page)).toMatchObject({ music: true, muted: true })
  })

  test('the sound button in a game opens the same two switches, and a choice made there is the one Settings shows', async ({ page }) => {
    await ready(page, '/play/chess')
    await page.getByTestId('game-sound-button').click()
    const panel = page.getByTestId('game-sound-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('music-switch')).toBeChecked()
    await panel.getByTestId('music-switch').uncheck()
    await expect.poll(async () => (await state(page)).musicOn).toBe(false)
    expect(await saved(page)).toMatchObject({ music: false })
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await page.goto('/settings')
    await expect(page.getByTestId('music-switch')).not.toBeChecked()
    await expect(page.getByTestId('sfx-switch')).toBeChecked()
  })

  test('with music off a tap starts no loop', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('duelwise.audio', JSON.stringify({ volume: 0.7, muted: false, music: false })))
    await ready(page, '/play')
    await page.getByRole('heading').first().click()
    await expect.poll(async () => (await state(page)).gestured).toBe(true)
    expect((await state(page)).playing).toEqual({})
  })
})

test.describe('result stingers', () => {
  test('chess win', async ({ page }) => {
    await page.goto('/')
    await pick(page, `/play/chess?seed=3&fen=${encodeURIComponent('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1')}`)
    await page.getByTestId('sq-a1').click()
    await page.getByTestId('sq-a8').click()
    await expect(page.getByTestId('result-panel')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => stingers(page)).toEqual([{ type: 'stinger', outcome: 'win', played: true }])
    await expect.poll(async () => (await state(page)).duck, { timeout: 3000 }).toBeLessThan(1)
  })

  test('four in a row loss (resign)', async ({ page }) => {
    await pick(page, '/play/four-in-a-row?seed=3')
    await page.getByTestId('col-3').click()
    await page.getByRole('button', { name: /^resign$/i }).click()
    await page.getByRole('button', { name: 'Yes, resign' }).click()
    await expect(page.getByTestId('result-panel')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => stingers(page)).toEqual([{ type: 'stinger', outcome: 'loss', played: true }])
  })

  test('hold\'em loss (concede)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await pick(page, '/play/heads-up-holdem?seed=3')
    await expect(page.getByTestId('holdem-table')).toHaveAttribute('data-turn', /you|over/, { timeout: 30_000 })
    const concede = page.getByRole('button', { name: 'Concede' })
    await expect(concede).toBeEnabled()
    await concede.click()
    await page.getByRole('button', { name: 'Yes, concede' }).click()
    await expect(page.getByTestId('result-panel')).toBeVisible({ timeout: 60_000 })
    await expect.poll(async () => (await stingers(page)).map((s) => s.outcome)).toEqual(['loss'])
  })

  test('word duel draw has no stinger (it keeps the draw jingle)', async ({ page }) => {
    await pick(page, '/play/word-duel?seed=7')
    const answer = wordCore.init(7).answer
    const wrong = ['crane', 'slate', 'house'].find((w) => w !== answer)!
    for (const w of [wrong, answer]) {
      await page.getByTestId('word-input').fill(w)
      await page.getByTestId('word-input').press('Enter')
    }
    await expect(page.getByTestId('result-panel')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('result-panel')).toContainText('draw', { ignoreCase: true })
    await page.waitForTimeout(1500)
    expect(await stingers(page)).toEqual([])
  })

  test('with sound effects off the result records a stinger that was not played', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('duelwise.audio', JSON.stringify({ volume: 0.7, muted: true, music: true })))
    await pick(page, '/play/four-in-a-row?seed=3')
    await page.getByTestId('col-3').click()
    await page.getByRole('button', { name: /^resign$/i }).click()
    await page.getByRole('button', { name: 'Yes, resign' }).click()
    await expect(page.getByTestId('result-panel')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => stingers(page)).toEqual([{ type: 'stinger', outcome: 'loss', played: false }])
  })
})
