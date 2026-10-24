# Local smile preview

This folder is the source for the local and public smile lab. The GitHub Pages
workflow publishes the generated `site/` folder. Run `npm run build:site` from
the repository root after changing this lab, then commit the source and generated
site together. The original WebGL project remains separate.

From the repository root:

```powershell
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" install --prefix tools/smile-lab --ignore-scripts
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5192 --strictPort
```

Open http://127.0.0.1:5192/tools/smile-lab/ . Use “Preview page” to see the
red loader followed by the portrait without preview controls. Escape returns.
“Add image” opens the separate image-to-Braille converter in the same tab.
Its “Smile preview” link brings you back here.
The local red loader now uses a 3.4-second JNSN® ident: opposing letter slices
assemble the shared wordmark, a single black shutter passes through, and the
red title card lifts away into the portrait. The counter and rule follow the
same timeline. “Replay loader” restarts the full ident. Motion is CSS-only in
`site/loader-motion.css`, imported by the local `loader-motion.css`; reduced
motion shows the logo without the entrance or wipe. The public page shares the
loader, wordmark, animation and controls. `smile-fallback.txt` is its exact final
120 × 68 Braille pose for visitors without JavaScript or an unavailable atlas.
The loader starts while the atlas and fonts load and waits for readiness before
revealing the portrait; failed or stalled loads release it with the still visible.
The intro plays a 4.6-second keyframe morph from a neutral grayscale portrait
to a front-facing broad smile, then holds the final pose. “Play turn + smile”
replays it; pause and resume preserve the current pose. Drag the timeline to
inspect any intermediate pose. Neutral and Big smile jump to the two endpoints.
The old prewritten text-art frame has been removed from this local sequence.
Playback stops rendering while hidden. Reduced motion disables autoplay.

In the full-page preview, Space plays/pauses, Home returns to the neutral image,
End shows the front-facing smile, and Left/Right step through the turn by 5%.

Braille uses a true 2 × 4 dot mapping and selectable text, with the existing
locally hosted font. textmode.js 0.18.0 uses its actual `createTexture(canvas)`
conversion. Three.js uses its actual AsciiEffect addon on a flat portrait plane.
Each renderer receives the same image source. Every Braille pose, including the
first one, is now converted from the grayscale image through the same pipeline.

The reusable converter is `src/braille/image-to-braille.js`. Its dedicated
README, `src/braille/README.md`, explains the dot mapping, dithering, settings,
font, sizing, and how to use the conversion with images, canvases, or video.

The reusable logo lives in `src/components/jnsn-wordmark.js`. The preview imports
and uses that component. See `src/components/README.md` for embedding and sizing.
Its measured font, spacing, 93.4028px width and 29px height match the original
preview logo at default settings in the tested browser.

`portrait-motion.js` triangulates 35 authored facial/body landmarks and 16 fixed
boundary points with Delaunator 5.1.0. Both neighboring keyframes are warped to
the interpolated facial geometry before blending. The eyes, nose, lips and jaw
therefore move through the turn. This is a 2D keyframe morph, not a 3D face rig
or a generated video. The grayscale source is converted into Braille each frame.

Motion frames is a local frame player, not the ASCII Motion editor/runtime.
“ASCII Motion JSON” prepares a 57-frame sequence following the editor's documented JSON
import schema: https://docs.ascii-motion.com/import/json . Set the editor canvas
to 120 × 68 before importing.
Editor import has not yet been verified. This JSON can be large because the
format repeats cell positions and colors for every frame.

`turn-smile-atlas.png` contains four AI-authored portrait keyframes, generated
with the built-in imagegen tool using the original portrait and the earlier
`smile-source.png` as references. The complete generation prompt is saved in
`turn-smile-prompt.txt`. Those generated faces are interpretations of the
reference. The first endpoint is now the neutral image from that atlas.
