import { expect, test, type Page } from '@playwright/test'

const PLAY = '/play/four-in-a-row'

async function devSignIn(page: Page, name: string) {
  await page.goto('/signin')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Dev sign in' }).click()
  await expect(page).toHaveURL(/\/play$/)
  await expect(page.getByTestId('user-menu')).toContainText(name)
}

test.describe('sign-in and the training notice', () => {
  test('the sign-in page is a centred card that says why, keeps guests playing and links the privacy page', async ({ page }) => {
    await page.goto('/signin')
    await page.waitForLoadState('networkidle')
    const root = page.getByTestId('signin')
    await expect(root.getByRole('heading', { level: 1 })).toHaveText('Keep your place')
    await expect(root).toContainText('Playing never needs it')
    await expect(root.getByTestId('signin-privacy').getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
    await expect(root.getByTestId('signin-privacy')).toContainText('name and email')
    await root.getByTestId('signin-guest').click()
    await expect(page).toHaveURL(/\/play$/)
  })

  test('a guest sees Sign in; dev sign-in swaps it for the user menu', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByTestId('user-menu')).toHaveCount(0)
    await devSignIn(page, 'ada')
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCount(0)
    // The session survives a reload.
    await page.reload()
    await expect(page.getByTestId('user-menu')).toContainText('ada')
  })

  test('the notice shows before the first match with the opt-out on by default, and dismissing it sticks', async ({ page }) => {
    await page.goto(PLAY)
    const notice = page.getByTestId('training-notice')
    await expect(notice).toBeVisible()
    await expect(page.getByTestId('four-setup')).toBeVisible()
    const toggle = notice.getByRole('switch')
    await expect(toggle).toBeChecked()
    await expect(notice).not.toContainText('Beat Me')
    await notice.getByRole('button', { name: 'Got it' }).click()
    await expect(notice).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('four-setup')).toBeVisible()
    await expect(page.getByTestId('training-notice')).toHaveCount(0)
  })

  test('a guest opt-out persists across reloads and shows in settings', async ({ page }) => {
    await page.goto(PLAY)
    const toggle = page.getByTestId('training-notice').getByRole('switch')
    await toggle.uncheck()
    await expect(toggle).not.toBeChecked()
    await page.goto('/settings')
    const setting = page.getByTestId('training-settings').getByRole('switch')
    await expect(setting).not.toBeChecked()
    await page.reload()
    await expect(page.getByTestId('training-settings').getByRole('switch')).not.toBeChecked()
    await setting.check()
    await page.reload()
    await expect(page.getByTestId('training-settings').getByRole('switch')).toBeChecked()
  })

  test('the Hold\'em play profile switch starts on, persists, and is separate from training', async ({ page }) => {
    await page.goto('/settings')
    const poker = page.getByTestId('poker-profile-settings').getByRole('switch')
    await expect(poker).toBeChecked()
    await poker.uncheck()
    await expect(poker).not.toBeChecked()
    await page.reload()
    await expect(page.getByTestId('poker-profile-settings').getByRole('switch')).not.toBeChecked()
    await expect(page.getByTestId('training-settings').getByRole('switch')).toBeChecked()
    await page.getByTestId('poker-profile-settings').getByRole('switch').check()
    await page.reload()
    await expect(page.getByTestId('poker-profile-settings').getByRole('switch')).toBeChecked()
  })

  test('the leaderboard switch is for signed-in players only, starts on and persists (M3)', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByTestId('leaderboard-settings')).toHaveCount(0)
    await expect(page.getByTestId('forget-me')).toBeVisible()
    await devSignIn(page, 'hopper')
    await page.goto('/settings')
    // "Forget me here" clears a guest's browser identity; a signed-in player's data lives on the account, so the row is not offered.
    await expect(page.getByTestId('forget-me')).toHaveCount(0)
    const sw = page.getByTestId('leaderboard-settings').getByRole('switch', { name: 'Show me on the leaderboard' })
    await expect(sw).toBeChecked()
    await sw.uncheck()
    await expect(sw).not.toBeChecked()
    await page.reload()
    await expect(page.getByTestId('leaderboard-settings').getByRole('switch', { name: 'Show me on the leaderboard' })).not.toBeChecked()
    await page.goto('/privacy')
    await expect(page.getByTestId('privacy-stored')).toContainText('first name')
  })

  test('a signed-in user opt-out persists across reloads and across a new sign-in', async ({ page }) => {
    await devSignIn(page, 'grace')
    await page.goto('/settings')
    const setting = page.getByTestId('training-settings').getByRole('switch')
    await expect(setting).toBeChecked()
    await setting.uncheck()
    await expect(setting).not.toBeChecked()
    await page.reload()
    await expect(page.getByTestId('training-settings').getByRole('switch')).not.toBeChecked()
    await page.getByRole('button', { name: 'Sign out' }).first().click()
    await expect(page).toHaveURL(/\/$/)
    await devSignIn(page, 'grace')
    await page.goto('/settings')
    await expect(page.getByTestId('training-settings').getByRole('switch')).not.toBeChecked()
  })

  test('sign-out returns to guest play', async ({ page }) => {
    await devSignIn(page, 'linus')
    await page.getByTestId('user-menu').getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByTestId('user-menu')).toHaveCount(0)
    await page.goto(PLAY)
    await expect(page.getByTestId('four-setup')).toBeVisible()
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(page.getByTestId('four-board')).toBeVisible()
  })
})
