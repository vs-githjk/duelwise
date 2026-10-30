import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { initWasm, Resvg } from '@resvg/resvg-wasm'

// The link-preview image (Open Graph, 1200x630): public/og/duelwise-og.png.
// Run: bun apps/web/scripts/generate-og.ts   (or tsx). Uses the X1 mark, the four persona portraits and Young Serif.
const root = (p: string) => new URL(`../../../${p}`, import.meta.url)
const pub = (p: string) => new URL(`../public/${p}`, import.meta.url)

const mark = await readFile(root('design/logo/x1-final-mark.svg'), 'utf8')
const inner = mark.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
const font = new Uint8Array(await readFile(pub('fonts/young-serif-regular.ttf')))
const uri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
const personas = await Promise.all(['pip', 'marlow', 'vesper', 'sable'].map((n) => readFile(pub(`personas/${n}.svg`), "utf8").then((s) => s.replace(/var\(--[\w-]+,\s*([^)]+)\)/g, "$1"))))

const AV = 104
const GAP = 22
const avatars = personas
  .map((svg, i) => `<image x="${530 + i * (AV + GAP)}" y="392" width="${AV}" height="${AV}" href="${uri(svg)}"/>`)
  .join('')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#fff3e8"/>
<rect x="0" y="0" width="1200" height="630" fill="#ffdcc4" opacity="0.35"/>
<circle cx="250" cy="315" r="250" fill="#ffffff" opacity="0.7"/>
<g transform="translate(40 65) scale(0.98)">${inner}</g>
<text x="530" y="212" font-family="Young Serif" font-size="96" fill="#1f1a17">Can you beat</text>
<text x="530" y="322" font-family="Young Serif" font-size="96" fill="#2166f0">my agents?</text>
<text x="530" y="378" font-family="Young Serif" font-size="28" fill="#6b5f57">Six games. AI opponents. No account needed.</text>
${avatars}
<text x="530" y="578" font-family="Young Serif" font-size="38" fill="#a63f0c">duelwise.app</text>
</svg>`

const wasm = createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm')
await initWasm(await readFile(wasm))
const png = new Resvg(svg, { font: { fontBuffers: [font], loadSystemFonts: false, defaultFontFamily: 'Young Serif' } }).render().asPng()
await mkdir(pub('og/'), { recursive: true })
await writeFile(pub('og/duelwise-og.png'), png)
console.log(`wrote og/duelwise-og.png (${png.length} bytes)`)
