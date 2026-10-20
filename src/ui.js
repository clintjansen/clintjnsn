/**
 * ui.js — the two DOM pieces over the WebGL canvas:
 * the black-and-white loader and the frosted "JNSN" card.
 *
 * Nothing here touches the DOM at import time; main.js calls the factories.
 */

import { spring } from './spring.js';
import { logoSVG } from './logo.js';

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp01 = (n) => (n > 1 ? 1 : n > 0 ? n : 0); // NaN falls through to 0
const halfPx = (n) => (Number.isFinite(n) ? Math.round(n * 2) / 2 : 0); // crisp text on a 0.5px grid

/* ---------- loader ---------- */

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
      }, reducedMotion() ? 0 : 480);
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

    // Opacity is slightly over-damped-ish (no visible flash past 1); scale and
    // rise share a softer spring so the card lands with a hint of overshoot.
    springs = [
      spring({
        from: 0, to: 1, stiffness: 120, damping: 20,
        onUpdate: (v) => setVar('--card-opacity', clamp01(v)),
      }),
      spring({
        from: 0.94, to: 1, stiffness: 150, damping: 18,
        onUpdate: (v) => setVar('--card-scale', v),
      }),
      spring({
        from: 10, to: 0, stiffness: 150, damping: 18,
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
