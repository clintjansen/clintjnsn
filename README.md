# JNSN — WebGL landing page

A single-page art piece: the whole viewport is one fragment shader (three.js full-screen quad)
that re-animates the reference artwork — flowing red magma textured with fine contour lines,
a calm navy profile with blue flaming hair, a sharp glowing spirit fox — behind one frosted-glass
card with the JNSN mark.

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
src/tex/                    textures generated from it by tools/prepare.py (imported, so Vite hashes them)
  base.webp                 colour layout with the baked glass card inpainted and the line texture removed
  detail.webp               inpainted but unblurred (the fox keeps its sharp original edges)
  mask.webp                 region partition: R person, G blue (fox + hair), B magma (pale = the rest)
  fields.webp               R figure field (lines wrap around it), G person soft, B blue soft
  extra.webp                R hair region, G hot highlights on the character, B baked lines
  meta.json                 image size, glass-card rect, flame origin
src/
  main.js                   boot + state machine (loading -> hold -> reveal -> live) and per-frame glue
  scene.js                  three.js renderer, cover mapping (viewport <-> artwork), uniforms
  shaders/art.frag.glsl     THE ART. Every visual effect lives here.
  noise.js                  tiling 4-channel noise texture the shader builds its fbm from (2–3 fetches)
  config.js                 all tunables (fps, loader timings, art knobs)
  ui.js / spring.js / logo.js / styles.css   loader, glass card, logo mark, entrance spring
  (fonts: @fontsource/syne 800 + @fontsource/jetbrains-mono 500, self-hosted, imported in main.js)
  input.js                  pointer -> image space, with a short trail the flames react to
  loop.js                   fps-locked rAF loop (24 by default), pauses when hidden
  signals.js                the character's "life": glance schedule, breath, bob, wandering light
tools/prepare.py            regenerates public/tex from the reference (python + pillow + numpy)
```

### The shader, layer by layer

1. **Magma** — procedural everywhere: red with hot/cool drifts and a contour-line field whose
   domain warp evolves in time (bounded, so it never shears) plus a slow uniform drift.
   During the loader it is revealed by an organic, noisy disc growing from the screen centre
   (`uSpread`), with a brighter lava lip at the front.
2. **Artwork** — the colour base with *static* contour lines per region (strong on the person,
   faint on the pale area, none on the fox). The character bobs, breathes and glances through a
   smooth displacement field (no layer separation needed), so the lines ride along.
3. **Life** — fox glow pulse and rim shimmer; the whole hair burns (a flowing warp of the baked
   blue plus noise-driven flame tongues blown back and to the left, bending away from the pointer
   trail); rim light and inner warmth on the character driven by the magma's heat and a wandering
   light; flickering highlights; a slow band of light across the face that moves to the front
   during a glance. The fox has two sneaky slit eyes: faint glints at rest that sharpen and snap
   towards the cursor on its own schedule (`signals.foxAttention`) or whenever the cursor comes
   near its face; close by, it gets a little upset (red flush around the face, pink slits, faster
   glow pulse, livelier rim). Face position and radius: `FOX_FACE` in main.js and the eye
   coordinates in the fox block of the shader.
4. **Finish** — vignette and a whisper of grain.

All coordinates are "image uv" (0..1, y down) mapped onto the viewport with a `cover` fit and a
focal point (`config.focal`) so portrait phones crop around the head.

### Tuning

- `src/config.js` — fps, loader timings, `art.*` knobs (`flowSpeed`, `warpSpeed`, `lineWidth`,
  `bakedMix`, `flameAmount`, `grain`). They map 1:1 onto shader uniforms.
- In the browser console: `__jnsn.scene.uniforms.<name>.value = …` changes live;
  `__jnsn.live(12)` renders the finished scene at 12 s, `__jnsn.preview({ load: 0.4 })` renders
  the loader at 40% (both stop the loop; `__jnsn.resume()` hands it back); `__jnsn.scene.uniforms.uDebug.value = 1 | 2 | 3` shows the flame field,
  the masks, or the lines only.
- Positions (head ellipse, flame direction, crown) are constants near the top of the relevant
  blocks in `art.frag.glsl`; the crown and card rect come from `public/tex/meta.json`.

### Regenerating the textures

Only needed if the reference image or the classification rules change:

```bash
python -m pip install pillow numpy
python tools/prepare.py
```

It writes `src/tex/*` and visual checks to `tools/debug/` (ignored by git).

## Browser support and performance

- WebGL2 (every evergreen browser; three.js r169 no longer targets WebGL1).
- `backdrop-filter` for the glass card (Chrome 76+, Firefox 103+, Safari 9+ prefixed, 18+ unprefixed)
  with a milkier solid fallback.
- The fragment shader is fill-rate bound (~25 noise-texture fetches per pixel after gating the
  flame and loader noise to where they matter; measured ~35 ms per 1920×1080 frame on an Intel UHD
  integrated GPU). Device pixel ratio is capped at 1.5 and the internal resolution steps down
  automatically when more than 30% of frames miss the 24 fps budget (`loop.js` → `scene.setRenderScale`).
- Rendering pauses in background tabs. `prefers-reduced-motion` keeps the magma flowing at a crawl,
  rests the character (no bob/glance/wave), dims the flames and lowers the cadence to 12 fps.

## Future expansion

The renderer is a self-contained module (`createScene`) with no DOM assumptions beyond the canvas,
so a Preact/React shell can be added later for more pages without touching the art. For the
current single page, static vanilla JS keeps the deploy a plain folder copy.

## Hosting

The deployment repository is `https://github.com/clintjansen/jnsn`.
GitHub Actions builds the static site and deploys `dist/` to GitHub Pages on
every push to `main`. The workflow can also be started manually from Actions.
No Google Cloud resources or deployment credentials are required.

In the repository's **Settings → Pages**, select **GitHub Actions** as the
source, set the custom domain to `clintjansen.com`, and enable **Enforce HTTPS**
once GitHub has issued the certificate. The custom domain must be set in
Pages settings; the `public/CNAME` file alone does not configure it for an
Actions deployment.

Keep DNS at Yourhosting. Once the Pages deployment is ready, the website
records should be:

| Type | Name | Value |
| --- | --- | --- |
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| CNAME | www | clintjansen.github.io |

Use a TTL of 3600 seconds. Replace the previous apex and `www` website
records; preserve the existing MX, SPF, and other mail records. Keep
Yourhosting's nameservers. GitHub redirects `www` to the configured apex domain.
GitHub may also provide an account-specific TXT record for domain ownership
verification; retain that record once verification succeeds.

GitHub Pages is free for a public repository on GitHub Free. Private repository
Pages hosting requires an eligible paid GitHub plan. The domain renewal at
Yourhosting remains separate.

References:
- https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site
