# Image to Braille

This is the image-to-character conversion used by the local smile preview.
The reusable implementation is `image-to-braille.js`. It needs Canvas 2D to
sample the input, and returns a string of real Unicode Braille characters.
The visible result is selectable text in a `<pre>`, with no Three.js dependency.

## Local image converter page

Open `src/braille/image-to-braille.html` directly from disk, or visit
http://127.0.0.1:5192/src/braille/image-to-braille.html while the local server is
running. The HTML includes its JavaScript, styles, both fonts and font licenses.
No server, connection, account or installation is needed to use the saved file.
Selected images stay in browser memory; they are not sent anywhere or saved by
the page. Clear removes the current image and output from the page.
The smile lab's “Add image” button opens this page. “Smile preview” returns to
the lab; when opened from disk, that link uses the local server on port 5192.

Choose, drag in, or paste a PNG, JPG, WebP, AVIF, GIF or BMP image. The tool
preserves its aspect ratio, including transparent images composited onto the
chosen background. Adjust detail, contrast, shadows and the background. Fit
shows the whole result; 1:1 lets you scroll through the full-size character grid.
Copy the text, save a UTF-8 `.txt`, or export a PNG with the correct font.
GIF inputs are sampled as a still image.

To change the page, edit `converter-page.template.html`, `converter-page.css`
and `converter-page.js`, then rebuild from the repository root:

```powershell
node tools/build-braille-page.mjs
```

The builder bundles the shared converter and JNSN wordmark into the standalone
HTML, using the project's existing esbuild dependency. No image is embedded
unless you choose one at runtime. `npm run build:site` also publishes a copy
at `/image-to-braille/`, with its return link pointing to the public smile lab.
Images on that page are still processed only in the visitor's browser.

## How it works

1. Sample the image into a small pixel grid. The default output is 120 columns
   × 68 rows of characters, so the sampled image is 240 × 272 pixels.
2. Convert each sampled pixel to grayscale using luminance weights:
   0.2126 red + 0.7152 green + 0.0722 blue.
3. Adjust the tones with `clamp((luminance - blackPoint) * contrast, 0, 255)`.
   The preview defaults are a black point of 26 and contrast of 1.22.
4. Use Floyd–Steinberg error diffusion to turn grayscale into black or white
   dots. This preserves shading through dot density instead of losing it to
   a single threshold.
5. Pack each 2 × 4 block of dots into one character in U+2800–U+28FF. A white
   block becomes the blank Braille character; a black block becomes ⣿.

The eight dot positions are:

```text
1 4
2 5
3 6
7 8
```

This is spatial dot mapping. It does not choose an ASCII character from a
brightness ramp such as ` .:-=+*#%@`.

## Reuse the converter

```js
import { createBrailleConverter } from '/src/braille/image-to-braille.js';

const convert = createBrailleConverter({
  columns: 120,
  rows: 68,
  blackPoint: 26,
  contrast: 1.22,
});

// sourceCanvas contains the cropped portrait, ready to sample.
document.querySelector('pre').textContent = convert(sourceCanvas);
```

The input can also be a loaded image or a video element with a decoded frame.
Create the converter once and reuse it for subsequent images or frames.
Sources must be local, same-origin, or served with suitable CORS headers so
Canvas can read their pixels. Composite transparent inputs onto the desired
background before conversion.

## Keep the proportions

The preview crops its source into a 720 × 640 canvas. Its 120 × 68 character
grid is tuned to that 9:8 portrait ratio and the existing Braille font metrics.
Crop the source to that ratio before converting, or adjust the row/column
counts for a different image shape. Sampling an arbitrary shape into the
default grid will stretch it.

The font is `site/assets/dejavu-braille.woff2`, with its license in
`site/licenses/`. The local preview loads it as `JNSN Braille`.

```css
pre {
  font-family: 'JNSN Braille', monospace;
  font-size: 15px;
  font-weight: 400;
  font-synthesis: none;
  font-variant-ligatures: none;
  line-height: 1.15;
  letter-spacing: 0;
  white-space: pre;
  width: max-content;
  margin: 0;
}
```

Load the font before measuring the text. Scale the whole `<pre>` uniformly
to fit its container; preserve every character, blank cell, and line break.
Small text can look faint because several dots share a screen pixel. A larger
display or a coarser character grid can improve readability.

## What is in the preview

`tools/smile-lab/` uses this converter for all its Braille poses and text/JSON
exports. The sequence starts with the neutral grayscale portrait in the top-left
tile of `turn-smile-atlas.png`, then transitions through the other three tiles.
The old prewritten text-art portrait is no longer loaded into the local lab.
The earlier single smiling source is `tools/smile-lab/smile-source.png`.

The source portraits were made with the built-in imagegen tool. The atlas
generation prompt is saved in `tools/smile-lab/turn-smile-prompt.txt`.

The converter changes appearance, not motion. The current lab is a morph
between still images; natural facial movement would need an animated source
such as a video or a rigged face. A video can use this same converter on each
decoded frame.
