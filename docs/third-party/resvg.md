# @resvg/resvg-wasm (Lane B, JB5)

Renders the share card SVG to a 1200 by 630 PNG for og:image and twitter:image (link previews do not draw SVG).

| | |
|---|---|
| Package | `@resvg/resvg-wasm` 2.6.2, pinned exactly in `apps/web/package.json` and `bun.lock` |
| Source | https://github.com/thx/resvg-js (wasm build of https://github.com/linebender/resvg) |
| Licence | MPL-2.0 (file-level copyleft). We use the published package unmodified, so there is nothing to publish back; the npm package does not include the licence text, so recipients can get it at https://www.mozilla.org/MPL/2.0/ and the source at https://github.com/linebender/resvg. |
| Approval | Vidyut, Oct 22 2026 (decisions.md) |
| Why wasm | runs on Vercel serverless with no native binary |
| Fonts | resvg reads TTF and OTF only, so the card's text is set in `apps/web/public/fonts/young-serif-regular.ttf` (OFL, see fonts.md) |
| Loading | wasm from `node_modules` when present, else from `/_resvg/index_bg.wasm` (static route set in `apps/web/vite.config.ts`) |
