/**
 * lab.js — tools/fire-lab.html: the fluid fire on a provisional head.
 *
 * Ortho camera over the whole backdrop (world X 0..1.648, Y 0..1, contain fit), a backdrop
 * that approximates the reference (or the reference itself, ?bg=ref), the head as three navy
 * ellipsoids lit by the fire (through fire.sampling) that also write a DepthTexture for the
 * fire's occlusion, a scripted head animation (nod, bob, a 35 degree turn towards the viewer
 * every 10 s) and a scripted pointer sweep through the flames.
 *
 * window.__fireLab = { step(n), render(), capture(name), setParam(k, v), timings(n), ... }
 * Stepping is deterministic: fixed dt (1/30 s), lab time drives every animation.
 * Debug views: setParam('debug', 1 | 2 | 3) = raw fuel, fuel age, tongue phase (warm/cool).
 * timings(n) is async and advances the simulation by 2n frames.
 */

import * as THREE from 'three';
import { createFire } from './fire.js';

const qs = new URLSearchParams(location.search);
const TAU = Math.PI * 2;
const IMG_W = 1383 / 839; // backdrop width in world units (image heights)
const DT = 1 / 30;
const BOUNDS_MIN = new THREE.Vector3(0.08, 0.30, -0.36);
const BOUNDS_MAX = new THREE.Vector3(1.45, 1.06, 0.36);
const PIVOT = new THREE.Vector3(0.73, 0.40, 0.0);
const PARTS = [
  { name: 'cranium', c: new THREE.Vector3(0.84, 0.64, 0.0), r: new THREE.Vector3(0.33, 0.30, 0.25), follow: 1.0 },
  { name: 'face', c: new THREE.Vector3(1.05, 0.44, 0.0), r: new THREE.Vector3(0.16, 0.24, 0.18), follow: 1.0 },
  { name: 'neck', c: new THREE.Vector3(0.68, 0.18, 0.0), r: new THREE.Vector3(0.15, 0.25, 0.13), follow: 0.4 },
];
const CAP_DIR = new THREE.Vector3(-0.45, 0.89, 0.0).normalize();
const CAP_COS = 0.15;
// reference2 pixel (x2, y2) -> world ((x2 / 1.388 - 39) / 839, 1 - (y2 / 1.388) / 839)
const REF = { k: 1.388, ox: 39, ih: 839 };

const lab = {
  motion: 1,        // nod + bob
  turn: 1,          // the periodic turn towards the viewer
  pointer: 1,       // scripted pointer sweeps
  intensity: 1,
  occlusion: 1,     // pass the bust depth to the fire
  headLight: 1,     // fire light on the head (through fire.sampling)
  bg: qs.get('bg') || 'proc', // proc | ref | black
  refOpacity: 0.4,
  showHead: 1,
  showFire: 1,
};

// ------------------------------------------------------------------ renderer + camera
const canvas = document.getElementById('gl');
const hud = document.getElementById('hud');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
const gl = renderer.getContext();

const camera = new THREE.OrthographicCamera(0, IMG_W, 1, 0, 0.1, 10);
camera.position.set(0, 0, 5);

const quality = qs.get('quality') || 'high';
const grid = qs.get('grid') ? qs.get('grid').split('x').map(Number) : undefined;
const fire = createFire(renderer, { boundsMin: BOUNDS_MIN, boundsMax: BOUNDS_MAX, grid, quality });

const depthRT = new THREE.WebGLRenderTarget(2, 2, {
  depthBuffer: true,
  depthTexture: new THREE.DepthTexture(2, 2),
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
});

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
    uPointer: { value: new THREE.Vector4() },
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
    uniform vec4 uPointer;
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
  if (!running) drawFrame();
});

