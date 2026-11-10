// Makes the puck preview model and its parity fixture without the `onnx` Python package:
//   bun packages/agents/fixtures/puck-fixture.ts obs <out obs.json>                 real env observations (both seats, all levels)
//   scripts/py packages/agents/fixtures/puck-dump-weights.py --ckpt <snap.pt> --out w.json --obs obs.json --logits l.json
//   bun packages/agents/fixtures/puck-fixture.ts onnx <w.json> <out.onnx>
//   bun packages/agents/fixtures/puck-fixture.ts parity <obs.json> <l.json> <source name> <out parity.json>
import { makeRng } from '@duelwise/core/src/rng'
import { createEnv, OBS_FEATURES, BIN_X, BIN_Y, type PuckEnv } from '@duelwise/core/src/games/puck/env'
import type { Level } from '@duelwise/core/src/product'
import { buildPolicyOnnx, weightsFromJson } from './make-policy'

function collectObs(): number[][] {
  const rows: number[][] = []
  const rng = makeRng(2026)
  for (const level of ['easy', 'medium', 'hard', 'champion'] as Level[]) {
    const env = createEnv!({ n: 1, seed: 11, level } as never) as PuckEnv
    let obs = env.reset([11 + rows.length])
    for (let d = 0; d < 900; d++) {
      if (d % 30 === 7 && rows.length < 400) for (const k of [0, 1]) rows.push(Array.from(obs.slice(k * OBS_FEATURES, (k + 1) * OBS_FEATURES)))
      const act = new Int32Array([rng.int(BIN_X), rng.int(BIN_Y), rng.int(BIN_X), rng.int(BIN_Y)])
      obs = env.step(act).obs
    }
  }
  return rows.filter((_, i) => i % 6 === 0).slice(0, 96)
}

const [cmd, a, b, c, d] = process.argv.slice(2)
if (cmd === 'obs') {
  await Bun.write(a!, JSON.stringify({ features: OBS_FEATURES, obs: collectObs() }))
} else if (cmd === 'onnx') {
  await Bun.write(b!, buildPolicyOnnx(weightsFromJson(JSON.parse(await Bun.file(a!).text()))))
} else if (cmd === 'parity') {
  const obs = JSON.parse(await Bun.file(a!).text())
  const logits = JSON.parse(await Bun.file(b!).text())
  await Bun.write(d!, JSON.stringify({ source: c, features: obs.features, obs: obs.obs, logits: logits.logits }))
} else {
  throw new Error('usage: obs | onnx | parity')
}
