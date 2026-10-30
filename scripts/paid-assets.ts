/**
 * Paid Quaternius clips are not tracked in git (decision Oct 23). This copies them from the purchased-pack
 * cache into the gitignored local folder the dev server serves, and prints the Vercel Blob upload commands.
 *
 *   bun scripts/paid-assets.ts [cache-dir]   (a git worktree has no data/cache: pass the main checkout path)
 *
 * cache-dir defaults to <repo>/data/cache/assets/quaternius-paid.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { PAID_FILES, PAID_LOCAL_DIR } from './paid-assets-lib'

const root = resolve(import.meta.dir, '..')
const src = resolve(process.argv[2] ?? join(root, 'data/cache/assets/quaternius-paid'))
const dest = join(root, PAID_LOCAL_DIR)

let missing = 0
for (const f of PAID_FILES) {
  const from = join(src, f.source)
  const to = join(dest, f.path)
  if (!existsSync(from)) {
    console.error(`missing: ${from}`)
    missing++
    continue
  }
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  console.log(`copied ${f.path}`)
}
if (missing) process.exit(1)

console.log('\nDeploy: create a public Blob store, then from the repo root run (one per file, keeps the path):')
for (const f of PAID_FILES) console.log(`  vercel blob put ${join(PAID_LOCAL_DIR, f.path)} --pathname ${f.path} --add-random-suffix false`)
console.log('\nThen set VITE_PAID_ASSETS_URL to the store base URL (https://<id>.public.blob.vercel-storage.com, no trailing slash) for Production and redeploy.')
