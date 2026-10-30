# Duelwise logo directions (Oct 30 2026, design-only)

Three hand-built vector directions for the app icon, the Google OAuth logo and the favicon. Nothing here is wired into `apps/web/public/icons` yet; Vidyut picks first.

Comparison artifact (private): see the designer report for the claude.ai link.

## Files

| Direction | Files | Idea |
|---|---|---|
| A, Face-off | `a-faceoff-icon.svg`, `a-faceoff-maskable.svg`, `a-faceoff-mark.svg` | Player cursor (peach side) faces an agent eye (blue side) across one cream slash. The split tile is the mark. |
| B, Side-eye D | `b-sideeye-d-icon.svg`, `b-sideeye-d-maskable.svg`, `b-sideeye-d-mark.svg` | Blue D whose counter is a half-lidded eye looking at you, smirk under it, on peach. |
| C, The Climb | `c-climb-icon.svg`, `c-climb-maskable.svg`, `c-climb-mark.svg` | Pip, Marlow, Vesper, Sable as stepping tiles in their persona tints, each bigger than the last, on blue. |
| **C1, Climb to the D** (refine, Vidyut's mix) | `c1-climb-to-d-icon.svg`, `c1-climb-to-d-maskable.svg`, `c1-climb-to-d-mark.svg` | Pip, Marlow, Vesper tiles rising; the last stop is the Side-eye D. On peach. |
| C2, Climb inside the D (round 2) | `c2-climb-in-d-icon.svg`, `c2-climb-in-d-maskable.svg`, `c2-climb-in-d-mark.svg` | One big D with the side-eye; three tiles climb inside the bowl toward the eye. On peach. |
| X1, Two Ds (round 3) | `x1-two-ds-icon.svg`, `x1-two-ds-maskable.svg`, `x1-two-ds-mark.svg` | Two square-tile climbs (Pip, Marlow, Vesper shared, Sable) cross and rise to the top corners: blue Side-eye D top right, red mirrored D with angry brow top left. On peach. |
| **X1 final** (picked, final round) | `x1-final-icon.svg`, `x1-final-maskable.svg`, `x1-final-mark.svg` | X1 on a cream ground with an ink outline on every shape; agent's climb mint, sky, blue; challenger's climb peach, orange, coral; gold crossing. Seven tiles. Ship this. |
| X1 final lite (alternative) | `x1-final-lite-icon.svg`, `x1-final-lite-maskable.svg`, `x1-final-lite-mark.svg` | Same with five bigger tiles; weaker X at 16. |
| X2, Q and D (round 3) | `x2-q-and-d-icon.svg`, `x2-q-and-d-maskable.svg`, `x2-q-and-d-mark.svg` | Same crossed climbs; the red head is a Q whose counter is an eye, short typographic tail. On peach. |

- `-icon.svg`: square app icon with background, 512 viewBox, 112 radius corners.
- `-maskable.svg`: full-bleed square, art kept inside the 80 percent safe circle (PWA maskable).
- `-mark.svg`: mark only on a transparent ground (favicon, OAuth 120 on its own ground).
- `build.py`: generates all nine files. Edit the Python, not the SVGs, then run `python3 build.py`.

## Palette

Sunroom tokens from `plan/design/final/spec.md` section 2: cream `#fff6ef`, peach `#ffb088`, action blue `#2b6fe6`, ink `#1f1a17`. Persona tints from `apps/web/public/personas/*.svg`: Pip `#e8c877`, Marlow `#8fb0d0`, Vesper `#a98ac4`, Sable `#c9a34d` on `#2a2724`.

No fonts, no external assets, no third-party artwork. All original vector, no license to track.

## PNG exports (rounds 2 and 3, Oct 30 2026)

`export/x1-final/` (the pick; also has `favicon.ico` with 16 and 32 as PNG-in-ICO), plus earlier rounds `export/x1-two-ds/`, `export/x2-q-and-d/`, `export/c1-climb-to-d/`, `export/c2-climb-in-d/`, each: `icon-512.png`, `icon-maskable-512.png`, `icon-192.png`, `apple-touch-icon.png` (180), `google-logo-120.png`, `favicon-32.png`, `favicon-16.png`. Rendered from the SVGs with headless Chromium (Playwright); rounded-corner icons have transparent corners, the maskable file is full-bleed. The icon carries its own background, so the same files serve light and dark home screens.

Status: design-only. Nothing is wired into `apps/web/public/icons` or `~/Desktop/duelwise-google/` until Vidyut confirms the X1 final; the conductor swaps the files in. Red in the X marks is the Sunroom `--bad` token `#c9452f`, the red Tinderbox already uses.
