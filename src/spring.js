/**
 * spring.js — a damped spring integrated with requestAnimationFrame.
 *
 * Pure: touches nothing but rAF and performance.now(). Semi-implicit Euler on
 * a fixed 1/120 s substep, so the motion is identical at 24, 60 or 144 Hz and
 * a backgrounded tab catches up on at most 64 ms instead of exploding.
 */

const STEP = 1 / 120; // s per substep
const MAX_DT = 0.064; // s, longest frame we are willing to simulate
const EPS = 0.001; // settle threshold for |x - to| and |v|

export function spring({
  from = 0,
  to = 1,
  stiffness = 170,
  damping = 22,
  mass = 1,
  velocity = 0,
  onUpdate,
  onComplete,
} = {}) {
  let x = from;
  let v = velocity;
  let carry = 0; // simulated-time debt left over from the previous frame
  let last = performance.now();
  let raf = 0;
  let live = true;

  const invMass = 1 / Math.max(mass, 1e-6);

  // Velocity first, then position with the *new* velocity. Explicit Euler
  // gains energy on stiff springs; the semi-implicit form stays stable.
  function substep() {
    const a = (-stiffness * (x - to) - damping * v) * invMass;
    v += a * STEP;
    x += v * STEP;
  }

  function settled() {
    return Math.abs(x - to) < EPS && Math.abs(v) < EPS;
  }

  function finish() {
    live = false;
    raf = 0;
    onUpdate?.(to); // snap exactly onto the target
    onComplete?.();
  }

  function tick(now) {
    if (!live) return;
    carry += Math.min(Math.max(0, now - last) / 1000, MAX_DT);
    last = now;
    while (carry >= STEP) {
      substep();
      carry -= STEP;
      if (settled()) break;
    }
    if (settled()) {
      finish();
      return;
    }
    onUpdate?.(x);
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (!live) return;
    live = false;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  // Apply the start value synchronously so no frame shows a stale value.
  onUpdate?.(x);
  // Even an already-settled spring completes on a later frame, so onComplete
  // can never fire before spring() has returned its handle.
  raf = requestAnimationFrame(settled() ? () => live && finish() : tick);

  return { stop };
}
