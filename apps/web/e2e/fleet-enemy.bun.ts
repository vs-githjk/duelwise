// Run by fleet.spec.ts through Bun (Node cannot load the agent's directory imports): prints the fleet Pip places for a fixed-seed match.
import { createGameAgent } from '@duelwise/agents/src/fleet/agent'
import { fleetCore } from '@duelwise/core/src/games/fleet'

const seed = Number(process.argv[2])
const agent = await createGameAgent('easy', { seat: 1 })
agent.reset(seed)
let state = fleetCore.init(seed)
for (let i = 0; i < 5; i++) {
  const [code] = await agent.act(fleetCore.observe(state, 1), state)
  state = fleetCore.step(state, [{ kind: 'place', cell: i * 10, vertical: false }, fleetCore.decodeAction(code!)])
}
console.log(JSON.stringify(state.ships[1]))
