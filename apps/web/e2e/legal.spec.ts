import { expect, test } from '@playwright/test'

const BANNED = /Beat Me|Street Fighter|Counter-Strike|Wordle|Connect Four|\u2014|\u2013/

test.describe('privacy notice matches the legitimate-interest basis', () => {
  test('says what is stored and not, why, how to opt out, how to delete, and the hold\'em caveats', async ({ page }) => {
    await page.goto('/privacy')
    const p = page.getByTestId('privacy')
    await expect(p.getByRole('heading', { name: 'Privacy', level: 1 })).toBeVisible()
    await expect(page.getByTestId('privacy-stored')).toContainText(/name, email address and avatar/)
    await expect(page.getByTestId('privacy-stored')).toContainText(/replayable record/)
    await expect(page.getByTestId('privacy-not-stored')).toContainText(/IP addresses/)
    await expect(page.getByTestId('privacy-why')).toContainText(/legitimate interest/)
    await expect(page.getByTestId('privacy-why')).toContainText(/not on a consent tick box/)
    await expect(page.getByTestId('privacy-why')).toContainText(/switch starts on/)
    await expect(page.getByTestId('privacy-optout')).toContainText(/Turn off training use/)
    await expect(page.getByTestId('privacy-why')).toContainText(/Chess, Heads-Up Hold'em, Word Duel, Tinderbox and Coldstore matches are not used for training/)
    await expect(page.getByTestId('privacy-why')).not.toContainText(/Four in a Row matches are not/)
    await expect(page.getByTestId('privacy-deletion')).toContainText(/delete their account in settings/)
    await expect(p).toContainText(/play chips only/)
    await expect(p).not.toHaveText(BANNED)
    await page.getByTestId('privacy-optout').getByRole('link', { name: 'settings page' }).click()
    await expect(page).toHaveURL(/\/settings$/)
  })

  test('says what a Hold\'em play profile is, that no agent uses it today, and where to switch it off', async ({ page }) => {
    await page.goto('/privacy')
    const section = page.getByTestId('privacy-poker-profile')
    await expect(section).toContainText(/how often you enter a hand, raise, fold to a bet and reach showdown/)
    await expect(section).toContainText(/No agent changes how it plays because of a profile today/)
    await expect(section).toContainText(/separate switch from training use/)
    await expect(section).not.toHaveText(BANNED)
    await section.getByRole('link', { name: 'settings page' }).click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByTestId('poker-profile-settings')).toBeVisible()
  })

  test('terms carry the hidden-information caveat and play chips only', async ({ page }) => {
    await page.goto('/terms')
    await expect(page.getByTestId('terms-hidden-info')).toContainText(/read the agent's cards or position from memory/)
    await expect(page.getByTestId('terms-chips')).toContainText(/never sold, never redeemable/)
    await expect(page.getByTestId('terms-chips')).toContainText(/no prizes/)
    await expect(page.getByTestId('terms')).not.toHaveText(BANNED)
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' })).toBeVisible()
  })

  test('both pages fit a phone without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 })
    for (const path of ['/privacy', '/terms']) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
    }
  })
})

test.describe('Sentry and error boundary', () => {
  test('without a DSN Sentry is a no-op: no reporting requests, no page errors', async ({ page }) => {
    const errors: string[] = []
    const requests: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('request', (r) => requests.push(r.url()))
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    expect(errors).toEqual([])
    expect(requests.filter((u) => /sentry/i.test(new URL(u).hostname))).toEqual([])
  })

  test('a render error shows the fallback, keeps the header, and the way out works', async ({ page }) => {
    await page.goto('/dev/crash')
    const fb = page.getByTestId('error-fallback')
    await expect(fb).toBeVisible()
    await expect(fb).toContainText('Something went wrong')
    await expect(fb.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(page.getByRole('link', { name: /home$/ })).toBeVisible()
    await fb.getByRole('link', { name: 'Back to games' }).click()
    await expect(page).toHaveURL(/\/play$/)
    await expect(page.getByTestId('error-fallback')).toHaveCount(0)
  })
})

test.describe('delete account', () => {
  test('a guest has no delete control', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await expect(page.getByTestId('delete-account')).toHaveCount(0)
  })

  test('a signed-in player confirms, the account goes, and they are signed out', async ({ page }) => {
    await page.goto('/signin')
    await page.waitForLoadState('networkidle')
    await page.getByLabel('Name').fill('gone-soon')
    await page.getByRole('button', { name: 'Dev sign in' }).click()
    await expect(page.getByTestId('user-menu')).toContainText('gone-soon')
    await page.goto('/settings')
    const box = page.getByTestId('delete-account')
    await box.getByRole('button', { name: 'Delete my account' }).click()
    await box.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByTestId('user-menu')).toBeVisible()
    await box.getByRole('button', { name: 'Delete my account' }).click()
    await box.getByRole('button', { name: 'Yes, delete everything' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByTestId('user-menu')).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('user-menu')).toHaveCount(0)
  })
})
