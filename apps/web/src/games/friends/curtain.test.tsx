import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { ARM_MS, Curtain, CurtainGate, gateShows } from './Curtain'

const SECRET = 'SECRET-VIEW-MARKER'

describe('the hand-over curtain', () => {
  test('a view is shown only for the token that was revealed', () => {
    expect(gateShows(null, 'a')).toBe(false)
    expect(gateShows('a', 'a')).toBe(true)
    // A new turn is a new token, so the curtain is back before the first frame of it.
    expect(gateShows('a', 'b')).toBe(false)
  })

  test('between seats the next view is not built, not just hidden, until the tap', () => {
    const view = mock(() => <p>{SECRET}</p>)
    // A first render (a reload mid-curtain is a first render) has revealed nothing.
    const html = renderToStaticMarkup(
      <CurtainGate token="1.t4" to="Sam" detail="Shot 5">
        {view}
      </CurtainGate>,
    )
    expect(view).not.toHaveBeenCalled()
    expect(html).not.toContain(SECRET)
    expect(html).not.toContain('data-secret-view')
    expect(html).toContain('Pass to Sam')
    expect(html).toContain('Tap to reveal')
    expect(html).toContain('data-testid="curtain"')
  })

  test('after the reveal the view is in the page, marked with its turn', () => {
    const html = renderToStaticMarkup(
      <CurtainGate token="1.t4" to="Sam" gate={{ shown: true, reveal: () => {} }}>
        {() => <p>{SECRET}</p>}
      </CurtainGate>,
    )
    expect(html).toContain(SECRET)
    expect(html).toContain('data-secret-view="1.t4"')
    expect(html).not.toContain('data-testid="curtain"')
  })

  test('a fresh curtain ignores taps for a moment, so a double tap cannot reveal the next seat to the person passing', () => {
    const fresh = renderToStaticMarkup(<Curtain to="Sam" onReveal={() => {}} />)
    expect(fresh).toContain('data-armed="false"')
    expect(fresh).toContain('aria-disabled="true"')
    expect(ARM_MS).toBeGreaterThanOrEqual(300)
    expect(renderToStaticMarkup(<Curtain to="Sam" armMs={0} onReveal={() => {}} />)).toContain('data-armed="true"')
  })

  test('the curtain names the person and carries no game state', () => {
    const html = renderToStaticMarkup(<Curtain to="Zed" side="Keeper" detail="Round 2 of 5" swatch={{ background: 'red' }} onReveal={() => {}} />)
    expect(html).toContain('Pass to Zed')
    expect(html).toContain('Keeper, Round 2 of 5')
  })
})

describe('the hidden-information pages', () => {
  const pages = ['FriendPenalty.tsx', 'FriendFleet.tsx', 'FriendWord.tsx']
  const dir = new URL('.', import.meta.url).pathname

  test('draw from a seat view and never from the room state, its pending picks or its seed', () => {
    for (const f of pages) {
      const src = readFileSync(dir + f, 'utf8')
      expect(/room\.(state|pending|seed)\b|d\.room\.(state|pending|seed)\b/.test(src), `${f} reads the room's hidden parts`).toBe(false)
      expect(src.includes('localView('), `${f} must read through localView`).toBe(true)
      expect(src.includes('CurtainGate'), `${f} must sit behind the curtain`).toBe(true)
    }
  })

  test('only the curtain gate decides what is on screen between seats', () => {
    for (const f of pages) {
      const src = readFileSync(dir + f, 'utf8')
      // Every view is made inside the gate's render function: the gate's children is a function, never an element.
      expect(/<CurtainGate[\s\S]*?>\s*\{\(\) =>/.test(src), `${f} passes the view as a function`).toBe(true)
    }
  })
})
