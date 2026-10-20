/**
 * Slow, calm, deterministic "life" signals for the character. Read them as plain
 * properties after update(dt, elapsed):
 *   turn        0..1   head turned towards the viewer (scheduled glances)
 *   glance      0..1   impulse: 1 the moment a turn starts, decays exp(-2t)
 *   breath     -1..1   slow breathing, period 4.8 s
 *   bob         {x,y}  body drift in image-uv units
 *   lightAngle  rad    wandering light direction, grows forever (mod it by 2*PI for GLSL)
 *   flare       0..1   slow shimmer on the highlights, with the glance impulse added
 *   foxAttention 0..1  the fox sneakily watching: sharp ramps, random holds
 */

const TAU = Math.PI * 2;

// Turn schedule (seconds).
const FIRST_WAIT = 4.0;
const WAIT_MIN = 9, WAIT_RANGE = 7;        // 9..16
const HOLD_MIN = 1.6, HOLD_RANGE = 1.6;    // 1.6..3.2
const RAMP_UP = 1.3;
const RAMP_DOWN = 1.7;

const WAIT = 0, UP = 1, HOLD = 2, DOWN = 3;

// Fox attention schedule (seconds): quick to look, lingers, lets go slowly.
const FOX_WAIT_MIN = 5, FOX_WAIT_RANGE = 8;     // 5..13
const FOX_HOLD_MIN = 2, FOX_HOLD_RANGE = 3.5;   // 2..5.5
const FOX_UP = 0.35;
const FOX_DOWN = 1.4;

export function easeInOutCubic(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Small seeded PRNG so the glance schedule is the same on every visit.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSignals({ seed = 7 } = {}) {
  const rand = mulberry32(seed);
  const foxRand = mulberry32(seed + 101);
  let foxPhase = WAIT;
  let foxT = 0;
  let foxDur = 3.0;
  let phase = WAIT;
  let phaseT = 0;
  let phaseDur = FIRST_WAIT;
  let glanceT = Infinity; // time since the last turn started

  const signals = {
    turn: 0,
    glance: 0,
    breath: 0,
    bob: { x: 0, y: 0 },
    lightAngle: 0,
    flare: 0,
    foxAttention: 0,
    update,
  };

  function nextPhase() {
    // Carry the overshoot into the next phase so timing is frame-rate independent.
    phaseT -= phaseDur;
    phase = (phase + 1) & 3;
    if (phase === UP) {
      phaseDur = RAMP_UP;
      glanceT = phaseT;
    } else if (phase === HOLD) {
      phaseDur = HOLD_MIN + rand() * HOLD_RANGE;
    } else if (phase === DOWN) {
      phaseDur = RAMP_DOWN;
    } else {
      phaseDur = WAIT_MIN + rand() * WAIT_RANGE;
    }
  }

  function nextFoxPhase() {
    foxT -= foxDur;
    foxPhase = (foxPhase + 1) & 3;
    if (foxPhase === UP) foxDur = FOX_UP;
    else if (foxPhase === HOLD) foxDur = FOX_HOLD_MIN + foxRand() * FOX_HOLD_RANGE;
    else if (foxPhase === DOWN) foxDur = FOX_DOWN;
    else foxDur = FOX_WAIT_MIN + foxRand() * FOX_WAIT_RANGE;
  }

  function update(dt, elapsed) {
    foxT += dt;
    while (foxT >= foxDur) nextFoxPhase();
    if (foxPhase === WAIT) signals.foxAttention = 0;
    else if (foxPhase === UP) signals.foxAttention = easeInOutCubic(foxT / FOX_UP);
    else if (foxPhase === HOLD) signals.foxAttention = 1;
    else signals.foxAttention = 1 - easeInOutCubic(foxT / FOX_DOWN);

    glanceT += dt;
    phaseT += dt;
    while (phaseT >= phaseDur) nextPhase();

    if (phase === WAIT) signals.turn = 0;
    else if (phase === UP) signals.turn = easeInOutCubic(phaseT / RAMP_UP);
    else if (phase === HOLD) signals.turn = 1;
    else signals.turn = 1 - easeInOutCubic(phaseT / RAMP_DOWN);

    signals.glance = Math.exp(-glanceT * 2);

    const s = Math.sin(TAU * elapsed / 4.8);
    signals.breath = s * Math.pow(Math.abs(s), 0.2);

    signals.bob.x = 0.0018 * Math.sin(TAU * elapsed / 9.1 + 0.7);
    signals.bob.y = 0.0035 * Math.sin(TAU * elapsed / 6.3) + 0.0012 * Math.sin(TAU * elapsed / 2.9 + 1.3);

    signals.lightAngle += dt * (0.10 + 0.08 * Math.sin(elapsed * 0.071));

    const shimmer = 0.6 * Math.sin(elapsed * 0.37 + 1.0) + 0.4 * Math.sin(elapsed * 0.91 + 2.0);
    signals.flare = Math.min(Math.max(0.5 + 0.5 * shimmer + signals.glance, 0), 1);
  }

  return signals;
}
