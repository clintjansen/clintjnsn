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
  maxDpr: 1.0,                     // two ray marches + a volume per pixel: keep the pixel count honest
  minRenderScale: 0.5,             // adaptive floor when frames keep dropping
  skipLoader: params.has('skip'),
  fire: !params.has('nofire'),     // the 3D fluid fire (src/fire/); ?nofire to compare without
  fox: params.has('fox'),          // the fox spirit is parked while the avatar is rebuilt (?fox shows it)
  fireBox: {                       // world-space box the fire lives in (image heights, Y up)
    min: [0.08, 0.30, -0.36],
    max: [1.45, 1.06, 0.36],
    grid: params.get('firegrid') === 'low' ? [64, 40, 32] : [96, 56, 48],
    quality: params.get('firegrid') === 'low' ? 'low' : 'high',
  },
  // The fire's look and behaviour on this page (overrides src/fire/fire.js DEFAULT_PARAMS).
  fireParams: {
    emission: 1.35,          // enough fuel that the upper head is engulfed, like the painting
    tongueFloor: 0.42,       // fewer gaps between tongues over the crown
    youngDark: 0.12,         // roots merge into the head less darkly
    // Colour: fuel brightens with age towards white. A long ramp keeps the body in saturated
    // ultramarine and leaves white-cyan to the oldest fuel at the top of the plume.
    ageSpan: 2.0,
    cooling: 1.0,
    coreDensity: 0.0,        // density must not push fuel to white (it whitened the whole plume)
    brightGlow: 0.55,
    absorption: 95,
    exposure: 1.0,
    warmth: 1.6,             // orange/pink/magenta tongues inside the blue
    warmLo: 0.55,
    warmHi: 0.70,
    rim: 0.45,
    paletteJitter: 0.18,
    pointerStrength: 0.35,   // the hand parts the flames, it does not drag the whole plume
    pointerRadius: 0.07,
  },

  // Composition ----------------------------------------------------------------
  focal: { x: 0.56, y: 0.5 },      // image point kept in view when the viewport crops (portrait)
  cardScale: 0.72,  // "like the size you just had"                 // glass card size relative to the reference's card rect
  cardShiftY: 0.075,               // image-uv: slide the card down (still over the eyes) to free the fox's room
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
