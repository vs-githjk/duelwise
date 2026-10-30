import { expect, test } from '@playwright/test'

/**
 * Security headers on the production build (run with `bun run e2e:prod`): vite.config.ts sets them for every
 * route in nitro routeRules, and only a built server proves they reach the wire, for a page, an API route and a static file.
 */
const EXPECTED = {
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
}

for (const path of ['/', '/privacy', '/leaderboard/chess', '/_resvg/index_bg.wasm', '/fonts/young-serif-regular.ttf']) {
  test(`${path} sends the security headers`, async ({ request }) => {
    const res = await request.get(path)
    expect(res.status(), path).toBe(200)
    for (const [name, value] of Object.entries(EXPECTED)) expect(res.headers()[name], `${path} ${name}`).toBe(value)
  })
}

test('a model file keeps its long cache header next to the security headers', async ({ request }) => {
  const res = await request.get('/agents/chess/v1/policy-b1100.onnx')
  expect(res.status()).toBe(200)
  expect(res.headers()['cache-control']).toContain('max-age=604800')
  expect(res.headers()['x-frame-options']).toBe('DENY')
})

test('/_resvg serves the wasm and nothing else from the package', async ({ request }) => {
  expect((await request.get('/_resvg/index_bg.wasm')).status()).toBe(200)
  for (const f of ['package.json', 'index.js', 'index.d.ts', 'README.md']) expect((await request.get(`/_resvg/${f}`)).status(), f).toBe(404)
})
