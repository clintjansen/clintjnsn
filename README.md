# JNSN — WebGL landing page

## Production website

GitHub Pages publishes `site/` to https://clintjansen.com when `main` is pushed.
The public smile lab runs the red JNSN® intro, then turns the Braille portrait
toward the camera with a broad smile. Expression buttons, playback, timeline,
four renderers, exports, full-page view and the browser-local image converter
are included. Reduced motion disables autoplay. The static smiling portrait is
embedded as a fallback for JavaScript being disabled or animation startup failing.

The local lab in `tools/smile-lab/` is the source. Its loader and wordmark are
shared with `site/`. Build the public page and its bundled dependencies with:

```powershell
npm ci
npm ci --prefix tools/smile-lab --ignore-scripts
npm run build:site
```

Commit the generated `site/` files together with source changes before pushing.
`tools/build-smile-site.mjs` produces hashed bundles and the portrait atlas;
Three.js and textmode.js load only when selected. It also publishes the standalone
converter at `/image-to-braille/`. Uploaded images stay in the visitor's browser.

Preview the production page at http://127.0.0.1:5192/site/ while Vite is running.
The WebGL application described below remains a separate work in progress.

A single-page art piece in three layers, all seen through one orthographic camera:

1. **The backdrop**: a full-screen fragment shader. The red lava with its flowing contour lines,
   the pale area, built from plates of the reference painting.
2. **The avatar**: a real 3D model. A skinned mesh with three bones (chest, neck, head), built
   from the reference painting itself so its rest pose has the painted outline. He breathes,
   bobs, sways, and every few seconds turns his head towards the viewer.
3. **His fire**: a real-time 3D fluid simulation on the GPU. The blue flame hair burns off his
   scalp, rises and blows back, swirls, flows around his head as he moves, parts when the cursor
   passes through it, and lights his skin. It is volume-rendered against the avatar's depth.

The UI on top: the frosted-glass panel with the mark and the Syne wordmark, and live mono readouts
in the corners. The mark is one unbroken stroke reading J, N, S, N; the favicon is its J-hook.

Vanilla JS + three.js, no framework. `npm run build` produces a static `dist/` folder.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # -> dist/
npm run preview    # serve dist/ locally
```

URL parameters (no rebuild):

| param | effect |
| --- | --- |
| `?fps=60` | render cap (default 24, `0` = uncapped) |
| `?scale=0.75` | internal resolution factor (also adapts automatically when frames drop) |
| `?skip` | skip the loader |
| `?nofire` | the avatar without his fire |
| `?firegrid=low` | a smaller fire grid (64×40×32) for weak GPUs |
| `?fox` | show the fox spirit (parked while the avatar is being rebuilt) |

The fire also has a standalone lab: `http://localhost:5173/tools/fire-lab.html`
(`window.__fireLab`: `step(n)`, `capture(name)`, `setParam(k, v)`, `timings()`).

## How it is put together

```
tools/reference2.webp       the avatar reference (what the avatar and the fire are matched to)
tools/reference.webp        the backdrop reference (plates for the lava and pale area)
tools/avatar/               builds the avatar mesh from reference2 (python, see below)
tools/build_avatar.py       runs tools/avatar/build.py (the old entry point)
tools/prepare.py            builds the backdrop plates from reference (python, see below)
src/
  main.js                   boot + state machine (loading -> hold -> reveal -> live), behaviour, HUD
  scene.js                  renderer, the orthographic camera kept in lockstep with the cover
                            mapping, draw order (backdrop, avatar, fire), the depth pass for the fire
  config.js                 all tunables (fps, loader timings, card, fire box, fire look)
  signals.js                life: glance spring, idle sway, breath, bob, wandering light
  shaders/art.frag.glsl     the backdrop: lava, plates (and the parked fox)
  avatar/
    avatar.js               the skinned mesh, its rig, its skin material, and its description
                            for the fire (head volumes and scalp in the current pose)
    bust.vert.glsl / bust.frag.glsl   skinning + the painted skin
    bust.bin / bust.json    the mesh (positions, normals, skin weights, indices) and its rig data
    figure.webp             a soft field around the outline, so the lava lines wrap around him
  fire/
    fire.js                 the fluid simulation and its volume renderer (see the file header)
    sampling.js             GLSL to read the fire's heat from any material (lights his skin)
    shaders/*.glsl          the simulation and render passes
    lab.js                  the fire lab (tools/fire-lab.html)
  tex/                      backdrop plates (imported, so Vite hashes them)
  noise.js                  tiling 4-channel noise texture, shared by the shaders
  ui.js / spring.js / logo.js / styles.css   loader, frosted panel, mark, corner HUD
  input.js                  pointer -> image space
  loop.js                   fps-locked rAF loop (24 by default), pauses when hidden
```

