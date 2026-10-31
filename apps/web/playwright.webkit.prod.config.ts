import { defineConfig, devices } from '@playwright/test'
import base from './playwright.prod.config.ts'

/** The production-build specs (service worker, offline, stylesheet check) in real WebKit with the iPhone 15 profile. Not part of the default run. */
export default defineConfig({
  ...base,
  projects: [{ name: 'webkit-iphone', use: { ...devices['iPhone 15'] } }],
})
