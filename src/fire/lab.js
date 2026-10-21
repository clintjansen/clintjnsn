/**
 * lab.js — tools/fire-lab.html: the fluid fire on the real avatar.
 *
 * Ortho camera over the whole backdrop (world X 0..1.648, Y 0..1, contain fit), a backdrop
 * that approximates the reference (or the reference itself, ?bg=ref), the avatar's skinned mesh
 * (src/avatar/, read-only use: lit by the fire through fire.sampling, and its depth pass feeds
 * the fire's occlusion exactly like src/scene.js), a scripted life like the page's (breath,
 * bob, sway, a glance towards the viewer driven by the page's critically damped spring) and a
 * scripted pointer sweep through the flames. The fire starts from the page's config.fireParams
 * (?pageparams=0: the module's DEFAULT_PARAMS).
 *
 * Script (lab time, s): first glance at 9 (hold 4, then back), every 12 s; pointer sweep at 16.5,
 * every 12 s. Handy capture times: rest 8.9, mid-turn 9.7, turn hold 11.0 / 12.5, sweep 17.3.
 *
 * window.__fireLab = { step(n), stepTo(t), render(), capture(name), shots(prefix, times),
 *                      setParam(k, v), timings(n), pose(yaw, pitch), ... }
 * Stepping is deterministic: fixed dt (1/30 s), lab time drives every animation.
 * Debug views: setParam('debug', 1 | 2 | 3) = raw fuel, fuel age, tongue phase (warm/cool).
 * timings(n) is async and advances the simulation by 2n frames.
 */

import * as THREE from 'three';
import { createFire } from './fire.js';
import { config } from '../config.js';
import { createNoiseTexture } from '../noise.js';
import { loadAvatarBuffer, createAvatar } from '../avatar/avatar.js';

const qs = new URLSearchParams(location.search);
const TAU = Math.PI * 2;
const IMG_W = 1383 / 839; // backdrop width in world units (image heights)
const DT = 1 / 30;
const BOUNDS_MIN = new THREE.Vector3(...config.fireBox.min);
const BOUNDS_MAX = new THREE.Vector3(...config.fireBox.max);
if (qs.get('boxz')) {   // ?boxz=-0.36,0.5: try another depth range for the box
  const [z0, z1] = qs.get('boxz').split(',').map(Number);
  if (Number.isFinite(z0) && Number.isFinite(z1) && z1 > z0) { BOUNDS_MIN.z = z0; BOUNDS_MAX.z = z1; }
}
// reference2 pixel (x2, y2) -> world ((x2 / 1.388 - 39) / 839, 1 - (y2 / 1.388) / 839)
const REF = { k: 1.388, ox: 39, ih: 839 };

const lab = {
  motion: 1,        // breath, bob, idle sway
  turn: 1,          // the scripted glance towards the viewer
  turnAmount: 1,    // 0..1 of the page's full glance (yaw ~0.5 rad)
  pointer: 1,       // scripted pointer sweeps
  intensity: 1,
  occlusion: 1,     // pass the avatar depth to the fire
  bg: qs.get('bg') || 'proc', // proc | ref | black
  refOpacity: 0.4,
  showHead: 1,
  showFire: 1,
  showCap: 0,       // debug: the scalp ellipsoid coloured by the emitter cap (green in, red out)
  yaw: null,        // manual pose override (radians), null = scripted
  pitch: null,
};

// ------------------------------------------------------------------ renderer + camera
const canvas = document.getElementById('gl');
const hud = document.getElementById('hud');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
const gl = renderer.getContext();

const camera = new THREE.OrthographicCamera(0, IMG_W, 1, 0, 0.5, 6);
camera.position.set(0, 0, 3);

const quality = qs.get('quality') || config.fireBox.quality || 'high';
const grid = qs.get('grid') ? qs.get('grid').split('x').map(Number) : config.fireBox.grid;
const usePageParams = qs.get('pageparams') !== '0';
const fire = createFire(renderer, {
  boundsMin: BOUNDS_MIN,
  boundsMax: BOUNDS_MAX,
  grid,
  quality,
  params: usePageParams ? config.fireParams : {},
});

const depthRT = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: true, stencilBuffer: false });
depthRT.depthTexture = new THREE.DepthTexture(2, 2);

