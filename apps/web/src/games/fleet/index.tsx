import { PRODUCT } from '@duelwise/core/src/product'
import FleetView from '../../dev-views/fleet'

export const meta = { title: PRODUCT.games.fleet.displayName }

// A thin page until the sealed match hook lands (F9): it plays the dev view, unrated. Promoted on the branch only.
export default FleetView
