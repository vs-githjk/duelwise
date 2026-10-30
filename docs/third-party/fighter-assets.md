# Fighter assets (Lane C, T33)

All assets are CC0 1.0 (public domain dedication, https://creativecommons.org/publicdomain/zero/1.0/). Crediting is not required; we credit anyway. Every pack keeps its licence text next to its files. Downloaded 2026-10-21. Total under `apps/web/public/assets/fighter/`: about 6 MB (budget 15 MB).

## Quaternius, Universal Base Characters (Standard) and Universal Animation Library 1 and 2 (Standard)

- Source: https://quaternius.com/packs/universalbasecharacters.html, https://quaternius.com/packs/universalanimationlibrary.html and https://quaternius.com/packs/universalanimationlibrary2.html (free Standard downloads from https://quaternius.itch.io/).
- Files kept, under `apps/web/public/assets/fighter/quaternius/`:
  - `universal-base-characters/superhero-male.glb` and `superhero-female.glb`: the two Superhero full-body rigs, textures resized to 1024 px and re-encoded as WebP with gltf-transform (build step, not shipped).
  - `universal-animation-library/ual1-combat.glb` and `universal-animation-library-2/ual2-combat.glb`: only the 28 clips the move map uses (idle, walk, crouch, jump, sprint, roll, hit reactions, punches, hook, shield dash, throw, spell shoot, slide, heavy sword combo, block), finger tracks and scale tracks removed, resampled. The mannequin meshes are dropped.
- Changes: the costume colour of each fighter is recoloured at load time in code (near-black pixels of the base colour texture). No other edits.
- Used by: `apps/web/src/games/fighter/render/characters.ts` and `animation-map.ts`.

## Poly Haven

- `rusty_painted_metal` (1k diffuse, normal GL, roughness JPG): https://polyhaven.com/a/rusty_painted_metal, back wall.
- `unfinished_office_night` (1k HDR): https://polyhaven.com/a/unfinished_office_night, image based lighting at low intensity (the visible background is a dark colour).
- Licence: CC0, https://polyhaven.com/license.

## ambientCG

- `Concrete034` (1K-JPG colour, normal GL, roughness): https://ambientcg.com/a/Concrete034, floor.
- Licence: CC0, https://docs.ambientcg.com/license/.

## Not used

The design notes (plan/design/v2) also name Kenney Factory Kit and City Kit (Industrial). They are not used in T33: the gantry, fence, furnace mouth and floor seams are drawn in code from boxes and a canvas texture, which keeps the scene small. Nothing from Mixamo or any extracted game asset is used.
