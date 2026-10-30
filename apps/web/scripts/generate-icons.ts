import { copyFile } from 'node:fs/promises'

// The app icons come from the X1 logo, designed in design/logo (build.py writes the SVGs and the export).
// Run `python3 design/logo/build.py` after changing the mark, then this script to copy the PNGs in.
const from = (name: string) => new URL(`../../../design/logo/export/x1-final/${name}`, import.meta.url)
const to = (path: string) => new URL(`../public/${path}`, import.meta.url)
for (const name of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'favicon-32.png'] as const) {
  await copyFile(from(name), to(`icons/${name}`))
}
await copyFile(from('favicon.ico'), to('favicon.ico'))
