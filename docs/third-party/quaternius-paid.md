# Quaternius paid animation clips (P2, Oct 23)

Decision: paid Quaternius clips stay out of the public repository and are hosted separately (plan/decisions.md, Oct 23 10:23). The pack licence is CC0, so this protects the purchase, not a legal need.

## Provenance check (clip names read from the GLB JSON chunk of each file)

| Tracked file (before P2) | Clips | In no Standard list | Standard per research-assets.md:48, not file-verified | Verdict |
| --- | --- | --- | --- | --- |
| `arena/quaternius/universal-animation-library/ual1-shooter.glb` | 24 | Crouch_Bwd_Loop, Crouch_Left_Loop, Crouch_Right_Loop, Death02, Hit_Stomach, Jog_Bwd_Loop, Jog_Left_Loop, Jog_Right_Loop | Jog_Fwd_Loop, Pistol_Aim_Neutral, Pistol_Idle_Loop, Pistol_Reload, Pistol_Shoot | Paid. Removed from git, hosted separately. |
| `fighter/quaternius/universal-animation-library-2/ual2-combat.glb` | 13 | none | none | Free. All 13 clips are in `UAL2_Standard.glb` (43 clips), compared file by file. Stays. |
| `fighter/quaternius/universal-animation-library/ual1-combat.glb` | 15 | none | none | Free. All 15 are in the Standard list. Stays. |

Limits of this check: the UAL1 Standard zip is not in the local cache (only the Pro zip is), so the UAL1 free list in `quaternius-free-clips.json` is the 15 clip names of ual1-combat.glb, each confirmed in the Standard list at plan/research-assets.md:48, not read from the Standard file. That Standard list also names Pistol_Shoot, Pistol_Reload, Pistol_Idle, Pistol_Aim_Neutral and Jog_Fwd; they are kept off the guard list (conservative), so a free pistol overlay may exist in the Standard download. Not yet verified against the UAL1 Standard download. The guard treats any clip outside that list as paid, so a clip is never wrongly allowed, but a free clip missing from the list would be flagged. Adding a free clip means checking it against the Standard download and adding its name to the JSON.

## How it is enforced

- `scripts/paid-assets.test.ts` fails if any tracked Quaternius animation `.glb` holds a clip outside `quaternius-free-clips.json`, if a paid path or `apps/web/public/paid/` is tracked, or if `.gitignore` lacks `apps/web/public/paid/`.
- The paid file path list lives in `scripts/paid-assets-lib.ts`; `bun scripts/paid-assets.ts` copies the files from `data/cache/assets/quaternius-paid` into `apps/web/public/paid/` and prints the Blob upload commands. The pruned file is stored at `data/cache/assets/quaternius-paid/pruned/ual1-shooter.glb`.
- Loading: `apps/web/src/lib/paid-assets.ts` (`VITE_PAID_ASSETS_URL`, else `/paid`); the arena opponent falls back to the free clips on any failed fetch.
- The public repository is pushed as a fresh history from a snapshot that never contained the paid files (conductor step).
