/**
 * Pointer input mapped into "image uv" space.
 *
 * Coordinate convention: u runs left -> right, v runs TOP -> BOTTOM (y-down), both 0..1
 * across the artwork. Values outside 0..1 are allowed (pointer beside the image).
 * `toImageUV(clientX, clientY) -> [u, v]` is supplied by the integrator.
 *
 * `trail` is a Float32Array(maxTrail * 4) meant to be uploaded as a vec4[] uniform:
 *   entry i = trail[i*4 + 0..3] = [u, v, age, strength]
 *     age      seconds since the sample was taken; 99 marks an empty / expired slot
 *     strength 0.15..1 derived from pointer speed; 0 marks an empty / expired slot
 * Slots are written round-robin (the oldest is overwritten) and are NOT ordered by age,
 * so a shader should loop over all maxTrail entries, skip strength <= 0.0 and fade each
 * one with e.g. strength * (1.0 - age / 2.5).
 *
 * `update(dt, now)` expects `now` on the performance.now() clock (the rAF timestamp).
 */

const TRAIL_LIFE = 2.5;      // s, lifetime of a trail sample
const SAMPLE_DIST = 0.006;   // uv, movement since the last sample that forces a new one
const SAMPLE_PERIOD = 90;    // ms, resample at least this often while moving slowly
const MOVING_SPEED = 0.02;   // uv/s, below this the pointer counts as stopped
const IDLE_MS = 120;         // ms without events before the velocity starts decaying
const IDLE_DECAY = 8;        // 1/s, velocity decay rate while idle
const VEL_ALPHA = 0.35;      // exponential smoothing of the per-event velocity estimate
const MIN_EVENT_DT = 0.004;  // s, coalesced events closer than this share one estimate
const DEAD_AGE = 99;

export function createPointer({ toImageUV, maxTrail = 8 }) {
  const trail = new Float32Array(maxTrail * 4);
  for (let i = 0; i < maxTrail; i++) trail[i * 4 + 2] = DEAD_AGE;

  const current = { u: 0, v: 0, active: false };
  const velocity = { u: 0, v: 0 };

  let evtTime = -1e9;                              // time of the latest move/down event
  let prevU = 0, prevV = 0, prevTime = 0;          // last event used for the velocity estimate
  let sampleU = 0, sampleV = 0, sampleTime = -1e9; // last recorded trail sample
  let moved = false;                               // a move happened since the last sample
  let writeIndex = 0;

  function onMove(e) {
    const uv = toImageUV(e.clientX, e.clientY);
    const u = uv[0], v = uv[1];
    const t = performance.now();
    if (!current.active) {
      // (Re)entering: the previous position is stale, so it yields neither a
      // velocity spike nor a trail sample for the jump.
      current.active = true;
      prevU = sampleU = u;
      prevV = sampleV = v;
      prevTime = sampleTime = t;
      velocity.u = 0;
      velocity.v = 0;
    } else {
      const dts = (t - prevTime) / 1000;
      if (dts >= MIN_EVENT_DT) {
        velocity.u += ((u - prevU) / dts - velocity.u) * VEL_ALPHA;
        velocity.v += ((v - prevV) / dts - velocity.v) * VEL_ALPHA;
        prevU = u;
        prevV = v;
        prevTime = t;
      }
    }
    current.u = u;
    current.v = v;
    evtTime = t;
    moved = true;
  }

  function onLeave() {
    current.active = false;
    moved = false;
  }

  function onOut(e) {
    // pointerleave does not bubble, so a pointer leaving the viewport (or a lifted
    // touch) is also detected through pointerout with no relatedTarget.
    if (e.relatedTarget === null) onLeave();
  }

  const opts = { passive: true };
  const hasWindow = typeof window !== 'undefined';
  if (hasWindow) {
    window.addEventListener('pointermove', onMove, opts);
    window.addEventListener('pointerdown', onMove, opts);
    window.addEventListener('pointerleave', onLeave, opts);
    window.addEventListener('pointercancel', onLeave, opts);
    window.addEventListener('pointerout', onOut, opts);
  }

  function update(dt, now) {
    // Velocity decays once events stop arriving (pointer resting or gone).
    if (now - evtTime > IDLE_MS) {
      const k = Math.exp(-dt * IDLE_DECAY);
      velocity.u *= k;
      velocity.v *= k;
      if (velocity.u * velocity.u + velocity.v * velocity.v < 1e-10) {
        velocity.u = 0;
        velocity.v = 0;
      }
    }

    // Age live samples, retire the expired ones.
    for (let i = 2; i < trail.length; i += 4) {
      if (trail[i + 1] > 0) {
        trail[i] += dt;
        if (trail[i] > TRAIL_LIFE) {
          trail[i] = DEAD_AGE;
          trail[i + 1] = 0;
        }
      }
    }

    if (!current.active || !moved) return;

    const du = current.u - sampleU;
    const dv = current.v - sampleV;
    const speed = Math.sqrt(velocity.u * velocity.u + velocity.v * velocity.v);
    const farEnough = du * du + dv * dv > SAMPLE_DIST * SAMPLE_DIST;
    const slowButMoving = now - sampleTime >= SAMPLE_PERIOD && speed > MOVING_SPEED;
    if (!farEnough && !slowButMoving) return;

    const o = writeIndex * 4;
    trail[o] = current.u;
    trail[o + 1] = current.v;
    trail[o + 2] = 0;
    trail[o + 3] = Math.min(Math.max(speed / 0.9, 0.15), 1);
    writeIndex = (writeIndex + 1) % maxTrail;
    sampleU = current.u;
    sampleV = current.v;
    sampleTime = now;
    moved = false;
  }

  function destroy() {
    if (hasWindow) {
      window.removeEventListener('pointermove', onMove, opts);
      window.removeEventListener('pointerdown', onMove, opts);
      window.removeEventListener('pointerleave', onLeave, opts);
      window.removeEventListener('pointercancel', onLeave, opts);
      window.removeEventListener('pointerout', onOut, opts);
    }
    current.active = false;
  }

  return { update, trail, current, velocity, maxTrail, destroy };
}