// ------------------------------------------------------------------ backdrop
const bgMaterial = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  depthTest: false,
  depthWrite: false,
  uniforms: {
    uView: { value: new THREE.Vector4(0, 0, IMG_W, 1) },
    uRef: { value: null },
    uRefRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uRefOpacity: { value: 0 },
    uMode: { value: 0 },
    uImgW: { value: IMG_W },
  },
  vertexShader: /* glsl */ `
    precision highp float;
    in vec3 position;
    out vec2 vNdc;
    void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform vec4 uView;
    uniform sampler2D uRef;
    uniform vec4 uRefRect;
    uniform float uRefOpacity;
    uniform int uMode;
    uniform float uImgW;
    in vec2 vNdc;
    layout(location = 0) out vec4 fragColor;
    void main() {
      vec2 w = uView.xy + (vNdc * 0.5 + 0.5) * uView.zw;
      vec3 col;
      if (uMode == 2) {
        col = vec3(0.0);
      } else {
        vec3 red = vec3(0.86, 0.23, 0.11);
        vec3 redDeep = vec3(0.66, 0.12, 0.07);
        float stripes = 0.5 + 0.5 * sin((w.x * 0.8 + w.y * 1.3 + 0.06 * sin(w.y * 9.0 + w.x * 4.0)) * 115.0);
        col = mix(red, redDeep, stripes * 0.4);
        float pale = smoothstep(1.02, 1.24, w.x + 0.28 * (w.y - 0.3))
                   * (1.0 - smoothstep(0.66, 0.90, w.y - 0.1 * (w.x - 1.2)))
                   * (1.0 - smoothstep(1.50, 1.62, w.x));
        vec3 peach = mix(vec3(0.98, 0.87, 0.76), vec3(0.80, 0.90, 0.97), smoothstep(1.22, 1.45, w.x) * 0.7);
        col = mix(col, peach, pale);
        vec2 ruv = (w - uRefRect.xy) / uRefRect.zw;
        if (uMode == 1 && ruv.x >= 0.0 && ruv.y >= 0.0 && ruv.x <= 1.0 && ruv.y <= 1.0) {
          col = mix(col, texture(uRef, ruv).rgb, uRefOpacity);
        }
        if (w.x < 0.0 || w.x > uImgW || w.y < 0.0 || w.y > 1.0) col *= 0.22;
      }
      fragColor = vec4(col, 1.0);
    }
  `,
});
const bgScene = new THREE.Scene();
const bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMaterial);
bgMesh.frustumCulled = false;
bgScene.add(bgMesh);

new THREE.TextureLoader().load('/tools/reference2.webp', (tex) => {
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const W = tex.image.width / REF.k / REF.ih;
  const H = tex.image.height / REF.k / REF.ih;
  bgMaterial.uniforms.uRef.value = tex;
  bgMaterial.uniforms.uRefRect.value.set(-REF.ox / REF.ih, 1 - H, W, H);
  if (!running && avatar) drawFrame();
});

// ------------------------------------------------------------------ the avatar (src/avatar/, read-only)
const noise = createNoiseTexture();
const world = new THREE.Scene();
let avatar = null;

const compScene = new THREE.Scene();
compScene.add(fire.compositeMesh);

// pointer marker, drawn over everything
const overlayScene = new THREE.Scene();
const pointerRing = new THREE.Mesh(
  new THREE.RingGeometry(0.014, 0.019, 48),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
);
pointerRing.position.z = 1;
overlayScene.add(pointerRing);

