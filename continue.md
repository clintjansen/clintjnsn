# Continue here

Updated 2026-10-21. This file is the handoff: what is live, what changed in the last round, and
what is open.

## Where things stand

**On `origin/main` (`4f74171`):** the first 3D avatar round (inflated bust, cloud-lit fluid fire).

**Local, not pushed yet:** the round that makes the avatar faithful to `tools/reference2.webp`:

- **A sculpted head** (`tools/avatar/`, the canonical builder; `tools/build_avatar.py` runs it).
  A stylised anatomical head made of smooth signed-distance shapes, its side view fitted onto
  the painting (face profile within ~1 px, silhouette IoU 0.9986), so turned towards the viewer he
  has a forehead, eyes, cheekbones, a jaw and neck muscles instead of a featureless wedge.
  `python tools/avatar/check.py` measures it and renders it from all sides
  (`tools/debug/avatar/`).
- **Head movement**: glances up to ~44 degrees towards the viewer with a slight tilt, half way, up
  into the fire, or away over his shoulder; small settling moves while he holds a look; the
  shoulders follow a little; skull, face and jaw turn as one (the jaw no longer lags).
- **The fire, faithful to the painting** (Clint: more vibrant colours, flames instead of an afro,
  flames starting just under the eyes):
  - flames rise off a thin scalp shell (just under the eyes at the front, to the nape at the back)
    in tongues that burn out at their tips;
  - each ray is coloured from the fuel it crossed, the fuel's age and its height through palettes
    sampled from the painting (electric violet-blue body, azure/cyan towards the top, a few pink
    and orange tongues), as solid colour fields with short soft edges and a glowing rim;
  - the drawn plume widens with height around the skull's axis (the painting's fan: back flames
    lean up and back, front flames rise along the forehead).
- **The skin**: brighter teal-navy with long combed brush strokes (measured on the painting),
  also on the face front when he turns (triplanar).
- ~25 ms per frame at 1280x720 on the Intel UHD (24 fps budget: 41.7 ms).

The lava backdrop is unchanged ("perfectly fine, leave that"). The fox is parked (`?fox`).

## Open

- **The frosted card**: Clint wants to revisit it once the WebGL is done (do not move it before).
  Note for then: the card currently sits just below the eyes (it was shifted down by
  `cardShiftY` to make room for the fox, which is parked); the fire now covers the eyes anyway.
- **Fire vs the painting, still different**: the painting's plume has a white-cyan core column
  at the top centre and a few large S-shaped tongues (orange/yellow at the top left, a magenta
  blob behind the ear); ours varies over time and is more uniform. The rim glow is the same on
  the lava side as on the pale side (the painting's bright rim is mostly along the profile).
- **Skin strokes**: long and painterly now, but more regular than the painting's.
- **Not tested**: Firefox (its automation stopped launching here), Safari, phones (portrait cover
  crop + performance; `?firegrid=low` exists).
- **First load**: the async shader compile can take seconds on this machine (the counter holds at
  88% meanwhile).

## Tooling (how to verify visually)

- Dev server: `npm run dev` (5173). Capture server: `node tools/capture-server.mjs` (port 5199);
  in the dev page `await __jnsn.capture('name')` writes `wip/captures/name.jpg`.
- `__jnsn.warm(240)` runs 240 live frames (fills the fire, real glances); for posed frames call
  `__jnsn.scene.update({ dt, pose: { yaw, pitch, roll }, pointer, intensity: 1 })` then
  `__jnsn.scene.render(t)`. `__jnsn.scene.fire.params.<name> = value` tunes the fire live.
  The fire changes over time: judge three frames a few seconds apart, never one.
- Compare with the painting at the page's framing: at 1280x720 the page shows reference2
  x2 54..1974, y2 42..1122.
- Python for the builders: `python -m venv venv`, then
  `pip install pillow numpy scipy scikit-image fast-simplification`.
- GPU timing: render, then a 1-pixel `gl.readPixels` to sync (`gl.finish` does not block).
- World space: units = backdrop image heights, X right, Y up, Z to the viewer; a reference2 pixel
  (x2, y2) is at X = (x2/1.388 - 39)/839, Y = 1 - (y2/1.388)/839.
