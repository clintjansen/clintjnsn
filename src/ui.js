/**
 * ui.js — the DOM pieces over the WebGL canvas:
 * the loader box, the "JNSN" stamp card and the four corner HUD readouts.
 *
 * Nothing here touches the DOM at import time; main.js calls the factories.
 */

import { spring } from './spring.js';
import { logoSVG } from './logo.js';

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp01 = (n) => (n > 1 ? 1 : n > 0 ? n : 0); // NaN falls through to 0
const halfPx = (n) => (Number.isFinite(n) ? Math.round(n * 2) / 2 : 0); // crisp text on a 0.5px grid

/**
 * A textContent writer that remembers the last string it wrote and skips repeats.
 * The HUD setters and the loader run every frame; the DOM must only change when the text does.
 */
function textSink(el) {
  let last = null;
  return (text) => {
    if (text === last) return;
    last = text;
    if (el) el.textContent = text;
  };
}

/* ---------- loader ---------- */

const LOADER_FADE_MS = 360; // just past #loader's 0.35s opacity transition

export function createLoader() {
  const root = document.getElementById('loader');
  const digits = root?.querySelector('.loader__digits');
  const fill = root?.querySelector('.loader__rule > i');
  const status = root?.querySelector('#loader-status');
  let shown = -1; // last percentage written to the DOM
  let hiding = null; // the hide() promise, shared by repeat calls

  function set(p) {
    const pct = Math.round(clamp01(Number(p)) * 100);
    if (pct === shown) return; // called every frame: skip when nothing changed
    shown = pct;
    if (digits) digits.textContent = String(pct);
    if (fill) fill.style.width = pct + '%';
  }

  function hide() {
    if (hiding) return hiding;
    hiding = new Promise((resolve) => {
      if (!root) return resolve();
      root.classList.add('is-done');
      if (status) status.textContent = 'Loaded';
      setTimeout(() => {
        root.classList.add('is-hidden');
        resolve();
      }, reducedMotion() ? 0 : LOADER_FADE_MS);
    });
    return hiding;
  }

  return { set, hide };
}

/* ---------- card ---------- */

const FADE_OUT_MS = 260; // slightly longer than .card.is-leaving's 0.25s transition

export function createCard() {
  const el = document.getElementById('card');
  const logoHost = el?.querySelector('.card__logo');
  if (logoHost) {
    logoHost.innerHTML = logoSVG;
    logoHost.setAttribute('aria-hidden', 'true'); // the <h1> already carries the name
  }

  let visible = false;
  let springs = [];
  let leaveTimer = 0;

  const setVar = (name, value) => el.style.setProperty(name, String(value));

  function stopSprings() {
    for (const s of springs) s.stop();
    springs = [];
  }

  function layout({ x, y, w, h }) {
    if (!el) return;
    setVar('--card-x', halfPx(x));
    setVar('--card-y', halfPx(y));
    setVar('--card-w', halfPx(w));
    setVar('--card-h', halfPx(h));
  }

  function rest() {
    setVar('--card-opacity', 1);
    setVar('--card-scale', 1);
    setVar('--card-rise', 0);
  }

  function show() {
    if (!el || visible) return;
    visible = true;
    clearTimeout(leaveTimer);
    stopSprings();
    el.classList.remove('is-leaving');
    el.classList.add('is-visible');

    if (reducedMotion()) {
      rest();
      return;
    }

    // Snappy: opacity is close to critically damped (no flash past 1); scale and
    // rise share a slightly livelier spring so the card lands with a hint of overshoot.
    springs = [
      spring({
        from: 0, to: 1, stiffness: 220, damping: 24,
        onUpdate: (v) => setVar('--card-opacity', clamp01(v)),
      }),
      spring({
        from: 0.97, to: 1, stiffness: 240, damping: 22,
        onUpdate: (v) => setVar('--card-scale', v),
      }),
      spring({
        from: 6, to: 0, stiffness: 240, damping: 22,
        onUpdate: (v) => setVar('--card-rise', v),
      }),
    ];
  }

  function hide() {
    if (!el || !visible) return;
    visible = false;
    stopSprings();

    if (reducedMotion()) {
      setVar('--card-opacity', 0);
      el.classList.remove('is-visible');
      return;
    }

    el.classList.add('is-leaving'); // turns on the CSS opacity transition
    setVar('--card-opacity', 0);
    leaveTimer = setTimeout(() => {
      el.classList.remove('is-leaving', 'is-visible');
    }, FADE_OUT_MS);
  }

  return { el, layout, show, hide };
}

/* ---------- hud ---------- */

const NO_READING = '\u2014'; // em dash: the pointer is off the canvas / not finite

const coord = (n) => (Number.isFinite(n) ? clamp01(n).toFixed(3) : NO_READING);
const whole = (n) => (Number.isFinite(n) ? String(Math.round(n)) : '0');

/**
 * The four corner readouts. Only three are live: #hud-xy, #hud-stats and #hud-phase
 * (the top-left "JNSN" is static). Every setter is safe to call per frame.
 */
export function createHud() {
  const writeXY = textSink(document.getElementById('hud-xy'));
  const writeStats = textSink(document.getElementById('hud-stats'));
  const writePhase = textSink(document.getElementById('hud-phase'));

  /** Pointer in image uv, 0..1: "X 0.512 / Y 0.233"; a non-finite axis prints as an em dash. */
  function setPointer(u, v) {
    writeXY('X ' + coord(u) + ' / Y ' + coord(v));
  }

  /** "24 FPS / 1920 x 1080": frame rate and the canvas size in CSS px (all rounded). */
  function setStats(fps, w, h) {
    writeStats(whole(fps) + ' FPS / ' + whole(w) + ' x ' + whole(h));
  }

  /** The state label, always upper-case: LOADING, HOLD, REVEAL, LIVE, ... */
  function setPhase(text) {
    writePhase(String(text ?? '').toUpperCase());
  }

  return { setPointer, setStats, setPhase };
}
