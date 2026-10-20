/**
 * config.js — every tunable in one place.
 *
 * URL overrides for quick experiments (no rebuild):
 *   ?fps=60        render cap (0 = uncapped)
 *   ?scale=0.75    internal render resolution factor (1 = 1:1 CSS px, before DPR)
 *   ?skip          skip the loader (jump straight to the artwork)
 */

const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const num = (key, fallback) => {
  const v = parseFloat(params.get(key));
  return Number.isFinite(v) ? v : fallback;
};

export const config = {
  // Rendering ----------------------------------------------------------------
  fps: num('fps', 24),             // locked cadence; the art is composed for 24 but any rate works
  renderScale: num('scale', 1),    // multiplied by min(devicePixelRatio, maxDpr)
  maxDpr: 1.5,                     // noise-heavy fragment shader: cap the pixel count on HiDPI
  minRenderScale: 0.55,            // adaptive floor when frames keep dropping
  skipLoader: params.has('skip'),

  // Composition ----------------------------------------------------------------
  focal: { x: 0.56, y: 0.5 },      // image point kept in view when the viewport crops (portrait)
  linePeriodPx: { native: 11, min: 9, max: 18 }, // contour line spacing: native px scaled, clamped

  // Loader ---------------------------------------------------------------------
  loader: {
    minDuration: 2.8,              // s, the counter never finishes faster than this
    holdAt100: 0.25,               // s, rest on 100% before the fade
    revealDuration: 1.9,           // s, artwork fade-in
    cardDelay: 0.9,                // s after the reveal starts
  },

  // Art direction ----------------------------------------------------------------
  art: {
    flowSpeed: 0.045,              // magma line drift, periods per second
    warpSpeed: 0.035,              // magma domain-warp evolution
    lineWidth: 0.19,               // fraction of a period that is dark (0..0.5)
    bakedMix: 0.35,                // original etched lines on the character, 0..1
    flameAmount: 1.0,              // procedural hair flames
    grain: 0.022,
  },
};
