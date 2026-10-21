/**
 * Slow, fluid "life" signals for the character and the fox. Read them as plain
 * properties after update(dt, elapsed):
 *   turn        0..1   head glance towards the viewer, spring-smoothed (no hard ramps); each
 *                      glance picks a look: to the viewer, half way and down, or up into the fire
 *   headYaw     rad    glance + continuous idle sway
 *   headPitch   rad    nods: glance dip + idle sway
 *   glance      0..1   impulse at the moment a glance starts, decays exp(-2t)
 *   breath     -1..1   slow breathing, period 4.8 s
 *   bob         {x,y}  body drift in image-uv units
 *   lightAngle  rad    wandering light direction, grows forever (mod it by 2*PI for GLSL)
 *   flare       0..1   slow shimmer on the highlights, with the glance impulse added
 *   foxAttention 0..1  the fox deciding to watch (sharp on, slow off)
 *   foxSniffTick       true on the frame an idle sniff should start (every 14..26 s)
 */

const TAU = Math.PI * 2;

const FIRST_WAIT = 4.0;
const WAIT_MIN = 5, WAIT_RANGE = 5;        // 5..10 s between glances
const HOLD_MIN = 2.0, HOLD_RANGE = 2.0;    // 2..4 s looking at you

// The looks he chooses from when he glances (weights sum to 1). turn: 0 profile .. 1 facing the
// viewer as far as the rig allows; pitch: radians, > 0 lifts the chin.
const LOOKS = [
  { w: 0.45, turn: 1.0, pitch: 0.05 },    // towards the viewer
  { w: 0.30, turn: 0.5, pitch: -0.04 },   // half way, eyes a little down
  { w: 0.25, turn: 0.22, pitch: 0.14 },   // up, into his own fire
];

const FOX_WAIT_MIN = 5, FOX_WAIT_RANGE = 8;
const FOX_HOLD_MIN = 2, FOX_HOLD_RANGE = 3.5;
const FOX_SNIFF_MIN = 14, FOX_SNIFF_RANGE = 12;

export function easeInOutCubic(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Critically damped spring towards a target: no overshoot, soft start and stop. */
export function springTo(state, target, omega, dt) {
  const x = state.x - target;
  const v = state.v;
  const e = Math.exp(-omega * dt);
  const c2 = v + omega * x;
  state.x = target + (x + c2 * dt) * e;
  state.v = (v - c2 * omega * dt) * e;
  return state.x;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth, non-repeating-looking drift: three incommensurate sines.
export const sway = (t, a, b, c) => (Math.sin(t * a) + 0.6 * Math.sin(t * b + 1.7) + 0.35 * Math.sin(t * c + 0.4)) / 1.95;

export function createSignals({ seed = 7 } = {}) {
  const rand = mulberry32(seed);
  const foxRand = mulberry32(seed + 101);

  // glance schedule: a target that flips, and a spring that follows it
  let glanceOn = false;
  let glanceT = 0;
  let glanceDur = FIRST_WAIT;
  let sinceGlance = Infinity;
  const turnS = { x: 0, v: 0 };
  const lookPitchS = { x: 0, v: 0 };
  let look = LOOKS[0];
  const pickLook = (r) => {
    let acc = 0;
    for (const l of LOOKS) { acc += l.w; if (r < acc) return l; }
    return LOOKS[LOOKS.length - 1];
  };

  // fox attention schedule (same shape) + idle sniff timer
  let foxOn = false;
  let foxT = 0;
  let foxDur = 3.0;
  let sniffT = 0;
  let sniffDue = FOX_SNIFF_MIN + foxRand() * FOX_SNIFF_RANGE;

  const signals = {
    turn: 0, headYaw: 0, headPitch: 0, glance: 0,
    breath: 0, bob: { x: 0, y: 0 }, lightAngle: 0, flare: 0,
    foxAttention: 0, foxSniffTick: false,
    update,
  };

  function update(dt, elapsed) {
    // ---- glance: flip the target on schedule, follow it with a spring
    glanceT += dt;
    sinceGlance += dt;
    while (glanceT >= glanceDur) {
      glanceT -= glanceDur;
      glanceOn = !glanceOn;
      glanceDur = glanceOn ? HOLD_MIN + rand() * HOLD_RANGE : WAIT_MIN + rand() * WAIT_RANGE;
      if (glanceOn) {
        sinceGlance = 0;
        look = pickLook(rand());
      }
    }
    signals.turn = springTo(turnS, glanceOn ? look.turn : 0, glanceOn ? 2.6 : 1.7, dt);
    const lookPitch = springTo(lookPitchS, glanceOn ? look.pitch : 0, glanceOn ? 2.2 : 1.6, dt);
    signals.glance = Math.exp(-sinceGlance * 2);

    // ---- continuous sway so he is never frozen, layered under the glance
    const yawSway = 0.07 * sway(elapsed, 0.23, 0.41, 0.77);
    const pitchSway = 0.035 * sway(elapsed + 11.0, 0.19, 0.47, 0.83);
    signals.headYaw = signals.turn * 0.62 + yawSway;
    signals.headPitch = lookPitch + pitchSway;

    const s = Math.sin(TAU * elapsed / 4.8);
    signals.breath = s * Math.pow(Math.abs(s), 0.2);

    signals.bob.x = 0.005 * sway(elapsed + 3.0, 0.17, 0.29, 0.61);
    signals.bob.y = 0.009 * sway(elapsed + 7.0, 0.21, 0.37, 0.69);

    signals.lightAngle += dt * (0.10 + 0.08 * Math.sin(elapsed * 0.071));

    const shimmer = 0.6 * Math.sin(elapsed * 0.37 + 1.0) + 0.4 * Math.sin(elapsed * 0.91 + 2.0);
    signals.flare = Math.min(Math.max(0.5 + 0.5 * shimmer + signals.glance, 0), 1);

    // ---- fox attention: quick to look, slow to let go
    foxT += dt;
    while (foxT >= foxDur) {
      foxT -= foxDur;
      foxOn = !foxOn;
      foxDur = foxOn ? FOX_HOLD_MIN + foxRand() * FOX_HOLD_RANGE : FOX_WAIT_MIN + foxRand() * FOX_WAIT_RANGE;
    }
    const target = foxOn ? 1 : 0;
    signals.foxAttention += (target - signals.foxAttention) * Math.min(1, dt * (foxOn ? 9 : 1.4));

    // ---- idle sniffs every so often
    sniffT += dt;
    signals.foxSniffTick = false;
    if (sniffT >= sniffDue) {
      sniffT = 0;
      sniffDue = FOX_SNIFF_MIN + foxRand() * FOX_SNIFF_RANGE;
      signals.foxSniffTick = true;
    }
  }

  return signals;
}
