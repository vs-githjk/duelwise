import FleetPage from '../games/fleet/FleetPage'

// /dev/fleet: the same page, always unrated and on its own core, so the e2e specs and screenshots need no server match.
export default function FleetDev() {
  return <FleetPage forceUnrated />
}
