import { expect, test } from 'bun:test'
import { isInAppBrowser } from './in-app-browser'

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const CHROME = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'

test('the LinkedIn, Facebook and Instagram app browsers are recognised', () => {
  expect(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.31.1')).toBe(true)
  expect(isInAppBrowser('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/480.0]')).toBe(true)
  expect(isInAppBrowser('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 Instagram 350.0')).toBe(true)
})

test('Safari, Chrome and an empty agent are left alone', () => {
  expect(isInAppBrowser(SAFARI)).toBe(false)
  expect(isInAppBrowser(CHROME)).toBe(false)
  expect(isInAppBrowser('')).toBe(false)
})
