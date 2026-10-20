/**
 * main.js — boot sequence and the per-frame glue.
 *
 *   flat red + counter (counts while the textures download, never ahead of them)
 *   -> magma spreads from the centre, coupled to the %  ->  100%
 *   -> loader fades  ->  artwork fades in with a soft wave  ->  the glass card springs in
 */

import '@fontsource/syne/800.css';
import '@fontsource/jetbrains-mono/500.css';
import { config } from './config.js';
import { createLoader, createCard } from './ui.js';
import { createPointer } from './input.js';
import { createLoop } from './loop.js';
import { createSignals, easeInOutCubic } from './signals.js';
import { loadTextures, createScene, TEXTURE_COUNT } from './scene.js';
import meta from './tex/meta.json';

const TAU = Math.PI * 2;
const canvas = document.getElementById('gl');
const loader = createLoader();
const card = createCard();
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---------------------------------------------------------------- state machine

const State = { LOADING: 0, HOLD: 1, REVEAL: 2, LIVE: 3 };
let state = State.LOADING;
let stateT = 0;          // seconds in the current state
let assetsReady = false;
let filesDone = 0;
let shown = 0;           // the percentage the viewer sees, 0..1 (monotonic)
let disc = 0;            // magma disc actually drawn: eases towards `shown`, so it never pops in
let scene = null;
let pointer = null;
let signals = createSignals({ seed: 7 });
let loop = null;
let cardShown = false;
let motion = 1;          // 0 under prefers-reduced-motion: no bob / glance / wave

// The fox: where its face is (image uv), how upset it is, and its glow pulse phase.
const FOX_FACE = { u: 0.64, v: 0.15 };
let foxUpset = 0;
let foxPhase = 0;

function enter(next) {
  state = next;
  stateT = 0;
}

// ---------------------------------------------------------------- layout

function viewportSize() {
  return { w: window.innerWidth, h: window.innerHeight };
}

/** Place the frosted card over the character's eyes, following the artwork's own card rect. */
function layoutCard() {
  if (!scene) return;
  const { w: vw, h: vh } = viewportSize();
  const [cx0, cy0, cx1, cy1] = meta.card;
  const [x0, y0] = scene.cover.imageToScreen(cx0, cy0);
  const [x1, y1] = scene.cover.imageToScreen(cx1, cy1);
  const mappedW = x1 - x0;
  const mappedH = y1 - y0;
  const gutter = vw * 0.04;
  const maxW = vw - gutter * 2;
  let w = mappedW;
  let h = mappedH;
  let x = x0;
  if (mappedW > maxW) {
    // Narrow viewport: shrink the width hard and the height gently so the eyes stay covered.
    w = maxW;
    h = mappedH * Math.sqrt(w / mappedW);
    x = (vw - w) / 2;
  }
  let y = y0 + (mappedH - h) / 2;
  // The focal crop can push the mapped rect past an edge on in-between aspect ratios.
  x = Math.min(Math.max(x, gutter), vw - w - gutter);
  y = Math.min(Math.max(y, 0), Math.max(0, vh - h));
  card.layout({ x, y, w, h });
}

let dprQuery = null;
/** Re-arm a media query that fires when the window moves to a display with another scale factor. */
function watchDpr(onChange) {
  dprQuery?.removeEventListener('change', onChange);
  dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  dprQuery.addEventListener('change', onChange, { once: true });
}

// ---------------------------------------------------------------- motion preference

/** Honour prefers-reduced-motion: the magma still flows, but at a crawl, and the character rests. */
function applyMotionPreference() {
  const reduce = reduceMotion.matches;
  motion = reduce ? 0 : 1;
  loop?.setFps(reduce ? Math.min(config.fps || 12, 12) : config.fps);
  if (!scene) return;
  const u = scene.uniforms;
  u.uFlowSpeed.value = config.art.flowSpeed * (reduce ? 0.15 : 1);
  u.uWarpSpeed.value = config.art.warpSpeed * (reduce ? 0.15 : 1);
  u.uFlameAmount.value = reduce ? Math.min(0.3, config.art.flameAmount) : config.art.flameAmount;
}

// ---------------------------------------------------------------- adaptive resolution

let failedScale = Infinity; // the scale that last dropped frames: never climb back to it
let healthyWindows = 0;

