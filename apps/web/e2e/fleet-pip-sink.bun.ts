// Run by near-miss-b2.spec.ts through Bun (Node cannot load the agent's directory imports): prints the shot on which Pip (Easy) sinks the fleet the
// page makes when Math.random returns 0.5, in a fixed-seed match where the player only ever shoots Pip's water. It replays the same agent and seed the
// page uses, so the spec follows the agent's settings instead of a number found once.
import { createGameAgent } from '@duelwise/agents/src/fleet/agent'
import { randomFleet } from '@duelwise/agents/src/fleet/placer'
import { fleetCore, shipCells } from '@duelwise/core/src/games/fleet'
import { makeRng } from '@duelwise/core/src/rng'
import { AGENT_SEAT, applyShot, isOver, startMatch, whoseTurn } from '../src/games/fleet/fleet-match'

const seed = Number(process.argv[2])
const agent = await createGameAgent('easy', { seat: AGENT_SEAT })
agent.reset(seed)
const human = randomFleet(makeRng((0.5 * 2 ** 32) >>> 0))
let m = await startMatch(human, agent)
const ships = new Set(m.state.ships[1].flatMap(shipCells))
const water = Array.from({ length: 100 }, (_, c) => c).filter((c) => !ships.has(c))
let shots = 0
for (let w = 0; !isOver(m); ) {
  if (whoseTurn(m) === 'you') {
    if (w >= water.length) throw new Error(`seed ${seed}: Pip needs more shots than the water holds`)
    m = applyShot(m, 0, water[w++]!)
  } else {
    const [code] = await agent.act(fleetCore.observe(m.state, AGENT_SEAT), m.state)
    m = applyShot(m, AGENT_SEAT, (fleetCore.decodeAction(code!) as { cell: number }).cell)
    shots++
  }
}
console.log(JSON.stringify({ shots }))