// ------------------------------------------------------------------ head (lit by the fire)
const headMaterial = new THREE.ShaderMaterial({
  uniforms: { ...fire.sampling.uniforms, uFireLight: { value: 1 } },
  vertexShader: /* glsl */ `
    varying vec3 vWorld;
    varying vec3 vNormalW;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      vNormalW = normalize(transpose(inverse(mat3(modelMatrix))) * normal);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */ `
    ${fire.sampling.glsl}
    uniform float uFireLight;
    varying vec3 vWorld;
    varying vec3 vNormalW;
    void main() {
      vec3 n = normalize(vNormalW);
      vec3 navy = vec3(0.035, 0.045, 0.17);
      float key = 0.55 + 0.45 * dot(n, normalize(vec3(0.55, 0.55, 0.65)));
      float rim = pow(1.0 - abs(n.z), 3.0);
      vec3 col = navy * key + vec3(0.04, 0.05, 0.22) * rim;
      float h = fireHeatAt(vWorld + n * 0.035);
      col += vec3(0.10, 0.20, 0.90) * h * 0.45 * uFireLight;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const headScene = new THREE.Scene();
const sphere = new THREE.SphereGeometry(1, 72, 48);
const meshes = PARTS.map((part) => {
  const m = new THREE.Mesh(sphere, headMaterial);
  m.matrixAutoUpdate = false;
  m.frustumCulled = false;
  headScene.add(m);
  return m;
});

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

// ------------------------------------------------------------------ animation script
const ease = (x) => { x = Math.min(Math.max(x, 0), 1); return x * x * x * (x * (x * 6 - 15) + 10); };

/** 0..1: how far the head is turned towards the viewer. First turn at 9 s, every 10 s. */
function turnEnvelope(t) {
  const P = 10;
  const u = (((t - 9) % P) + P) % P;
  if (t < 9) return 0;
  if (u < 1.3) return ease(u / 1.3);
  if (u < 3.3) return 1;
  if (u < 5.0) return 1 - ease((u - 3.3) / 1.7);
  return 0;
}

const m1 = new THREE.Matrix4();
const m2 = new THREE.Matrix4();
/** Head transform (local bind pose -> world) at time t; k scales the rotations (neck follows less). */
function headPose(t, k, out) {
  const nod = lab.motion * (0.05 * Math.sin((t * TAU) / 5.3) + 0.022 * Math.sin((t * TAU) / 2.9 + 1.0));
  const bob = lab.motion * 0.007 * Math.sin((t * TAU) / 3.7 + 0.4);
  const yaw = -lab.turn * THREE.MathUtils.degToRad(35) * turnEnvelope(t);
  out.makeTranslation(-PIVOT.x, -PIVOT.y, -PIVOT.z);
  m2.makeRotationZ(nod * k);
  out.premultiply(m2);
  m2.makeRotationY(yaw * k);
  out.premultiply(m2);
  m1.makeTranslation(PIVOT.x, PIVOT.y + bob, PIVOT.z);
  return out.premultiply(m1);
}

/** Scripted pointer: a sweep over the head through the flames, at 7.5 s and every 10 s. */
function pointerAt(t, out) {
  out.active = false;
  if (!lab.pointer) return out;
  const P = 10;
  const dur = 1.6;
  if (t < 7.5) return out;
  const u = ((t - 7.5) % P) / dur;
  if (u > 1) return out;
  const s = ease(u);
  out.x = 0.20 + (1.32 - 0.20) * s;
  out.y = 0.78 + (0.96 - 0.78) * s + 0.07 * Math.sin(Math.PI * s);
  out.active = true;
  return out;
}

const partLocal = PARTS.map((p) => new THREE.Matrix4().compose(p.c, new THREE.Quaternion(), p.r));
const pose = PARTS.map(() => new THREE.Matrix4());
const posePrev = PARTS.map(() => new THREE.Matrix4());
const obstacleMats = PARTS.map(() => new THREE.Matrix4());
const obstacleVel = PARTS.map(() => new THREE.Vector3());
const cNow = new THREE.Vector3();
const cPrev = new THREE.Vector3();
const ptr = { x: 0, y: 0, vx: 0, vy: 0, active: false };
const ptrPrev = { x: 0, y: 0, active: false };
const frame = {
  obstacles: obstacleMats,
  obstacleVelocity: obstacleVel,
  scalp: obstacleMats[0],
  scalpCapDir: CAP_DIR,
  scalpCapCos: CAP_COS,
  pointer: ptr,
  intensity: 1,
};

let labTime = 0;
let frames = 0;

function poseAt(t, out) {
  PARTS.forEach((p, i) => headPose(t, p.follow, out[i]).multiply(partLocal[i]));
}

function applyPose() {
  poseAt(labTime, pose);
  meshes.forEach((m, i) => { m.matrix.copy(pose[i]); m.matrixWorld.copy(pose[i]); });
}

function advance(dt) {
  const t0 = labTime;
  const t1 = labTime + dt;
  poseAt(t0, posePrev);
  poseAt(t1, pose);
  for (let i = 0; i < PARTS.length; i++) {
    obstacleMats[i].copy(pose[i]).invert();
    cNow.setFromMatrixPosition(pose[i]);
    cPrev.setFromMatrixPosition(posePrev[i]);
    obstacleVel[i].subVectors(cNow, cPrev).divideScalar(dt);
  }
  pointerAt(t0, ptrPrev);
  pointerAt(t1, ptr);
  if (ptr.active && ptrPrev.active) {
    ptr.vx = (ptr.x - ptrPrev.x) / dt;
    ptr.vy = (ptr.y - ptrPrev.y) / dt;
  } else {
    ptr.vx = 0;
    ptr.vy = 0;
  }
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
}

function drawFrame() {
  applyPose();
  const debugView = fire.params.debug > 0;
  bgMaterial.uniforms.uMode.value = debugView || lab.bg === 'black' ? 2 : lab.bg === 'ref' ? 1 : 0;
  bgMaterial.uniforms.uRefOpacity.value = lab.refOpacity;
  bgMaterial.uniforms.uPointer.value.set(ptr.x, ptr.y, ptr.active ? 1 : 0, 0);
  headMaterial.uniforms.uFireLight.value = lab.headLight;

  renderer.autoClear = true;
  renderer.setRenderTarget(depthRT);
  renderer.render(headScene, camera);
  renderer.setRenderTarget(null);
  renderer.render(bgScene, camera);
  renderer.autoClear = false;
  if (lab.showHead && !debugView) renderer.render(headScene, camera);
  if (lab.showFire) {
    fire.render(camera, lab.occlusion ? depthRT.depthTexture : null, { near: camera.near, far: camera.far });
    renderer.render(compScene, camera);
  }
  pointerRing.visible = ptr.active && !debugView;
  pointerRing.position.x = ptr.x;
  pointerRing.position.y = ptr.y;
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
  if (!running) return;
  fps = fps * 0.9 + (dt > 0 ? 1 / dt : 0) * 0.1;
  advance(dt);
  drawFrame();
  if (frames % 10 === 0) updateHud();
}

function updateHud(extra = '') {
  hud.textContent = `fire lab  t ${labTime.toFixed(2)} s  frame ${frames}  ${running ? `${fps.toFixed(0)} fps` : 'paused'}\n`
    + `grid ${fire.info.grid.join('x')} (atlas ${fire.info.atlas.join('x')})  canvas ${size.join('x')}  quality ${quality}`
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

window.__fireLab = {
  fire,
  renderer,
  camera,
  lab,
  get time() { return labTime; },
  get frames() { return frames; },
  /** Advance n frames of fixed dt (1/30 s) without drawing; pauses the live loop. */
  step(n = 1, dt = DT) {
    running = false;
    for (let i = 0; i < n; i++) advance(dt);
    drawFrame();
    updateHud();
    return { time: labTime, frames };
  },
  render() { drawFrame(); return { time: labTime, frames }; },
  play() { running = true; last = performance.now(); },
  pause() { running = false; },
  /** Clears the fluid and rewinds the lab clock (deterministic restarts). */
  reset() { fire.reset(); labTime = 0; frames = 0; drawFrame(); updateHud(); },
  /** Renders, then posts the canvas to the capture server; resolves to the written path. */
  async capture(name = 'fire', type = 'jpeg') {
    drawFrame();
    const url = canvas.toDataURL(type === 'png' ? 'image/png' : 'image/jpeg', 0.9);
    const res = await fetch(`http://localhost:5199/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: url });
    return res.text();
  },
  /** Fire params by name; lab switches: motion, turn, pointer, intensity, occlusion, headLight, bg, refOpacity, showHead. */
  setParam(k, v) {
    if (k in lab) lab[k] = v;
    else if (k in fire.params) {
      fire.params[k] = v;
      if (k === 'renderScale') fire.setSize(size[0], size[1]);
    } else throw new Error(`unknown param ${k}`);
    if (!running) drawFrame();
    return v;
  },
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
drawFrame();
updateHud();
requestAnimationFrame(tick);
