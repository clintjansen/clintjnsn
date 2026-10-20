/**
 * scene.js — the three.js side: one full-screen quad, one fragment shader, five textures.
 *
 * Everything visual lives in src/shaders/art.frag.glsl; this module owns the renderer,
 * the "cover" mapping between the viewport and the artwork, and the uniform plumbing.
 */

import * as THREE from 'three';
import vertexShader from './shaders/quad.vert.glsl?raw';
import fragmentShader from './shaders/art.frag.glsl?raw';
import { config } from './config.js';
import { createNoiseTexture } from './noise.js';
// Imported (not fetched by name) so Vite content-hashes them: a redeploy can never pair
// new shader code with stale cached textures.
import baseUrl from './tex/base.webp';
import detailUrl from './tex/detail.webp';
import maskUrl from './tex/mask.webp';
import fieldsUrl from './tex/fields.webp';
import extraUrl from './tex/extra.webp';

const TEXTURE_URLS = { base: baseUrl, detail: detailUrl, mask: maskUrl, fields: fieldsUrl, extra: extraUrl };
export const TEXTURE_COUNT = Object.keys(TEXTURE_URLS).length;

/** Load the prepared textures (see tools/prepare.py). onOne() fires per finished file. */
export async function loadTextures(onOne = () => {}) {
  const loader = new THREE.TextureLoader();
  const entries = await Promise.all(
    Object.entries(TEXTURE_URLS).map(async ([name, url]) => {
      const tex = await loader.loadAsync(url);
      // Raw bytes in, raw bytes out: no colour management, no mipmaps, y-down like the images.
      tex.colorSpace = THREE.NoColorSpace;
      tex.flipY = false;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      onOne(name);
      return [name, tex];
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * The artwork is scaled to cover the viewport (like CSS background-size: cover) and
 * cropped around a focal point. All maths in CSS px, y-down.
 */
export function computeCover(vw, vh, iw, ih, focal) {
  const s = Math.max(vw / iw, vh / ih);
  const sw = iw * s;
  const sh = ih * s;
  const ox = Math.min(0, Math.max(vw - sw, vw / 2 - focal.x * sw));
  const oy = Math.min(0, Math.max(vh - sh, vh / 2 - focal.y * sh));
  return {
    s, sw, sh, ox, oy,
    // shader: iuv = suv * scale + offset
    scale: [vw / sw, vh / sh],
    offset: [-ox / sw, -oy / sh],
    imageToScreen: (u, v) => [ox + u * sw, oy + v * sh],
    screenToImage: (x, y) => [(x - ox) / sw, (y - oy) / sh],
  };
}

/** The reference's card rect scaled about its centre: what the glass card actually covers. */
export function scaledCardRect([x0, y0, x1, y1], k, shiftY = 0) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2 + shiftY;
  const hw = (x1 - x0) / 2 * k, hh = (y1 - y0) / 2 * k;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

export function createScene({ canvas, textures, meta }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  renderer.setPixelRatio(1); // we size the drawing buffer ourselves
  renderer.autoClear = false;

  const aspect = meta.width / meta.height;
  const trail = new Float32Array(8 * 4);
  for (let i = 0; i < 8; i++) trail[i * 4 + 2] = 99;

  const uniforms = {
    uBase: { value: textures.base },
    uDetail: { value: textures.detail },
    uMask: { value: textures.mask },
    uFields: { value: textures.fields },
    uExtra: { value: textures.extra },
    uNoise: { value: createNoiseTexture() },

    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uCover: { value: new THREE.Vector4(1, 1, 0, 0) },
    uAspect: { value: aspect },
    uLineFreq: { value: 76 },
    uCoverScale: { value: 1 },

    uSpread: { value: 0 },
    uReveal: { value: 0 },
    uWaveT: { value: 100 },

    uTurn: { value: 0 },
    uBreath: { value: 0 },
    uBob: { value: new THREE.Vector2(0, 0) },
    uLightAngle: { value: 0 },
    uFlare: { value: 0.5 },
    uCrown: { value: new THREE.Vector2(meta.crown[0], meta.crown[1]) },
    uCardRect: { value: new THREE.Vector4(...scaledCardRect(meta.card, config.cardScale, config.cardShiftY)) },
    uHairSplit: { value: meta.hairSplitX ?? 0.376 },
    uTrail: { value: trail },
    uPointer: { value: new THREE.Vector2(-10, -10) },
    uPointerVel: { value: new THREE.Vector2(0, 0) },
    uPointerOn: { value: 0 },
    uFoxLook: { value: new THREE.Vector4(0, 0, 0, 0) },   // gaze.xy (image uv dir), attention, upset
    uFoxPhase: { value: 0 },                               // glow pulse phase (quickens when upset)
    uHeadRig: { value: new THREE.Vector2(0, 0) },          // bust head yaw, pitch
    uFoxRig: { value: new THREE.Vector4(0, 0, 0, 0) },     // fox head yaw, pitch, sniff, retreat

    uFlowSpeed: { value: config.art.flowSpeed },
    uWarpSpeed: { value: config.art.warpSpeed },
    uLineWidth: { value: config.art.lineWidth },
    uBakedMix: { value: config.art.bakedMix },
    uFlameAmount: { value: config.art.flameAmount },
    uGrain: { value: config.art.grain },
    uDebug: { value: 0 },
    uMarchSteps: { value: 36 },
    uHairSteps: { value: 11 },
  };

  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let cover = computeCover(1, 1, meta.width, meta.height, config.focal);
  let viewport = { w: 1, h: 1 };
  let renderScale = config.renderScale;
  let maxSpread = 2;
  let bufferW = 0;
  let bufferH = 0;
  let lastTime = 0;
  let rendered = false;

  function resize(vw, vh) {
    viewport = { w: vw, h: vh };
    cover = computeCover(vw, vh, meta.width, meta.height, config.focal);
    uniforms.uCover.value.set(cover.scale[0], cover.scale[1], cover.offset[0], cover.offset[1]);
    uniforms.uCoverScale.value = cover.s;
    // Contour line spacing: scale the native spacing with the artwork, within sane px bounds.
    const { native, min, max } = config.linePeriodPx;
    const periodPx = Math.min(max, Math.max(min, native * cover.s));
    uniforms.uLineFreq.value = cover.sh / periodPx;
    // Farthest screen corner from the screen centre, in the shader's aspect units (image height = 1).
    const centre = cover.screenToImage(vw / 2, vh / 2);
    maxSpread = 0;
    for (const [x, y] of [[0, 0], [vw, 0], [0, vh], [vw, vh]]) {
      const [u, v] = cover.screenToImage(x, y);
      const dx = (u - centre[0]) * aspect;
      const dy = v - centre[1];
      maxSpread = Math.max(maxSpread, Math.hypot(dx, dy));
    }
    applySize();
  }

  function applySize() {
    const dpr = Math.min(window.devicePixelRatio || 1, config.maxDpr);
    const w = Math.max(1, Math.round(viewport.w * dpr * renderScale));
    const h = Math.max(1, Math.round(viewport.h * dpr * renderScale));
    if (w === bufferW && h === bufferH) return; // setSize always clears the buffer: avoid it
    bufferW = w;
    bufferH = h;
    renderer.setSize(w, h, false);
    uniforms.uResolution.value.set(w, h);
    // Resizing clears the drawing buffer to black; repaint right away instead of waiting
    // for the next (24 fps-gated) frame.
    if (rendered) render(lastTime);
  }

  function setRenderScale(s) {
    renderScale = Math.min(config.renderScale, Math.max(config.minRenderScale, s));
    applySize();
  }

  /** loader progress 0..1 -> organic magma radius; 1 means the whole screen is covered */
  function setLoad(p) {
    if (p >= 1) { uniforms.uSpread.value = 10; return; }
    const eased = p * p * (3 - 2 * p);
    uniforms.uSpread.value = eased * (maxSpread + 0.08) / 0.85;
  }

  /** Compile the program off the main thread where the driver allows it (KHR_parallel_shader_compile). */
  async function compile() {
    const t0 = performance.now();
    if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
    else renderer.compile(scene, camera);
    return Math.round(performance.now() - t0);
  }

  function render(time) {
    lastTime = time;
    rendered = true;
    uniforms.uTime.value = time;
    renderer.render(scene, camera);
  }

  function dispose() {
    material.dispose();
    quad.geometry.dispose();
    for (const t of Object.values(textures)) t.dispose();
    uniforms.uNoise.value.dispose();
    renderer.dispose();
  }

  return {
    renderer, uniforms, resize, render, setLoad, setRenderScale, dispose, compile,
    get cover() { return cover; },
    get renderScale() { return renderScale; },
  };
}
