# clintjansen.com

GitHub Pages publishes `site/` on each push to `main`, using
`.github/workflows/pages.yml`. There is no application build step.

The page keeps the original JNSN red loader (2.8 seconds, a short hold at 100%,
then the existing fade). It then shows the same static, selectable Braille
portrait as subtlesuite.com on a white background. There is no canvas, 3D
renderer, pointer animation, or animation loop after the intro. Reduced motion
skips the timed counter and fade. If a font fails, the page still reveals.

The original 68-row portrait is embedded in `site/index.html`. The complete
block scales uniformly to fit the viewport; spaces and line breaks never wrap.
Fonts are served locally, with their licenses in `site/licenses/`.

Preview locally:

```powershell
python -m http.server 5189 --bind 127.0.0.1 --directory site
```

The custom domain remains `clintjansen.com` with HTTPS enforced in the
repository's Pages settings. The live repository is `clintjansen/clintjnsn`.
The unfinished WebGL painting remains in `src/` and the existing root Vite page
for continued local development; only `site/` is published by this workflow.