function onDrop(ratio, avgMs, frames) {
  // A window with very few frames is a throttled background tab, not a slow GPU.
  if (!scene || frames < 12) return;
  const budget = config.fps > 0 ? 1000 / config.fps : 1000 / 60;
  if (ratio > 0.3) {
    failedScale = scene.renderScale;
    healthyWindows = 0;
    scene.setRenderScale(scene.renderScale * 0.85);
  } else if (avgMs < 0.7 * budget && scene.renderScale < config.renderScale) {
    // Step back up only after two healthy windows, and never onto the scale that failed.
    healthyWindows++;
    if (healthyWindows >= 2 && scene.renderScale * 1.1 < failedScale * 0.95) {
      healthyWindows = 0;
      scene.setRenderScale(scene.renderScale * 1.1);
    }
  } else {
    healthyWindows = 0;
  }
}

// ---------------------------------------------------------------- boot

async function boot() {
  // The loop (and the counter) starts right away; frames are DOM-only until the textures land.
  loop = createLoop({ fps: config.fps, onFrame: frame, onDrop });
  applyMotionPreference();
  reduceMotion.addEventListener('change', applyMotionPreference);
  loop.start();

  const textures = await loadTextures(() => { filesDone++; });
  scene = createScene({ canvas, textures, meta });
  applyMotionPreference();

  pointer = createPointer({
    toImageUV: (x, y) => scene.cover.screenToImage(x, y),
  });

  const onResize = () => {
    const { w, h } = viewportSize();
    scene.resize(w, h);
    layoutCard();
    watchDpr(onResize);
  };
  onResize();
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); loop.stop(); });
  canvas.addEventListener('webglcontextrestored', () => loop.start());

  assetsReady = true;
  if (config.skipLoader) {
    shown = 1;
    disc = 1;
    loader.hide();
    enter(State.LIVE);
    scene.uniforms.uReveal.value = 1;
    showCard();
  }
  // Draw the current state at once so the canvas never presents an unrendered (black) buffer.
  scene.setLoad(disc);
  scene.render(loop.elapsed);

  installDebugHook();
}

