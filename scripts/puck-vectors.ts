// Cross-engine determinism vectors for the air hockey sim.
//   Regenerate (Bun, the only engine that writes):  bun /abs/path/scripts/puck-vectors.ts --write
//   Check on this engine:                           bun /abs/path/scripts/puck-vectors.ts
//   Check under Node (Node cannot load extensionless TS imports, so bundle first):
//     bun build /abs/path/scripts/puck-vectors.ts --target=node --outfile=/abs/tmp/puck-vectors.mjs && node /abs/tmp/puck-vectors.mjs --file /abs/packages/core/src/games/puck/vectors.json
// The browser engines run the same checkFile from apps/web/src/dev-views/puck-vectors.tsx (/dev/puck-vectors).
import { readFileSync, writeFileSync } from 'node:fs'
import { buildFile, checkFile, type VectorFile } from '../packages/core/src/games/puck/vectors-lib'

const here = new URL('.', import.meta.url).pathname
// A bundled copy cannot find the repo from import.meta.url, so the Node check passes the absolute path: --file /abs/vectors.json
const fileArg = process.argv.indexOf('--file')
const file = fileArg >= 0 ? process.argv[fileArg + 1]! : here + '../packages/core/src/games/puck/vectors.json'
const engine = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? 'bun ' + (globalThis as { Bun?: { version: string } }).Bun!.version : 'node ' + process.version

if (process.argv.includes('--write')) {
  const out = buildFile()
  writeFileSync(file, JSON.stringify(out) + '\n')
  console.log(`wrote ${out.count} vectors to ${file} (${engine})`)
} else {
  const want = JSON.parse(readFileSync(file, 'utf8')) as VectorFile
  const t0 = Date.now()
  const bad = checkFile(want)
  console.log(`${engine}: ${want.count - new Set(bad.map((b) => b.id)).size}/${want.count} vectors match in ${Date.now() - t0} ms`)
  for (const b of bad.slice(0, 10)) console.log('MISMATCH', JSON.stringify(b))
  process.exit(bad.length === 0 ? 0 : 1)
}