// debug: the scalp ellipsoid, green where the emitter cap is (dot(dir, capDir) > capCos), red outside
const capMaterial = new THREE.ShaderMaterial({
  uniforms: { uCapDir: { value: new THREE.Vector3(0, 1, 0) }, uCapCos: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uCapDir;
    uniform float uCapCos;
    varying vec3 vDir;
    void main() {
      float c = dot(normalize(vDir), uCapDir);
      vec3 col = c > uCapCos ? vec3(0.1, 0.8, 0.2) : vec3(0.8, 0.1, 0.1);
      col *= 0.6 + 0.4 * smoothstep(0.0, 0.05, abs(c - uCapCos));
      gl_FragColor = vec4(col, 0.6);
    }
  `,
  transparent: true,
  depthTest: false,
  depthWrite: false,
});
const capMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), capMaterial);
capMesh.matrixAutoUpdate = false;
capMesh.frustumCulled = false;
const capScene = new THREE.Scene();
capScene.add(capMesh);

// ------------------------------------------------------------------ life script (like src/signals.js + src/main.js)
const ease = (x) => { x = Math.min(Math.max(x, 0), 1); return x * x * x * (x * (x * 6 - 15) + 10); };
const sway = (t, a, b, c) => (Math.sin(t * a) + 0.6 * Math.sin(t * b + 1.7) + 0.35 * Math.sin(t * c + 0.4)) / 1.95;
function springTo(state, target, omega, dt) {
  const x = state.x - target;
  const v = state.v;
  const e = Math.exp(-omega * dt);
  const c2 = v + omega * x;
  state.x = target + (x + c2 * dt) * e;
  state.v = (v - c2 * omega * dt) * e;
  return state.x;
}

const GLANCE = { first: 9, period: 12, hold: 4 };
/** Is the glance target on at lab time t? */
function glanceOn(t) {
  if (!lab.turn || t < GLANCE.first) return false;
  return ((t - GLANCE.first) % GLANCE.period) < GLANCE.hold;
}

const turnS = { x: 0, v: 0 };
const pitchS = { x: 0, v: 0 };
const poseState = { yaw: 0, pitch: 0, breath: 0, bobX: 0, bobY: 0 };
/** Advance the life signals to time t (after a step of dt) and fill poseState like main.js does. */
function lifeAt(t, dt) {
  const on = glanceOn(t);
  const turn = springTo(turnS, on ? lab.turnAmount : 0, on ? 2.6 : 1.7, dt);
  const lookPitch = springTo(pitchS, on ? 0.05 : 0, on ? 2.2 : 1.6, dt);
  const m = lab.motion;
  const yawSway = 0.07 * sway(t, 0.23, 0.41, 0.77) * m;
  const pitchSway = 0.035 * sway(t + 11.0, 0.19, 0.47, 0.83) * m;
  const headYaw = turn * 0.88 + yawSway;          // signals.js TURN_YAW
  const headPitch = lookPitch + pitchSway;
  const s = Math.sin(TAU * t / 4.8);
  poseState.yaw = lab.yaw ?? headYaw * 0.82;
  poseState.pitch = lab.pitch ?? headPitch + turn * 0.06;
  poseState.breath = s * Math.pow(Math.abs(s), 0.2) * (0.4 + 0.6 * m);
  poseState.bobX = 0.005 * sway(t + 3.0, 0.17, 0.29, 0.61) * IMG_W * m;
  poseState.bobY = -0.009 * sway(t + 7.0, 0.21, 0.37, 0.69) * m;
  poseState.turn = turn;
  return poseState;
}

/** Scripted pointer: a sweep over the head through the flames, at 16.5 s and every 12 s. */
const SWEEP = { first: 16.5, period: 12, dur: 1.6 };
function pointerAt(t, out) {
  out.active = false;
  if (!lab.pointer || t < SWEEP.first) return out;
  const u = ((t - SWEEP.first) % SWEEP.period) / SWEEP.dur;
  if (u > 1) return out;
  const s = ease(u);
  out.x = 0.20 + (1.32 - 0.20) * s;
  out.y = 0.78 + (0.96 - 0.78) * s + 0.07 * Math.sin(Math.PI * s);
  out.active = true;
  return out;
}

const ptr = { x: 0, y: 0, vx: 0, vy: 0, active: false };
const ptrPrev = { x: 0, y: 0, active: false };

let labTime = 0;
let frames = 0;

function advance(dt) {
  if (!avatar) return;
  const t0 = labTime;
  const t1 = labTime + dt;
  avatar.setPose(lifeAt(t1, dt));
  const frame = avatar.fireFrame(dt);
  pointerAt(t0, ptrPrev);
  pointerAt(t1, ptr);
  if (ptr.active && ptrPrev.active) {
    ptr.vx = (ptr.x - ptrPrev.x) / dt;
    ptr.vy = (ptr.y - ptrPrev.y) / dt;
  } else {
    ptr.vx = 0;
    ptr.vy = 0;
  }
  Object.assign(frame.pointer, ptr);
  frame.intensity = lab.intensity;
  fire.step(dt, frame);
  labTime = t1;
  frames++;
}

// ------------------------------------------------------------------ layout + drawing
let forced = qs.get('w') && qs.get('h') ? [Number(qs.get('w')), Number(qs.get('h'))] : null;
let size = [2, 2];

function layout() {
  const w = forced ? forced[0] : Math.max(2, window.innerWidth);
  const h = forced ? forced[1] : Math.max(2, window.innerHeight);
  size = [w, h];
  renderer.setSize(w, h, false);
  const s = Math.min(w / IMG_W, h); // pixels per world unit (contain)
  const vw = w / s;
  const vh = h / s;
  camera.left = IMG_W / 2 - vw / 2;
  camera.right = IMG_W / 2 + vw / 2;
  camera.bottom = 0.5 - vh / 2;
  camera.top = 0.5 + vh / 2;
  camera.updateProjectionMatrix();
  bgMaterial.uniforms.uView.value.set(camera.left, camera.bottom, vw, vh);
  depthRT.setSize(w, h);
  fire.setSize(w, h);
  if (avatar) {
    const periodPx = Math.min(18, Math.max(9, 11 * s / 839));
    avatar.uniforms.uLineFreq.value = s / periodPx;
  }
}

function drawFrame() {
  if (!avatar) return;
  const debugView = fire.params.debug > 0;
  bgMaterial.uniforms.uMode.value = debugView || lab.bg === 'black' ? 2 : lab.bg === 'ref' ? 1 : 0;
  bgMaterial.uniforms.uRefOpacity.value = lab.refOpacity;
  avatar.uniforms.uTime.value = labTime;
  const la = labTime * 0.1;
  avatar.uniforms.uKeyDir.value.set(Math.cos(la) * 0.7, 0.35 + Math.sin(la) * 0.45, 0.7).normalize();

  // the avatar's depth, so the fire stops at his skin (as in src/scene.js)
  renderer.autoClear = false;
  renderer.setRenderTarget(depthRT);
  renderer.clear(true, true, false);
  avatar.mesh.material = avatar.depthMaterial;
  renderer.render(world, camera);
  avatar.mesh.material = avatar.material;

  renderer.setRenderTarget(null);
  renderer.clear(true, true, false);
  renderer.render(bgScene, camera);
  if (lab.showHead && !debugView) renderer.render(world, camera);
  if (lab.showFire) {
    fire.render(camera, lab.occlusion ? depthRT.depthTexture : null, { near: camera.near, far: camera.far });
    renderer.render(compScene, camera);
  }
  pointerRing.visible = ptr.active && !debugView;
  pointerRing.position.x = ptr.x;
  pointerRing.position.y = ptr.y;
  if (lab.showCap) {
    const f = avatar.frame;
    capMesh.matrix.copy(fire._scalpCap || f.scalp).invert();
    capMesh.matrixWorld.copy(capMesh.matrix);
    capMaterial.uniforms.uCapDir.value.copy(f.scalpCapDir);
    capMaterial.uniforms.uCapCos.value = f.scalpCapCos;
    renderer.render(capScene, camera);
  }
  renderer.render(overlayScene, camera);
  renderer.autoClear = true;
}

// ------------------------------------------------------------------ loop
let running = !qs.has('paused');
let last = performance.now();
let fps = 0;
function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  if (!running || !avatar) return;
  fps = fps * 0.9 + (dt > 0 ? 1 / dt : 0) * 0.1;
  advance(dt);
  drawFrame();
  if (frames % 10 === 0) updateHud();
}

function updateHud(extra = '') {
  hud.textContent = `fire lab  t ${labTime.toFixed(2)} s  frame ${frames}  ${running ? `${fps.toFixed(0)} fps` : 'paused'}`
    + `  yaw ${poseState.yaw.toFixed(2)}\n`
    + `grid ${fire.info.grid.join('x')} (atlas ${fire.info.atlas.join('x')})  canvas ${size.join('x')}  quality ${quality}`
    + `  params ${usePageParams ? 'page' : 'module defaults'}`
    + (extra ? `\n${extra}` : '');
}

// ------------------------------------------------------------------ API
function rendererName() {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
}

const px = new Uint8Array(4);
function sync() {
  renderer.setRenderTarget(null);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
}

function renderFireOnly() {
  fire.render(camera, lab.occlusion ? depthRT.depthTexture : null, { near: camera.near, far: camera.far });
  renderer.setRenderTarget(null);
  renderer.autoClear = false;
  renderer.render(compScene, camera);
  renderer.autoClear = true;
}

const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

/** Per-pass GPU times (ms, averaged per frame) with timer queries; null when unavailable. */
async function gpuProfile(n) {
  if (!timerExt) return null;
  const records = [];
  let open = null;
  const begin = (name) => {
    if (open) gl.endQuery(timerExt.TIME_ELAPSED_EXT);
    open = gl.createQuery();
    gl.beginQuery(timerExt.TIME_ELAPSED_EXT, open);
    records.push({ name, q: open });
  };
  const end = () => { if (open) { gl.endQuery(timerExt.TIME_ELAPSED_EXT); open = null; } };
  gl.getParameter(timerExt.GPU_DISJOINT_EXT); // clear the flag
  for (let i = 0; i < n; i++) {
    fire._setPassHook(begin);
    advance(DT);
    fire.render(camera, lab.occlusion ? depthRT.depthTexture : null, { near: camera.near, far: camera.far });
    fire._setPassHook(null);
    begin('composite');
    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    renderer.render(compScene, camera);
    renderer.autoClear = true;
    end();
    await nextFrame();
  }
  for (let tries = 0; tries < 240; tries++) {
    if (records.every((r) => gl.getQueryParameter(r.q, gl.QUERY_RESULT_AVAILABLE))) break;
    await nextFrame();
  }
  if (gl.getParameter(timerExt.GPU_DISJOINT_EXT)) return { disjoint: true, step: null, render: null, passes: null };
  const passes = {};
  for (const r of records) {
    const ok = gl.getQueryParameter(r.q, gl.QUERY_RESULT_AVAILABLE);
    if (ok) passes[r.name] = (passes[r.name] || 0) + gl.getQueryParameter(r.q, gl.QUERY_RESULT) / 1e6;
    gl.deleteQuery(r.q);
  }
  let step = 0;
  let render = 0;
  for (const k of Object.keys(passes)) {
    passes[k] = +(passes[k] / n).toFixed(3);
    if (k === 'march' || k === 'composite') render += passes[k];
    else step += passes[k];
  }
  return { step: +step.toFixed(3), render: +render.toFixed(3), passes };
}

function resetLab() {
  fire.reset();
  labTime = 0;
  frames = 0;
  turnS.x = turnS.v = pitchS.x = pitchS.v = 0;
  if (avatar) {
    avatar.setPose(lifeAt(0, 0));
    avatar.fireFrame(0);   // re-prime the obstacle velocities at the rest pose
  }
}

async function capture(name = 'fire', type = 'jpeg') {
  drawFrame();
  const url = canvas.toDataURL(type === 'png' ? 'image/png' : 'image/jpeg', 0.92);
  const res = await fetch(`http://localhost:5199/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: url });
  return res.text();
}

const ready = loadAvatarBuffer().then((buffer) => {
  avatar = createAvatar(buffer, { noise, fireSampling: fire.sampling });
  avatar.uniforms.uReveal.value = 1;
  world.add(avatar.mesh);
  avatar.setPose();
  avatar.fireFrame(0);
  layout();
  drawFrame();
  updateHud();
  return true;
});

window.__fireLab = {
  fire,
  renderer,
  camera,
  lab,
  ready,
  get avatar() { return avatar; },
  get time() { return labTime; },
  get frames() { return frames; },
  get pose() { return { ...poseState }; },
  /** Advance n frames of fixed dt (1/30 s) without drawing; pauses the live loop. */
  step(n = 1, dt = DT) {
    running = false;
    for (let i = 0; i < n; i++) advance(dt);
    drawFrame();
    updateHud();
    return { time: labTime, frames };
  },
  /** Step (fixed dt) until lab time t. */
  stepTo(t, dt = DT) {
    running = false;
    while (labTime < t - 1e-6) advance(dt);
    drawFrame();
    updateHud();
    return { time: labTime, frames, yaw: poseState.yaw };
  },
  render() { drawFrame(); return { time: labTime, frames }; },
  play() { running = true; last = performance.now(); },
  pause() { running = false; },
  /** Clears the fluid and rewinds the lab clock (deterministic restarts). */
  reset() { resetLab(); drawFrame(); updateHud(); },
  /** Renders, then posts the canvas to the capture server; resolves to the written path. */
  capture,
  /**
   * Deterministic capture series: reset, then step to each time and capture `${prefix}_${label}`.
   * shots('v1') uses the default times: rest 8.9, mid 9.7, hold 11.0, hold2 12.5, sweep 17.3.
   */
  async shots(prefix = 'shot', times = { rest: 8.9, mid: 9.7, hold: 11.0, hold2: 12.5, sweep: 17.3 }) {
    running = false;
    resetLab();
    const out = {};
    for (const [label, t] of Object.entries(times).sort((a, b) => a[1] - b[1])) {
      while (labTime < t - 1e-6) advance(DT);
      out[label] = await capture(`${prefix}_${label}`);
    }
    updateHud();
    return out;
  },
  /** Manual pose (radians); pose(null) hands the head back to the script. */
  pose(yaw = null, pitch = null) { lab.yaw = yaw; lab.pitch = pitch; return { yaw, pitch }; },
  /** Fire params by name; lab switches: motion, turn, turnAmount, pointer, intensity, occlusion, bg, refOpacity, showHead, showFire. */
  setParam(k, v) {
    if (k in lab) lab[k] = v;
    else if (k in fire.params) {
      fire.params[k] = v;
      if (k === 'renderScale') fire.setSize(size[0], size[1]);
    } else throw new Error(`unknown param ${k}`);
    if (!running) drawFrame();
    return v;
  },
  setParams(obj) { for (const [k, v] of Object.entries(obj)) this.setParam(k, v); return this.params(); },
  params() { return { ...fire.params, lab: { ...lab } }; },
  setSize(w, h) { forced = [w, h]; layout(); if (!running) drawFrame(); return size; },
  /**
   * GPU cost of step() and of render() (+ the composite draw), averaged over n frames:
   *  - wall: each call followed by a 1 px gl.readPixels (sync), minus nothing (sync overhead shown);
   *  - gpu: EXT_disjoint_timer_query_webgl2 per pass, when the browser exposes it.
   */
  async timings(n = 20) {
    const wasRunning = running;
    running = false;
    drawFrame();
    sync();
    let base = 0;
    for (let i = 0; i < n; i++) { const a = performance.now(); sync(); base += performance.now() - a; }
    let ts = 0;
    let tr = 0;
    for (let i = 0; i < n; i++) {
      const a = performance.now();
      advance(DT);
      sync();
      const b = performance.now();
      renderFireOnly();
      sync();
      const c = performance.now();
      ts += b - a;
      tr += c - b;
    }
    const gpu = await gpuProfile(n);
    drawFrame();
    running = wasRunning;
    const r = {
      stepMs: +(ts / n).toFixed(3),
      renderMs: +(tr / n).toFixed(3),
      syncOverheadMs: +(base / n).toFixed(3),
      gpuStepMs: gpu ? gpu.step : null,
      gpuRenderMs: gpu ? gpu.render : null,
      gpuPasses: gpu ? gpu.passes : null,
      canvas: size.slice(),
      fireTarget: [fire._targets.fire.width, fire._targets.fire.height],
      grid: fire.info.grid,
      pressureIterations: fire.params.pressureIterations,
      steps: fire.params.steps,
      gpu: rendererName(),
    };
    updateHud(`step ${r.stepMs} ms  render ${r.renderMs} ms  (sync ${r.syncOverheadMs} ms)`
      + (gpu ? `  gpu: step ${gpu.step} ms  render ${gpu.render} ms` : ''));
    return r;
  },
};

window.addEventListener('resize', () => { if (!forced) { layout(); if (!running) drawFrame(); } });
layout();
updateHud();
requestAnimationFrame(tick);
