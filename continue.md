# Continue here

Paused on 2026-10-21 at the user's request ("too much running"). Everything background is stopped.
This file is the handoff: what is live, what is half-done, and the exact next steps.

## Where things stand

**Live (pushed, `origin/main` = `4f74171`):** the 3D avatar round.

- The avatar is a skinned mesh (chest, neck, head bones) built from `tools/reference2.webp` by
  `tools/build_avatar.py`. It breathes, sways and glances; its skin is shaded like the painting.
- His fire is a GPU fluid simulation (`src/fire/`), emitted from the scalp, colliding with the
  head, pushed by the cursor, volume-rendered against the avatar's depth, lighting his skin.
- The lava backdrop is unchanged (the user: "the lava is perfectly fine, leave that").
- The fox is parked (`?fox` shows it): reference2 puts the fire plume where it sat.
- Architecture and tuning: see `README.md`.

**Uncommitted in the working tree (small, tested, safe to commit):**

- `src/signals.js`: glances now pick one of three looks (to the viewer, half way and slightly
  down, up into the fire). Simulated 120 s in node: 12 glances, max turn 1.0, max pitch 0.15.
- `.gitignore`: ignores `tools/avatar_lab/` and `wip/`.
- `tools/capture-server.mjs`: the dev capture server (see "Tooling").
- `continue.md`: this file.

**Not in git (`wip/`, ignored):** the paused fire refinement (patch, report, scratch copies,
key comparison captures).

## Paused work 1: a better head sculpt (highest value)

**Problem.** The current bust is the painted silhouette inflated into 3D (Poisson solve). In
profile it is exact, but when he turns toward the viewer the face is a featureless wedge: no face
plane, eye sockets, cheekbones, proper nose width, ear; the skull is as wide as it is long.

**What was running.** A sculpt panel: three agents each building a variant in its own folder under
`tools/avatar_lab/` (git-ignored), to be judged and the winner ported into `tools/build_avatar.py`.
They were stopped mid-way.

| Variant | Approach | State when paused |
| --- | --- | --- |
| `sdf_fit` | Full anatomical SDF head + neck + shoulders, warped to the painted outline, trimmed with the extruded silhouette | **Furthest and best.** Has `bust.bin`, `bust.json`, `figure.webp` and renders (`renders/v4_yaws.png`, `v4_faces.png`). Reads as a real head at yaw 0.35 / 0.6 / 1.2: ear, eyes, nose, lips, chin. Issues: horizontal bands on the neck, a bump behind the ear at the nape, a seam down the forehead midline in the frontal view, nose slightly large. Silhouette IoU and weight checks not yet reported. |
| `inflate_plus` | Poisson inflation reshaped per region + carved/added features inside the outline | Features exist (ear, eyes, nose) but streaky artefacts and the same forehead seam. Renders: `r_preview_head.png`, `look_face.png`. No final mesh. |
| `loft` | Lofted anatomical cross-sections between the painted front/back extents | Rough, faceted, artefacts. Face close-ups only (`q9_close.png`). No final mesh. |

**Next steps.**

1. Continue `sdf_fit` (its builder is `tools/avatar_lab/sdf_fit/build.py`, with `sculpt.py`,
   `field.py`, `sdf.py`, `raster.py`, `check.py`): fix the neck bands, the nape bump, the forehead
   seam; check the hard requirements:
   - rest-pose silhouette IoU >= 0.985 against the canvas from `build_avatar.py`, face profile
     within 3 reference2 px;
   - same `bust.bin` layout and `bust.json` schema that `src/avatar/avatar.js` decodes;
   - skin weights per region: skull top / forehead -> head ~1, mid neck -> neck ~1,
     low chest -> chest ~1;
   - <= 60k triangles, normals from the field, no flipped faces;
   - renders of the final decimated mesh at yaw 0 / 0.35 / 0.6 / 1.2.
2. Graft anything good from `inflate_plus` (its brow/cheek relief) if it helps.
3. Port it into `tools/build_avatar.py` (keep its CLI, outputs and the scalp/obstacle/bone
   conventions; scalp `capDir [-0.8, 0.6, 0]`, `capCos -0.5` unless the skull moved, then re-fit the
   obstacle ellipsoids so they still enclose skull, face and neck), regenerate
   `src/avatar/bust.bin`, `bust.json`, `figure.webp`.
4. Check it in the page (see "Tooling"): rest pose over the backdrop, a glance at yaw ~0.5, the
   fire still wrapping the skull, the frosted card still covering the eyes.