async function showCard() {
  if (cardShown) return;
  cardShown = true;
  // Wait for the wordmark font (bounded), so the card never flashes a fallback face.
  const fontLoad = document.fonts?.load ? document.fonts.load('800 1em "Syne"') : Promise.resolve();
  await Promise.race([fontLoad.catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  card.show();
}

// ---------------------------------------------------------------- per frame

function frame(dt, elapsed, now) {
  stateT += dt;

  if (state === State.LOADING) {
    // A time ramp that can never outrun the real downloads.
    const ramp = Math.min(1, stateT / config.loader.minDuration);
    const organic = ramp - 0.045 * Math.sin(ramp * TAU * 1.5) * (1 - ramp);  // breathes a little
    const cap = assetsReady ? 1 : 0.08 + 0.8 * (filesDone / TEXTURE_COUNT);
    shown = Math.max(shown, Math.min(1, Math.min(organic, cap)));
    loader.set(shown);
    if (shown >= 1) enter(State.HOLD);
  } else if (state === State.HOLD) {
    shown = 1;
    loader.set(1);
    if (stateT >= config.loader.holdAt100) {
      loader.hide();
      enter(State.REVEAL);
    }
  }

  if (!scene) return; // DOM-only until the textures are in

  const u = scene.uniforms;
  if (state <= State.HOLD) {
    disc += (shown - disc) * Math.min(1, dt * 6);
    scene.setLoad(disc);
  } else {
    scene.setLoad(1);
  }

  if (state === State.REVEAL) {
    const k = Math.min(1, stateT / config.loader.revealDuration);
    u.uReveal.value = easeInOutCubic(k);
    u.uWaveT.value = motion ? stateT : 100;
    if (stateT >= config.loader.cardDelay) showCard();
    if (k >= 1) enter(State.LIVE);
  } else if (state === State.LIVE) {
    u.uReveal.value = 1;
    u.uWaveT.value = Math.min(100, stateT + config.loader.revealDuration);
  }

  // Character life + pointer
  signals.update(dt, elapsed);
  pointer.update(dt, now);
  u.uTurn.value = signals.turn * motion;
  u.uBreath.value = signals.breath;
  u.uBob.value.set(signals.bob.x * motion, signals.bob.y * motion);
  u.uLightAngle.value = signals.lightAngle % TAU;
  u.uFlare.value = signals.flare;
  u.uPointer.value.set(pointer.current.u, pointer.current.v);
  // A flick of the hand is a gust, not a hurricane: bound the velocity the shader sees.
  const aspect = meta.width / meta.height;
  const vm = Math.hypot(pointer.velocity.u * aspect, pointer.velocity.v);
  const vk = vm > 1.2 ? 1.2 / vm : 1;
  u.uPointerVel.value.set(pointer.velocity.u * vk, pointer.velocity.v * vk);
  u.uPointerOn.value = pointer.current.active ? 1 : 0;

  // The fox sneakily watches the hand: on its own schedule, and always when it comes close.
  const fdx = (pointer.current.u - FOX_FACE.u) * aspect;
  const fdy = pointer.current.v - FOX_FACE.v;
  const fd = Math.hypot(fdx, fdy);
  const near = pointer.current.active ? Math.exp(-(fd * fd) / (0.24 * 0.24)) : 0;
  const attention = Math.max(signals.foxAttention, Math.min(1, near * 1.6)) * (pointer.current.active ? 1 : 0);
  // upset rises quickly when the hand is close and calms down slowly
  const upsetTarget = Math.min(1, near * 1.2);
  foxUpset += (upsetTarget - foxUpset) * Math.min(1, dt * (upsetTarget > foxUpset ? 5 : 1.2));
  const gx = fd > 1e-4 ? fdx / fd : 0;
  const gy = fd > 1e-4 ? fdy / fd : 0;
  u.uFoxLook.value.set(gx, gy, attention, foxUpset);
  foxPhase += dt * (0.55 + 2.6 * foxUpset);
  u.uFoxPhase.value = foxPhase % TAU;
  // uTrail shares the pointer's Float32Array; three re-uploads it every frame.
  if (u.uTrail.value !== pointer.trail) u.uTrail.value = pointer.trail;

  scene.render(elapsed);
}

// ---------------------------------------------------------------- debug hook

// Render any state on demand (tuning + automated screenshots). Both helpers stop the loop;
// call __jnsn.resume() to hand control back.
//   __jnsn.preview({ load: 0.4 })   loader at 40%
//   __jnsn.live(12)                 the finished scene 12 s in
function installDebugHook() {
  const hook = {
    scene, pointer, loop, config, meta,
    get signals() { return signals; },
    preview({ load = 1, reveal = 0, wave = 100, time = 0 } = {}) {
      loop.stop();
      scene.setLoad(load);
      scene.uniforms.uReveal.value = reveal;
      scene.uniforms.uWaveT.value = wave;
      scene.render(time);
    },
    live(time = 10, { turn, pointerUV } = {}) {
      loop.stop();
      shown = 1;
      disc = 1;
      loader.hide();
      enter(State.LIVE);
      showCard();
      const fresh = createSignals({ seed: 7 });
      for (let t = 0; t < time; t += 1 / 24) fresh.update(1 / 24, t);
      signals = fresh;
      if (pointerUV) { pointer.current.u = pointerUV[0]; pointer.current.v = pointerUV[1]; pointer.current.active = true; }
      frame(1 / 24, time, performance.now());
      if (turn !== undefined) { scene.uniforms.uTurn.value = turn; scene.render(time); }
    },
    resume() {
      scene.setLoad(1);
      loop.start();
    },
  };
  if (import.meta.env.DEV) {
    // Dev only: post the current canvas to a local capture server (see the README).
    hook.capture = async (name = 'capture', quality = 0.9) => {
      const data = canvas.toDataURL('image/jpeg', quality);
      const r = await fetch(`http://localhost:5199/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: data });
      return r.text();
    };
  }
  window.__jnsn = hook;
}

boot().catch((err) => {
  console.error('JNSN failed to start', err);
  // Leave the red page and the wordmark: hide the counter, show the card as plain UI.
  loader.hide();
  card.layout({ x: window.innerWidth * 0.1, y: window.innerHeight * 0.4, w: window.innerWidth * 0.8, h: window.innerHeight * 0.2 });
  card.show();
});
