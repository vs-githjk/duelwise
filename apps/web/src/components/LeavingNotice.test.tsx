import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LeavingNotice } from './LeavingNotice'

test('says that leaving a counted match resigns it', () => {
  const html = renderToStaticMarkup(<LeavingNotice />)
  expect(html).toContain('data-testid="leaving-notice"')
  expect(html).toContain('Leaving this page resigns a counted match.')
})
