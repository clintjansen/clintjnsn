/**
 * scene.js — the three.js side.
 *
 * Draw order each frame (one orthographic world shared by everything):
 *   1. backdrop: a full-screen quad, src/shaders/art.frag.glsl (lava, plates)
 *   2. the avatar: a skinned 3D mesh (src/avatar/), depth-tested
 *   3. his fire: a 3D fluid simulation (src/fire/), volume-rendered against the avatar's depth
 *      and composited over everything
 *
 * World space: units = backdrop image heights, X right, Y up (0 = image bottom), Z towards the
 * viewer. The orthographic camera is kept in lockstep with the cover mapping, so the 3D world
 * and the 2D backdrop line up at every viewport size.
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
import figureUrl from './avatar/figure.webp';
import { createAvatar } from './avatar/avatar.js';

// The fire module is optional at build time (it is developed separately): glob returns {} if absent.
const fireModules = import.meta.glob('./fire/fire.js');

const TEXTURE_URLS = { base: baseUrl, detail: detailUrl, mask: maskUrl, fields: fieldsUrl, extra: extraUrl, figure: figureUrl };
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

export function createScene({ canvas, textures, meta, avatarBuffer }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,            // the avatar's silhouette is real geometry now
    alpha: false,
    depth: true,
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
    uFigure: { value: textures.figure },
    uFoxOn: { value: config.fox ? 1 : 0 },
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

  // ---- the 3D world: avatar (+ fire), seen by an orthographic camera matched to the cover
  const NEAR = 0.5;
  const FAR = 6.0;
  const camera3d = new THREE.OrthographicCamera(0, aspect, 1, 0, NEAR, FAR);
  camera3d.position.set(0, 0, 3);
  camera3d.lookAt(0, 0, 0);
  const world = new THREE.Scene();
  const avatar = createAvatar(avatarBuffer, { noise: uniforms.uNoise.value });
  world.add(avatar.mesh);
  avatar.setPose();
  // the avatar's depth for the fire (resized with the drawing buffer in applySize)
  let depthTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, stencilBuffer: false });
  depthTarget.depthTexture = new THREE.DepthTexture(1, 1);
  let fire = null;
  const fireScene = new THREE.Scene();
  const fireState = { dt: 0, pointer: null, intensity: 0 };

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
    avatar.uniforms.uLineFreq.value = cover.sh / periodPx;
    // world <-> screen: iuv = suv * scale + offset;  X = u * aspect, Y = 1 - v
    camera3d.left = cover.offset[0] * aspect;
    camera3d.right = (cover.offset[0] + cover.scale[0]) * aspect;
    camera3d.top = 1 - cover.offset[1];
    camera3d.bottom = 1 - (cover.offset[1] + cover.scale[1]);
    camera3d.updateProjectionMatrix();
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
    depthTarget.setSize(w, h);
    fire?.setSize(w, h);
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
  /**
   * Compile every program the page will use (backdrop, avatar, the avatar's depth pass, the fire's
   * passes and composite) asynchronously, so no first frame stalls on a shader compile.
   */
  async function compile() {
    const t0 = performance.now();
    const jobs = [renderer.compileAsync(scene, camera), renderer.compileAsync(world, camera3d)];
    if (fire) {
      jobs.push(renderer.compileAsync(fireScene, camera));
      // the depth pass renders into a target, which is part of the program's cache key
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(depthTarget);
      avatar.mesh.material = avatar.depthMaterial;
      jobs.push(renderer.compileAsync(world, camera3d));
      avatar.mesh.material = avatar.material;
      renderer.setRenderTarget(prev);
      jobs.push(fire.compileAsync());
    }
    await Promise.all(jobs);
    return Math.round(performance.now() - t0);
  }

  /** Bring the fire in (if the module is present) and light the skin with it. */
  async function attachFire() {
    const load = fireModules['./fire/fire.js'];
    if (!load || !config.fire) return false;
    const { createFire } = await load();
    const f = config.fireBox;
    fire = createFire(renderer, {
      boundsMin: new THREE.Vector3(...f.min),
      boundsMax: new THREE.Vector3(...f.max),
      grid: f.grid,
      quality: f.quality,
      params: config.fireParams,
    });
    fire.setSize(bufferW || 1, bufferH || 1);
    fireScene.add(fire.compositeMesh);
    const old = avatar.material;
    createAvatar.relight(avatar, fire.sampling);
    old.dispose();
    return true;
  }

  /** Per-frame state from main.js: the avatar's pose and what the fire needs. */
  function update({ dt, pose, pointer, intensity }) {
    avatar.setPose(pose);
    fireState.dt = dt;
    fireState.pointer = pointer;
    fireState.intensity = intensity;
  }

  function render(time) {
    lastTime = time;
    rendered = true;
    uniforms.uTime.value = time;
    avatar.uniforms.uTime.value = time;
    avatar.uniforms.uReveal.value = uniforms.uReveal.value;
    avatar.uniforms.uFlare.value = uniforms.uFlare.value;
    const la = uniforms.uLightAngle.value;
    avatar.uniforms.uKeyDir.value.set(Math.cos(la) * 0.7, 0.35 + Math.sin(la) * 0.45, 0.7).normalize();

    if (fire && fireState.dt > 0) {
      const frame = avatar.fireFrame(fireState.dt);
      if (fireState.pointer) Object.assign(frame.pointer, fireState.pointer);
      frame.intensity = fireState.intensity;
      fire.step(fireState.dt, frame);
      fireState.dt = 0;                       // one simulation step per update()
    }
    if (fire) {
      // the avatar's depth, so the fire stops at his skin
      renderer.setRenderTarget(depthTarget);
      renderer.clear(true, true, false);
      avatar.mesh.material = avatar.depthMaterial;
      renderer.render(world, camera3d);
      avatar.mesh.material = avatar.material;
      fire.render(camera3d, depthTarget.depthTexture, { near: NEAR, far: FAR });
    }

    renderer.setRenderTarget(null);
    renderer.clearDepth();
    renderer.render(scene, camera);           // backdrop
    renderer.render(world, camera3d);         // avatar
    if (fire) renderer.render(fireScene, camera);   // fire over both
  }

  function dispose() {
    avatar.dispose();
    fire?.dispose();
    depthTarget.dispose();
    material.dispose();
    quad.geometry.dispose();
    for (const t of Object.values(textures)) t.dispose();
    uniforms.uNoise.value.dispose();
    renderer.dispose();
  }

  return {
    renderer, uniforms, resize, render, update, setLoad, setRenderScale, dispose, compile, attachFire,
    avatar, camera3d, world,
    get fire() { return fire; },
    get cover() { return cover; },
    get renderScale() { return renderScale; },
  };
}
