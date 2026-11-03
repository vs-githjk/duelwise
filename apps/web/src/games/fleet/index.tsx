import { PRODUCT } from '@duelwise/core/src/product'
import FleetPage from './FleetPage'

export const meta = { title: PRODUCT.games.fleet.displayName }

// The play page: a counted match runs against the server (the enemy fleet stays there until the end); ?seed makes an unrated one.
export default FleetPage