World space everywhere: units are backdrop image heights, X right, Y up (0 = bottom of the
image), Z towards the viewer. A reference2 pixel (x2, y2) sits at
X = (x2 / 1.388 − 39) / 839, Y = 1 − (y2 / 1.388) / 839 (measured by registering the two
paintings' lava).

### The avatar

- **Shape** (`tools/avatar/`): a sculpted head, so he reads as a real head when he turns. A
  stylised anatomical head is built from smooth signed-distance shapes (`sculpt.py`): one smooth
  superquadric cranium, brow and cheekbones as soft bumps, nose, lips, jaw, ears, the muscles of
  the neck, and a neck-to-shoulders loft whose side view follows the painted rows. Its side-view
  outline is then pulled onto the painting's (the figure, plus the skull the painting hides under
  the fire) by smooth 2D warps, the last ones acting only near the midline plane, so the rest pose
  is the painting (face profile within ~1 px) and turned he has a forehead, eyes, cheekbones and a
  jaw. Marching cubes, smoothing, decimation to ~56k triangles; normals from the field.
  `tools/avatar/check.py` measures the result against the painting and renders it from all sides.
- **Rig**: chest → neck → head, at pivots measured on the painting. The skull, face and jaw ride
  the head bone as one (no lagging chin); the neck twists in the band below the jaw, and the
  shoulders follow a little. `avatar.setPose({ yaw, pitch, roll, breath, bobX, bobY })`.
- **Skin**: dark teal-navy covered in long combed brush strokes in patches of different
  directions (the painting's face and neck), laid in the plane each part of the skin faces most,
  so the face front has them too when he turns; a glossy ultramarine zone behind the neck with two
  hot streaks, a maroon warmth at the cheek, an orange rim from the lava, blue light from his fire
  (sampled from the simulation), and a cyan dissolve edge when he teleports in. The strokes live
  in rest-pose space, so they stay on the skin as he moves.
- **Life** (`src/signals.js`): breath, bob, idle sway, and every 5 to 10 s a glance: towards the
  viewer (with a curious tilt), half way, up into his own fire, or away over his shoulder; while
  he holds a look his head settles with small re-aims.

### The fire

A 96×56×48 grid (`config.fireBox`) stored as a 2D texture atlas, stepped on the GPU every frame:
advection, buoyancy, a wind that blows older flame back, a slow turbulence force, vorticity
confinement, and a two-level pressure solve. The avatar's skull, face and neck are solid
obstacles that move with the bones; the scalp (a thin shell around the skull, from just under the
eyes to the nape, as in the painting) emits the fuel in noise-driven tongues that rise and burn
out at their tips. The volume is ray-marched at half resolution, stopped at the avatar's depth
(fire in front of his face shows, fire behind his head does not), and composited over everything.

The look follows the painting rather than a lit cloud: each ray gets one colour from the fuel it
crossed, the fuel's age (which runs along each tongue) and its height, through palettes sampled
from the painting (deep violet roots, the fully saturated electric violet-blue body, azure and
cyan towards the top, a few pink and orange tongues), with an opacity curve that gives solid
colour fields with short soft edges and an iridescent glowing rim where the fire meets the
background. The drawn plume widens with height around the skull's axis (`fanBack`, `fanFront`), so
the flames behind his head lean up and back and the ones over his face rise along the forehead.
Look and behaviour: `config.fireParams` (defaults and comments in `src/fire/fire.js`).

### The sequence

The loader counter is capped by the real downloads and the asynchronous shader compile, and the
lava disc grows with it. At 100% the backdrop fades in with a ripple, the avatar teleports in
through a noisy dissolve, and his fire ignites once he is mostly there.

### Tuning and debugging

- `src/config.js`: fps, loader timings, `cardScale` / `cardShiftY`, `fireBox`, `fireParams`.
- Console: `__jnsn.warm(200)` runs 200 live frames (fills the fire), `__jnsn.live(12)` renders the
  finished scene at 12 s, `__jnsn.preview({ load: 0.4 })` the loader at 40% (these stop the loop;
  `__jnsn.resume()` hands it back). `__jnsn.scene.fire.params.<name> = …` tunes the fire live,
  `__jnsn.scene.avatar.uniforms.uDebug.value = 1` shows the bust's plain shape.

### Regenerating the assets

```bash
python -m pip install pillow numpy scipy scikit-image fast-simplification
python tools/avatar/build.py     # src/avatar/bust.bin, bust.json, figure.webp (~3 min)
python tools/avatar/check.py     # silhouette, profile and weight checks + renders
python tools/prepare.py          # src/tex/* (backdrop plates)
```

Both write visual checks to `tools/debug/` (ignored by git).

## Browser support and performance

- WebGL2 with half-float render targets (every evergreen browser).
- `backdrop-filter` for the panel, with a solid fallback.
- Measured on an Intel UHD integrated GPU at 1280×720: about 25 ms per frame (the fire's step
  ~6 ms of GPU time, its march and composite ~2–4 ms, the backdrop and avatar the rest), inside
  the 24 fps budget. The device pixel ratio is capped at 1.0 and the internal resolution steps
  down automatically (and back up) when frames miss the budget; `?firegrid=low` halves the
  simulation cost.
- Rendering pauses in background tabs. `prefers-reduced-motion` keeps the lava flowing at a crawl,
  rests the avatar, slows the fire and lowers the cadence to 12 fps.
