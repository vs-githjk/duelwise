import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { buildCss, loadDefaults, mergeTokens, resolveInputPath } from './tokens-to-css'

const defaults = loadDefaults()

/** Every `--name: value;` declaration inside the first block that starts with `header`. */
function block(css: string, header: string): Record<string, string> {
  const start = css.indexOf(header)
  if (start < 0) throw new Error(`no block ${header}`)
  const open = css.indexOf('{', start)
  let depth = 0
  let end = open
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) { end = i; break }
  }
  return Object.fromEntries([...css.slice(open + 1, end).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}

test('the default file produces the expected light variables', () => {
  const css = buildCss({})
  const light = block(css, ':root {')
  expect(light.canvas).toBe('#fff3e8')
  expect(light.action).toBe('#2166f0')
  expect(light['radius-card']).toBe('16px')
  expect(light['game-chess']).toBe('#2f5ff0')
})

test('only the light Sunroom set is emitted: no dark query and no dark theme block', () => {
  const css = buildCss({})
  expect(css).not.toContain('prefers-color-scheme')
  expect(css).not.toContain('data-theme')
  expect(css).not.toContain('color-scheme: dark')
  expect(css).not.toContain('#1a1512')
})

test('scales and stage tokens are emitted once, theme independent', () => {
  const css = buildCss({})
  expect(css).toContain('--space-4: 16px;')
  expect(css).toContain('--duration-base: 200ms;')
  expect(css).toContain('--hud-you: #f2c94c;')
  const light = block(css, ':root {')
  expect(light['hud-you']).toBeUndefined()
  expect(light['space-4']).toBeUndefined()
})

test('the Tailwind theme block maps every colour and scale token', () => {
  const css = buildCss({})
  const theme = block(css, '@theme inline')
  expect(theme['color-canvas']).toBe('var(--canvas)')
  expect(theme['color-level-4']).toBe('var(--level-4)')
  expect(theme['text-display-xl']).toBe('var(--font-size-display-xl)')
  expect(theme['container-content']).toBe('var(--content-max)')
  expect(theme['font-display']).toContain('Fraunces')
  expect(theme['color-radius-card']).toBeUndefined()
  expect(theme['color-shadow-card']).toBeUndefined()
})

test('a partial token file overrides only what it names; missing keys fall back to the defaults', () => {
  const css = buildCss({ light: { 'canvas and surfaces': { canvas: '#ffffff' } }, dark: { canvas: '#000000' } })
  const light = block(css, ':root {')
  expect(light.canvas).toBe('#ffffff')
  expect(light.surface).toBe('#ffffff')
  expect(light.ink).toBe('#1f1a17')
  expect(css).not.toContain('#000000')
})

test('a token file may add a new token and it gets a Tailwind colour mapping when it is a colour', () => {
  const css = buildCss({ light: { extra: { 'accent-2': '#123456', 'ring-width': '3px' } } })
  expect(block(css, ':root {')['accent-2']).toBe('#123456')
  const theme = block(css, '@theme inline')
  expect(theme['color-accent-2']).toBe('var(--accent-2)')
  expect(theme['color-ring-width']).toBeUndefined()
})

test('unsafe or malformed tokens are rejected', () => {
  expect(() => buildCss({ light: { g: { 'bad name': '#fff' } } })).toThrow(/token name/)
  expect(() => buildCss({ light: { g: { x: '#fff; } body { display: none' } } })).toThrow(/value/)
  expect(() => buildCss({ dark: { x: 5 } })).toThrow(/value/)
  expect(() => mergeTokens(defaults, 'nope')).toThrow(/object/)
})

test('output is deterministic', () => {
  expect(buildCss({})).toBe(buildCss({}))
})

test('the committed tokens.css is what `bun run design:tokens` writes', () => {
  const root = new URL('../../', import.meta.url).pathname
  const input = resolveInputPath(root)
  const overrides = input.endsWith('tokens.default.json') ? {} : JSON.parse(readFileSync(input, 'utf8'))
  expect(existsSync(input)).toBe(true)
  expect(readFileSync(`${root}apps/web/src/styles/tokens.css`, 'utf8')).toBe(buildCss(overrides))
})
