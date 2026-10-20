/**
 * Fixed-rate render loop on requestAnimationFrame.
 *
 * - Renders at most `fps` times per second (fps <= 0 = every rAF), drift-corrected so
 *   the cadence stays anchored instead of sliding against the display refresh.
 * - onFrame(dt, elapsed, now): dt = seconds since the previous rendered frame, clamped to
 *   0..0.1; elapsed = seconds of rendered time (frozen while hidden or stopped);
 *   now = the rAF timestamp in ms (performance.now() clock), pass it to pointer.update().
 * - Pauses while the document is hidden and resumes with dt = 0, so nothing jumps.
 * - onDrop(ratio, avgFrameMs, frames): every 2 s, the fraction of rendered frames slower than
 *   1.6x the target interval (1.6x 16.7 ms when uncapped) and how many frames the window had;
 *   use it to lower resolution (and ignore windows with few frames: that is throttling, not load).
 */

const MAX_DT = 0.1;              // s, cap so a stalled frame does not leap the animation
const DROP_WINDOW = 1000 * 2;    // ms, reporting period of onDrop
const DROP_FACTOR = 1.6;
const UNCAPPED_TARGET = 1000 / 60;

export function createLoop({ fps = 24, onFrame = () => {}, onDrop } = {}) {
  let interval = fps > 0 ? 1000 / fps : 0;
  let running = false;
  let rafId = 0;
  let last = -1;            // cadence anchor (ms); -1 = next tick is a fresh start (dt 0)
  let lastRendered = 0;     // timestamp of the previous rendered frame
  let elapsed = 0;
  let statStart = 0, statFrames = 0, statDropped = 0, statMs = 0;

  function tick(now) {
    if (!running) return;
    rafId = requestAnimationFrame(tick);

    if (last < 0) {
      // First frame after start()/resume: anchor the clocks and render without a jump.
      last = now;
      lastRendered = now;
      statStart = now;
      statFrames = statDropped = statMs = 0;
      onFrame(0, elapsed, now);
      return;
    }

    if (interval > 0) {
      let since = now - last;
      if (since < interval - 1) return;
      // A frame inside the 1 ms tolerance counts as a whole interval; otherwise the
      // modulo below would leave `last` untouched and the very next rAF would render too.
      if (since < interval) since = interval;
      last = now - (since % interval);
    }

    const frameMs = now - lastRendered;
    lastRendered = now;
    const dt = Math.min(Math.max(frameMs / 1000, 0), MAX_DT);
    elapsed += dt;
    onFrame(dt, elapsed, now);

    if (!onDrop) return;
    statFrames++;
    statMs += frameMs;
    if (frameMs > DROP_FACTOR * (interval || UNCAPPED_TARGET)) statDropped++;
    if (now - statStart >= DROP_WINDOW) {
      onDrop(statDropped / statFrames, statMs / statFrames, statFrames);
      statStart = now;
      statFrames = statDropped = statMs = 0;
    }
  }

  function onVisibility() {
    if (!running) return;
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      // Keep the clock small so fp32 shader time stays precise; every visible use of the
      // time is a scroll or a phase, and nobody sees the wrap while the tab is hidden.
      elapsed = elapsed % 3600;
    } else if (!rafId) {
      last = -1; // re-anchor so the hidden time does not show up as a dt
      rafId = requestAnimationFrame(tick);
    }
  }

  function start() {
    if (running) return;
    if (typeof requestAnimationFrame !== 'function') return; // no browser to drive (SSR / node)
    running = true;
    last = -1;
    const hasDoc = typeof document !== 'undefined';
    if (hasDoc) document.addEventListener('visibilitychange', onVisibility);
    if (!hasDoc || !document.hidden) rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (!running) return;
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  }

  function setFps(n) {
    interval = n > 0 ? 1000 / n : 0;
  }

  return {
    start,
    stop,
    setFps,
    get running() { return running; },
    get fps() { return interval > 0 ? 1000 / interval : 0; },
    get elapsed() { return elapsed; },
  };
}
