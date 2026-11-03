import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { GameTile } from './GameTile'

describe('Crosscurrent tile art', () => {
  const html = renderToStaticMarkup(<GameTile game="slack" />)

  test('draws only whole discs and rings: no ellipse, so no disc is caught mid-flip', () => {
    expect(html).not.toContain('<ellipse')
    const radii = [...html.matchAll(/<circle[^>]* r="([\d.]+)"/g)].map((m) => m[1])
    expect(radii.length).toBeGreaterThan(10)
    expect(new Set(radii)).toEqual(new Set(['7.6', '3.2']))
  })

  test('shows both colours of disc and the legal rings', () => {
    expect(html).toContain('data-disc="pale"')
    expect(html).toContain('data-disc="dark"')
    expect(html).toContain('stroke="var(--slack-pale)"')
  })

  test('fills the tile on every side: the water is the whole ground and no pale band rect remains', () => {
    expect(html).toContain('<rect width="160" height="90" fill="var(--slack-water)"')
    expect(html).not.toContain('#d6ebe7')
  })
})
