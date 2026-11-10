import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeRng } from '@duelwise/core/src/rng'
import { randomFleet } from '@duelwise/agents/src/fleet/placer'
import { FleetPlacer } from './FleetPlacer'

const place = (initial?: ReturnType<typeof randomFleet>) => renderToStaticMarkup(<FleetPlacer name="Alex" last={false} onReady={() => {}} initial={initial} />)

describe('the Stormglass placer keeps a draft across a curtain', () => {
  test('a placer given a draft shows exactly that fleet, not a fresh shuffle', () => {
    const draft = randomFleet(makeRng(7))
    const other = randomFleet(makeRng(8))
    expect(place(draft)).toBe(place(draft))
    expect(place(draft)).not.toBe(place(other))
    // With no draft the placer shuffles its own, so two mounts differ: the draft is what pins the fleet.
    expect(place()).not.toBe(place())
  })
})
