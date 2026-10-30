# Fonts (Lane B, JB2)

All three faces are licensed under the SIL Open Font License 1.1, self-hosted from `apps/web/public/fonts/` (no request leaves the site), with the licence text saved beside the files.

| Face | File | Source | Licence file |
|---|---|---|---|
| Geist (variable, weights 100 to 900, Latin) | `geist-latin.woff2` | @fontsource-variable/geist 5.3.0 (https://github.com/vercel/geist-font), file copied from an existing local install; nothing was installed | `OFL-Geist.txt` |
| Geist Mono (variable, weights 400 to 500, Latin) | `geist-mono-latin.woff2` | Geist Mono from the same Geist Project, the Latin subset copied from Vidyut's portfolio site | `OFL-Geist.txt` |
| Fraunces (variable, weights 100 to 900, roman and italic, Latin) | `fraunces-latin.woff2`, `fraunces-italic-latin.woff2` | https://github.com/undercasetype/Fraunces, the Google Fonts v38 Latin files; licence in `OFL-Fraunces.txt` | `OFL-Fraunces.txt` |
| Young Serif (Regular, 400), server report card PNG only | `young-serif-regular.ttf` | https://github.com/noirblancrouge/YoungSerif, the TTF shipped in the Claude skills font folder | `OFL-YoungSerif.txt` |

Lining numerals are set once on `body` (`font-variant-numeric: lining-nums`), and the `.tabular` class adds tabular-nums on top of it.
