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
    max: [1.45, 1.06, 0.50],       // room in front of a head turned to the viewer (z ~ 0.34)
    grid: params.get('firegrid') === 'low' ? [64, 40, 32] : [96, 56, 48],
    quality: params.get('firegrid') === 'low' ? 'low' : 'high',
  },
  // The fire's look and behaviour on this page (overrides src/fire/fire.js DEFAULT_PARAMS), tuned
  // side by side with tools/reference2.webp: flames that rise from the scalp (down to just under the
  // eyes) in tongues, fan up and back like the painting, in its saturated colours.
  fireParams: {
    // --- simulation: tongues rising off the scalp, not a puff around it
    emission: 1.6,
    shell: 0.4,              // a thin emitter shell: the flames start at the scalp, not in the air in front of the face
    shellFront: 0.35,        //   thinner still over the face: they rise along the forehead, the profile stays clean
    tongueScale: 1.1,        // a few broad tongues across the scalp
    tongueFloor: 0.1,        //   with little fuel between them (they stay separate as they rise)
    tongueLo: 0.45,
    tongueHi: 0.6,
    hairline: 0.08,          // a calm lower edge where the flames meet the face (just under the eyes)
    hairlineSoft: 0.5,
    emitOut: 0.6,            // combed up along the scalp; a strong outward push made a round afro
    emitUp: 2.5,
    emitBack: 0.4,
    buoyancy: 1.0,
    wind: 0.2,
    windLift: 0.4,
    windAge: 0.3,
    windYoung: 0.6,
    turbulence: 1.3,         // large, slow curls (the painting's S-shaped tongues)
    turbulenceScale: 1.3,
    vorticity: 2.5,
    decay: 0.3,              // fuel burns out as it rises: tongues end in tips instead of filling the box
    ageDecay: 0.35,
    // --- rendering: the painting's flat, fully saturated colour fields (no cloud-like shading)
    shadow: 0,               // no light march: the painting's fire is emissive, not a lit cloud
    lightRamp: 0,
    shadowDark: 0,
    gradientMap: 1,          // one colour per ray from the fuel it crossed, its age and its height
    mapFuel: 0.2,
    mapAge: 0.65,            //   age runs along each tongue, so the colour follows the flames
    mapHeight: 0.35,         //   and the plume lightens towards the top of the frame
    heightLo: 0.56,
    heightHi: 1.0,
    mapAlphaLo: 0.12,        // solid colour fields with short soft edges, no translucent veils
    mapAlphaHi: 0.55,
    mapBustSoft: 0.35,       //   but over the head the flames fade softly into the face
    rimGlow: 0.5,            // the glowing orange rim where the fire meets the background (the painting's profile)
    mapRim: 0.01,
    ageSpan: 2.0,
    youngDark: 0.75,         // the roots stay deep violet, so the head emerges from a dark core
    youngFade: 0.7,
    cooling: 0.3,
    coreDensity: 0.0,
    absorption: 110,
    exposure: 1.0,
    whiteSpill: 0.1,         // keep the violet-blue saturated at full brightness (no bleed to white)
    densityContrast: 0.6,
    densityKnee: 0.15,
    densitySoft: 1.0,
    detail: 0.014,           // a calm detail warp: smooth painted gradients, no fine streaks
    detailScale: 3.5,
    warmth: 1.0,             // a few warm tongues (pink, orange) among the blue and cyan
    warmLo: 0.78,
    warmHi: 0.86,
    rim: 1.0,                // iridescent rims where the fire meets the background
    rimWarm: 1.0,
    paletteJitter: 0.18,
    // --- composition: the plume widens with height around the skull's axis, so the flames behind
    // the head lean up and back and the ones over the face up and forwards (the painting's fan)
    fanX: 0.99,
    fanLo: 0.62,
    fanHi: 1.05,
    fanBack: 0.7,
    fanFront: 0.12,
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
