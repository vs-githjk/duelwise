import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { initWasm, Resvg } from '@resvg/resvg-wasm'

const wasm = await readFile(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm'))
await initWasm(wasm)
// The mark stays inside the central 80 percent for maskable icons.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#fff6ef"/><circle cx="256" cy="256" r="180" fill="#2b6fe6"/><path d="M190 147h68c74 0 115 42 115 109s-41 109-115 109h-68zm53 48v122h15c39 0 61-22 61-61s-22-61-61-61z" fill="#fff6ef"/></svg>`
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180]] as const) {
  const image = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
  try { await writeFile(new URL(`../public/icons/${name}`, import.meta.url), image.render().asPng()) } finally { image.free() }
}
