# Arena assets (Lane C, T35)

Everything is CC0 1.0 (public domain dedication, https://creativecommons.org/publicdomain/zero/1.0/). Crediting is not required; we credit anyway. Every pack keeps its licence text next to its files. Downloaded 2026-10-22. Total under `apps/web/public/assets/arena/`: about 15 MB (budget 20 MB).

## Poly Haven (https://polyhaven.com/license, CC0)

Files under `apps/web/public/assets/arena/polyhaven/<asset>/`, one `LICENSE.txt` each.

- `empty_warehouse_01` (1k HDR): https://polyhaven.com/a/empty_warehouse_01, image based lighting and reflections at low intensity; the visible background is a dark colour.
- `corrugated_iron_02` (1k diffuse, normal GL, roughness JPG): https://polyhaven.com/a/corrugated_iron_02, the walls.
- `metal_plate_02` (1k, same three maps): https://polyhaven.com/a/metal_plate_02, the cover boxes.
- `hangar_concrete_floor` (1k, same three maps): https://polyhaven.com/a/hangar_concrete_floor, the floor.
- `blue_metal_plate`, `rubberized_track`, `fabric_leather_02` (1k diffuse, normal GL, roughness, converted from the JPG to WebP at quality 85; the diffuse maps of `blue_metal_plate`, `rubberized_track` and `fabric_leather_02` are converted to greyscale with stretched contrast first, so the in-game tint sets the colour, and each LICENSE.txt says so): https://polyhaven.com/a/blue_metal_plate, https://polyhaven.com/a/rubberized_track, https://polyhaven.com/a/fabric_leather_02. The steel, the polymer furniture and the leather gloves of the rifles.
- `service_pistol` (1k glTF, bin and three textures): https://polyhaven.com/a/service_pistol, the sidearm (Dart) in your hands and in the opponent's hand. The file lays out spare parts side by side; the renderer keeps the assembled pistol (variant a with the loaded magazine) and drops the rest at load time.
- `bolt_action_rifle_7_62` (1k glTF, the 8k `.bin` of the file, six textures converted from JPG to WebP at quality 82 and the glTF rewritten to point at them): https://polyhaven.com/a/bolt_action_rifle_7_62, the Ridgeline in your hands and in the opponent's hand. The scope is not drawn so the sight picture stays clear; the file's own PBR wood and steel are used as they are.

- Set dressing props (JC2), each the 1k glTF with its `.bin`, textures resized to 512 px WebP (quality 82) and the glTF rewritten to point at them; a `LICENSE.txt` next to each. Placed by `apps/web/src/games/arena/render/props.ts`, mostly flush on collision faces; a prop sticks out at most the 16 unit hull half width, so it can cover a little of the open floor beside a face but never moves a surface the sim blocks:
  - `worn_metal_rack` (0.91 x 1.9 x 0.6 m): https://polyhaven.com/a/worn_metal_rack, shelving along the long walls, squashed to half depth.
  - `plastic_crate_01` (0.30 x 0.26 x 0.41 m): https://polyhaven.com/a/plastic_crate_01, one crate on every other cover box.
  - `barrel_03` (0.63 dia x 0.93 m): https://polyhaven.com/a/barrel_03, a barrel at a corner of each cover box and at the foot of the short pillars.
  - `rollershutter_door` (1.08 x 2.4 x 0.3 m; the spare graffiti variant is dropped): https://polyhaven.com/a/rollershutter_door, two doors on each end wall beside the warm light.
  - `mounted_fluorescent_lights` (one fixture, node `mounted_fluorescent_lights_a`, 0.91 m): https://polyhaven.com/a/mounted_fluorescent_lights, hung between the emissive strips in the two outer rows.
- The HDRI `empty_warehouse_01` lights the scene (image based lighting at 0.55) in addition to the strip and door point lights.

## Quaternius (https://quaternius.com, CC0)

Files under `apps/web/public/assets/arena/quaternius/`.

- Universal Base Characters (Standard), `superhero-male.glb`: the same trimmed file as the fighter (textures resized to 1024 px WebP). The costume is painted into a copy of the base colour texture at load time, by UV triangle and bone, in dark tactical colours.
- Universal Animation Library 1 (Pro tier, purchased under R23), `ual1-shooter.glb`: not in this repository. It is hosted separately and loaded at run time (see `quaternius-paid.md`); without it the opponent uses the free clips from the fighter pack. Licence CC0 (`License.txt` in the purchased pack).
- Used by: `apps/web/src/games/arena/render/opponent.ts`.

## OpenGameArt (CC0)

- "Low poly fps rifle and hands", `oga-rifle/rifle.glb` (the glTF binary from the 162 KB zip, 57 KB; Blend, FBX and OBJ not shipped): https://opengameart.org/content/low-poly-fps-rifle-and-hands, licence field CC0 (https://creativecommons.org/publicdomain/zero/1.0/), downloaded 2026-10-22. The Ridgeline (full size) and the Carbine (the same model at 83 percent size) in your hands, with the file's gloved hands and its shoot clip, and in the opponent's hands (hands hidden, the character's own are used). The file's three plain materials are replaced at load time by the Poly Haven sets above. T35c: the gloves use `fabric_leather_02` as a mid tone PBR fabric (roughness 0.7, normal detail from the CC0 set, no roughness map), the pistol's capsule hands use the same material, and a dark cuff band made in code (no asset) edges each glove at the wrist. Used by `apps/web/src/games/arena/render/viewmodel.ts`.

## Made in code, no asset

- The two rifles' muzzle devices (a long thin suppressor for the Ridgeline, a short wide vented compensator for the Carbine; `viewmodel.ts`), the strip lights, the warm door lights, tracers, bullet decals, sparks and the muzzle flash (`map-mesh.ts`, `tracers.ts`, `viewmodel.ts`).
- All sound: shots, steps, reloads, hit ticks and landings are synthesised with the Web Audio API in `audio3d.ts` (filtered noise bursts and short tones), so no sound file is shipped.

## Not used

- Kenney Blaster Kit, Prototype Kit and Impact Sounds named in the design notes: not needed (guns are the Poly Haven pistol and the OpenGameArt rifle, sound is synthesised).
- Pichuliru flat guns: the author's itch page says CC0 in the text and CC BY 4.0 in the licence field (plan/research-assets.md). Left out until the author answers.
- Mixamo and any extracted game asset: banned.
