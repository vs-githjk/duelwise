import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { initWasm, Resvg } from '@resvg/resvg-wasm'
import { shareCardSvg, CARD_WIDTH } from '../report/share-card'
import { getCardFacts } from './report'
import { getServerDb } from './server-db'

type FactsDb = Parameters<typeof getCardFacts>[0]

/** The SVG for a public report, or null when the report is missing, unfinished or private. */
export async function getCardSvg(id: string, link?: string): Promise<string | null> {
  const { db } = await getServerDb()
  const facts = await getCardFacts(db, id)
  if (!facts) return null
  return shareCardSvg({ ...facts, link: link ?? `report/${id}` })
}

// The PNG render. resvg reads TrueType and OpenType only, never woff2, so every face on the card is the
// self-hosted Young Serif TTF (public/fonts, OFL); the SVG's system font names are swapped for it.
const FONT_FILE = 'young-serif-regular.ttf'
const FONT_FAMILY = 'Young Serif'

let ready: Promise<Uint8Array> | null = null

/** Bytes from a file next to the source or the build, else from the site's own static files (a serverless bundle has no node_modules). */
async function readFirst(files: string[], fallbackUrl: () => Promise<string>): Promise<Uint8Array> {
  for (const p of files) if (existsSync(p)) return new Uint8Array(await readFile(p))
  const res = await fetch(await fallbackUrl())
  if (!res.ok) throw new Error(`share card asset missing: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

function loadRenderer(origin: string): Promise<Uint8Array> {
  ready ??= (async () => {
    const here = import.meta.dirname
    const wasmFile = (() => {
      try {
        return createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm')
      } catch {
        return ''
      }
    })()
    const font = readFirst(
      [join(here, '..', '..', 'public', 'fonts', FONT_FILE), join(process.cwd(), 'public', 'fonts', FONT_FILE), join(process.cwd(), '.output', 'public', 'fonts', FONT_FILE)],
      async () => `${origin}/fonts/${FONT_FILE}`,
    )
    // vite.config.ts serves the package folder at /_resvg for a bundle that has no node_modules.
    const wasm = readFirst(wasmFile ? [wasmFile] : [], async () => `${origin}/_resvg/index_bg.wasm`)
    const [f, w] = await Promise.all([font, wasm])
    await initWasm(w)
    return f
  })().catch((e) => {
    ready = null
    throw e
  })
  return ready
}

const FONT_OPTS = (font: Uint8Array) => ({ fontBuffers: [font], loadSystemFonts: false, defaultFontFamily: FONT_FAMILY })
const HEADLINE_PX = 76
const HEADLINE_MAX_WIDTH = 668 // from the left margin (72) to the portrait panel (760) with a little air

/** Width of one line of text in the card face, from resvg's own bounding box. */
function textWidth(text: string, px: number, font: Uint8Array): number {
  const probe = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="200"><text x="0" y="120" font-family="${FONT_FAMILY}" font-size="${px}">${text}</text></svg>`,
    { font: FONT_OPTS(font) },
  )
  try {
    return probe.getBBox()?.width ?? 0
  } finally {
    probe.free()
  }
}

/** Young Serif runs wider than the Georgia the SVG is drawn for: shrink the headline until its widest line clears the portrait. */
function fitHeadline(svg: string, font: Uint8Array): string {
  const m = svg.match(/<text x="72" y="(\d+)" font-family="[^"]*" font-size="76"([^>]*)>(<tspan[\s\S]*?)<\/text>/)
  if (!m) return svg
  const lines = [...m[3]!.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((t) => t[1]!)
  const widest = Math.max(...lines.map((l) => textWidth(l, HEADLINE_PX, font)))
  if (widest <= HEADLINE_MAX_WIDTH) return svg
  const scale = HEADLINE_MAX_WIDTH / widest
  const body = m[3]!.replace(/dy="84"/g, `dy="${Math.round(84 * scale)}"`)
  return svg.replace(m[0], `<text x="72" y="${m[1]}" font-family="${FONT_FAMILY}" font-size="${Math.floor(HEADLINE_PX * scale)}"${m[2]}>${body}</text>`)
}

/** Renders the card SVG to a PNG at its own size (1200 by 630). */
export async function renderCardPng(svg: string, origin = ''): Promise<Uint8Array> {
  const font = await loadRenderer(origin)
  // resvg has no CSS variables: take each portrait colour's fallback value.
  const flat = svg.replace(/font-family="[^"]*"/g, `font-family="${FONT_FAMILY}"`).replace(/var\(--[\w-]+,\s*([^)]+)\)/g, '$1')
  const resvg = new Resvg(fitHeadline(flat, font), { fitTo: { mode: 'width', value: CARD_WIDTH }, font: FONT_OPTS(font) })
  try {
    return resvg.render().asPng()
  } finally {
    resvg.free()
  }
}

// Cached by report id. The key also carries the facts and the link, so a card is never served for facts that
// changed, and the privacy check below runs on every request before the cache is looked at.
const CACHE_MAX = 200
const cache = new Map<string, { key: string; png: Uint8Array }>()

export function resetCardPngCache(): void {
  cache.clear()
}

/** The PNG for a public report, or null when the report is missing, unfinished or private (the route answers 404). */
export async function cardPngFor(db: FactsDb, id: string, link: string, origin = ''): Promise<Uint8Array | null> {
  const facts = await getCardFacts(db, id)
  if (!facts) {
    cache.delete(id)
    return null
  }
  const key = JSON.stringify([facts, link])
  const hit = cache.get(id)
  if (hit && hit.key === key) return hit.png
  const png = await renderCardPng(shareCardSvg({ ...facts, link }), origin)
  cache.delete(id)
  cache.set(id, { key, png })
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  return png
}

export async function getCardPng(id: string, link: string, origin: string): Promise<Uint8Array | null> {
  const { db } = await getServerDb()
  return cardPngFor(db as FactsDb, id, link, origin)
}
