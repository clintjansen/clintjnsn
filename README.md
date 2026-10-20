# JNSN — WebGL landing page

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
tools/build_avatar.py       builds the avatar mesh from reference2 (python, see below)
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

- **Shape** (`tools/build_avatar.py`): the painting is segmented into background and figure;
  the face, chin, throat, neck and shoulders come straight from it, and the skull (hidden by the
  fire in the painting) is an ellipse fitted to the face. That silhouette is inflated into 3D by
  solving a Poisson equation inside it and taking the square root (a disc becomes a sphere, a band
  a round tube, with no creases), then capped per region, meshed with marching cubes, smoothed and
  decimated to ~46k triangles. Normals come from the volume itself.
- **Rig**: chest → neck → head, at pivots measured on the painting. Skin weights blend across the
  nape-to-throat line so a turn twists the whole neck. `avatar.setPose({ yaw, pitch, breath,
  bobX, bobY })`.
- **Skin**: near-black navy covered in short combed strokes in patches of different directions
  (like the painting), a glossy ultramarine zone behind the neck with two hot streaks, a maroon
  warmth at the cheek, an orange rim from the lava, blue light from his fire (sampled from the
  simulation) with a yellow-to-cyan rim where it licks the forehead, and a cyan dissolve edge when
  he teleports in. The strokes live in rest-pose space, so they stay on the skin as he moves.

### The fire

A 96×56×48 grid (`config.fireBox`) stored as a 2D texture atlas, stepped on the GPU every frame:
advection, buoyancy, a wind that blows older flame back, a slow turbulence force, vorticity
confinement, and a two-level pressure solve. The avatar's skull, face and neck are solid
obstacles that move with the bones; the scalp (a shell around the skull, from the brow line to
the nape) emits the fuel in noise-driven tongues. The volume is ray-marched at half resolution,
stopped at the avatar's depth (fire in front of his face shows, fire behind his head does not),
and composited over everything. The palette follows the painting: deep blue and ultramarine
bodies, cyan and white cores, warm orange/pink fringes. Look and behaviour: `config.fireParams`
(defaults and comments in `src/fire/fire.js`).

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
python tools/build_avatar.py     # src/avatar/bust.bin, bust.json, figure.webp
python tools/prepare.py          # src/tex/* (backdrop plates)
```

Both write visual checks to `tools/debug/` (ignored by git).

## Browser support and performance

- WebGL2 with half-float render targets (every evergreen browser).
- `backdrop-filter` for the panel, with a solid fallback.
- Measured on an Intel UHD integrated GPU at 1280×720: about 27 ms per frame (the fire's step
  ~6 ms of GPU time, its march and composite ~2–4 ms, the backdrop and avatar the rest), inside
  the 24 fps budget. The device pixel ratio is capped at 1.0 and the internal resolution steps
  down automatically (and back up) when frames miss the budget; `?firegrid=low` halves the
  simulation cost.
- Rendering pauses in background tabs. `prefers-reduced-motion` keeps the lava flowing at a crawl,
  rests the avatar, slows the fire and lowers the cadence to 12 fps.