## Paused work 2: fire refinement (done, not yet reviewed)

The fire builder agent **finished and verified** this in the lab on the real avatar; its
independent **review was interrupted**. To keep the page on reviewed code, `src/fire/` was restored
to the committed version and the work saved:

- `wip/fire-refine.patch`: the full change (`git apply --check` passes on the current tree).
- `wip/fire-refine-report.md`: the builder's report (changes by file:line, new params, timings,
  capture names).
- `wip/fire-scratch/working-tree-src-fire/`: the exact working copy at the stop.
- `wip/captures/F2_before_after.jpg`, `F2_sheet_deep.jpg`, `F2_deep_rest.jpg`, `F2_deep_hold.jpg`:
  its before/after sheets.

**What it does.**

- **Crisper flames:** tongues end in soft but clear edges, deep ultramarine bodies with darker
  folds, highlights on the crests (opacity contrast curve, a 6-step light march stored in the
  scalars' alpha, a finer detail warp).
- **The crown stays engulfed when he turns:** the emitter cap follows only part of the head's yaw,
  obstacles move with their full rotation, fuel at the roots rides with the scalp, obstacle cells
  take a share of the surrounding fuel. Worst-case crown coverage during a turn went 0.74 -> 0.88
  (current box) or 0.96 (deeper box).
- **The lab** now uses the real avatar and a page-like life script.
- **Cost:** about +0.2 ms GPU per step (the light march). GPU timer: step ~5.6-5.9 ms,
  render ~2.9-3.4 ms at 1230x641 on the Intel UHD.

**Recommended config with it** (`src/config.js`): `fireParams.cooling` 1.0 -> 0.3,
`fireParams.absorption` 95 -> 120, and `fireBox.max` -> `[1.45, 1.06, 0.50]` (room for fire in
front of the turned head).

**Next steps.**

1. `git apply wip/fire-refine.patch`
2. Review it (what the interrupted reviewer was asked): NaN/Inf guards on the new maths, half-float
   ranges, no per-frame allocations, render state restored, the turn refill has no popping,
   performance (step <= 6 ms, render <= 4 ms at 1230x641), no look regression vs reference2.
3. Apply the recommended config, check in the page, commit.

## Other open items

- **Fire vs the painting:** still softer than the painting's brushwork (the refinement above
  helps); the plume's front edge stops around X~1.17 above the forehead where the painting has warm
  streaks out to ~1.29.
- **First load:** the async shader compile takes ~1-6 s on this machine; the counter holds at 88%
  meanwhile (no freeze). Could be shortened by fewer fire pass variants or by warming during the
  counter's early phase.
- **The fox:** parked. Decide: drop it, or rebuild it as a mesh like the avatar somewhere the plume
  is not.
- **Not tested:** Firefox (its automation stopped launching here), Safari, phones (portrait cover
  crop + performance with the fire; `?firegrid=low` exists).

## Tooling (how to verify visually)

- Dev server: `npm run dev` (5173; it moved to 5174 when 5173 was busy).
- Capture server: `node tools/capture-server.mjs` (port 5199). In the dev page,
  `await __jnsn.capture('name')` writes `wip/captures/name.jpg`. Render on demand with
  `__jnsn.warm(220)` (220 live frames: fills the fire), or `__jnsn.scene.update({ dt, pose: { yaw,
  pitch }, pointer: null, intensity: 1 })` + `__jnsn.scene.render(t)` for posed frames.
  `__jnsn.resume()` restarts the loop.
- Browsers: the built-in Claude browser pane works for this even when hidden (screenshots of the
  pane may time out; canvas captures do not). The firefox-devtools MCP stopped launching on this
  machine. For chrome-devtools MCP start Chrome with
  `--remote-debugging-port=9222 --user-data-dir=<temp folder>`.
- Python (asset builders): `python -m venv venv` then
  `pip install pillow numpy scipy scikit-image fast-simplification`;
  run `python tools/build_avatar.py` / `python tools/prepare.py` (debug renders in `tools/debug/`).
  The previous venv lived in the session's scratchpad and will not survive.
- GPU timing: render, then a 1-pixel `gl.readPixels` to sync (`gl.finish` does not block).
- World space: units = backdrop image heights, X right, Y up, Z to the viewer; a reference2 pixel
  (x2, y2) is at X = (x2/1.388 - 39)/839, Y = 1 - (y2/1.388)/839.
