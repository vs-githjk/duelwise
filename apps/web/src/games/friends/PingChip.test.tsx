import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PingChip } from './PingChip'

describe('PingChip', () => {
  test('shows nothing until a round trip is known, then the number, the word and the tone', () => {
    expect(renderToStaticMarkup(<PingChip rttMs={0} />)).toBe('')
    const good = renderToStaticMarkup(<PingChip rttMs={42.4} />)
    expect(good).toContain('data-tone="good"')
    expect(good).toContain('42 ms')
    expect(good).toContain('Good link, 42 milliseconds')
    expect(renderToStaticMarkup(<PingChip rttMs={90} />)).toContain('data-tone="warn"')
    const bad = renderToStaticMarkup(<PingChip rttMs={180} />)
    expect(bad).toContain('data-tone="bad"')
    expect(bad).toContain('Slow link')
  })
})
