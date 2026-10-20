# JNSN — WebGL landing page

A single-page art piece: the whole viewport is one fragment shader (three.js full-screen quad).
The character and the spirit fox are **modelled**, not drawn over the reference: both are
ray-marched signed-distance models living in the shader, lit and animated in 3D. The reference
artwork only supplies the backdrop plates (flowing red magma, the fox's painted aura, the pale
area). The UI layer: the frosted-glass panel with the mark and the Syne wordmark,
and live mono readouts in the corners. The mark is one unbroken stroke reading J, N, S, N; the
favicon is its J-hook (public/favicon.svg + PNG fallbacks).

Vanilla JS, no framework. `npm run build` produces a static `dist/` folder that drops onto any host.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # -> dist/
npm run preview    # serve dist/ locally
```

Quick experiments via URL parameters (no rebuild):

| param | effect |
| --- | --- |
| `?fps=60` | render cap (default 24, `0` = uncapped) |
| `?scale=0.75` | internal resolution factor (also adapts automatically when frames drop) |
| `?skip` | skip the loader |

## How it is put together

```
tools/reference.webp        the reference artwork (never drawn directly, not deployed)
src/tex/                    backdrop plates generated from it by tools/prepare.py (imported, hashed)
  base.webp                 colour plate with the character, his hair and the glass card inpainted away
  detail.webp               same, unblurred (the fox's painted aura keeps its sharp edges)
  mask.webp                 R reference silhouette, G fox aura, B magma; pale area = the rest
  fields.webp               R figure field (contour lines wrap around it), B fox aura soft
  extra.webp                B baked line texture (unused by the look, kept for experiments)
  meta.json                 image size, glass-card rect
src/
  main.js                   boot + state machine (loading -> hold -> reveal -> live), behaviour, HUD
  scene.js                  three.js renderer, cover mapping (viewport <-> artwork), uniforms
  shaders/art.frag.glsl     THE ART: magma, plates, the bust and the fox (SDF ray marching), hair volume
  noise.js                  tiling 4-channel noise texture the shader builds its fbm from
  signals.js                the character's and the fox's "life": springs, sway, schedules
  config.js                 all tunables (fps, loader timings, card size/position, art knobs)
  ui.js / spring.js / logo.js / styles.css   loader, frosted panel, the meander mark, corner HUD, springs
  input.js                  pointer -> image space, with a short trail the hair reacts to
  loop.js                   fps-locked rAF loop (24 by default), pauses when hidden
tools/prepare.py            regenerates src/tex from the reference (python + pillow + numpy)
```

### The shader, layer by layer

1. **Magma** — procedural everywhere: red with hot/cool drifts and a contour-line field whose
   domain warp evolves in time (bounded, so it never shears) plus a slow uniform drift. During the
   loader it is revealed by an organic, noisy disc growing from the screen centre.
2. **Backdrop plates** — the fox's painted aura and the pale area, with faint static contour lines.
3. **The bust** — a signed-distance model (cranium, face, nose, lips, chin, ear, eye socket, neck,
   shoulders) ray-marched with an orthographic camera that matches the 2D composition. Shaded in
   the art's navy with contour lines that follow the form in object space (so they turn with him),
   a wandering key light, a cool fill from the fox, a hot rim and orange glints from the magma, and
   a cheap ambient occlusion. He bobs, breathes (the chest rises), sways continuously and glances
   toward the viewer: the glance is a critically damped spring, not a ramp, so starts and stops
   are soft. Head yaw/pitch come from `signals.js` through `uHeadRig`.
4. **Hair** — a volumetric flame on the crown: 11 depth slabs through a cone blown up and back,
   with view-coherent noise so tongues survive the accumulation, a solid base, cyan cores and warm
   fringes; it turns with the head and bends away from the pointer trail.
5. **The fox** — a second SDF model sitting inside its aura (haunches, chest, legs, curling tail,
   head with snout, nose and ears), rendered as a spirit: deep blue with light pouring through
   the edges and a cyan rim, plus an aura glow hugging the silhouette. Its head is rigged
   (`uFoxRig`: yaw, pitch, sniff, retreat): it watches the cursor on its own schedule and whenever
   the cursor comes near, pulls back and flushes red when it gets too close, and sniffs the air
   about a second after a close cursor has gone (or on an idle timer). Eye glints sharpen as it
   watches.
6. **Finish** — vignette and a whisper of grain.

All coordinates are "image uv" (0..1, y down) mapped onto the viewport with a `cover` fit and a
focal point (`config.focal`) so portrait phones crop around the head. Model placement: `PIVOT`
(bust) and `FOX_PIVOT` / `FOX_SCALE` (fox) in the shader; `FOX_FACE` in `main.js` is where the
cursor distances are measured from.

The loader counter starts with the first frame and is capped by the real texture downloads and the
asynchronous shader compile, so it never claims more than has arrived; the magma disc eases
towards it.

### Tuning

- `src/config.js` — fps, loader timings, `cardScale` / `cardShiftY`, `art.*` knobs.
- In the browser console: `__jnsn.scene.uniforms.<name>.value = …` changes live;
  `__jnsn.live(12)` renders the finished scene at 12 s, `__jnsn.preview({ load: 0.4 })` renders
  the loader at 40% (both stop the loop; `__jnsn.resume()` hands it back);
  `__jnsn.scene.uniforms.uDebug.value = 1 | 2 | 3 | 4` shows the bust alone (flat light), the
  masks, the lines only, or the hair density.
- Shapes are plain SDF primitives in `sdBust` / `sdFox`: move a `vec3` centre or a radius and
  reload. `uMarchSteps` / `uHairSteps` trade quality for speed.

### Regenerating the plates

Only needed if the reference image or the classification rules change:

```bash
python -m pip install pillow numpy
python tools/prepare.py
```

It writes `src/tex/*` and visual checks to `tools/debug/` (ignored by git).

## Browser support and performance

- WebGL2 (every evergreen browser; three.js r169 no longer targets WebGL1).
- `backdrop-filter` for the panel (Chrome 76+, Firefox 103+, Safari 9+ prefixed, 18+ unprefixed)
  with a darker solid fallback.
- Two ray marches and a volume per pixel are expensive: the device pixel ratio is capped at 1.0,
  empty pixels skip the marches through 2D bounds, and the internal resolution steps down
  automatically (and back up) when frames miss the 24 fps budget. Measured on an Intel UHD
  integrated GPU: ~28 ms per 1230×641 frame; a 1080p screen settles around 0.7 scale.
- The shader compiles asynchronously (about a second) while the loader counts.
- Rendering pauses in background tabs. `prefers-reduced-motion` keeps the magma flowing at a crawl,
  rests the character (no bob/glance/wave), dims the flames and lowers the cadence to 12 fps.

## Future expansion

The renderer is a self-contained module (`createScene`) with no DOM assumptions beyond the canvas,
so a Preact/React shell can be added later for more pages without touching the art.
