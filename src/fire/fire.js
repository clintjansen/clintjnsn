/**
 * fire.js — the character's hair: a real-time 3D fluid-simulated fire and its volume renderer.
 *
 * Self-contained: give it a three.js WebGL2 renderer and a world-space box, then every frame
 * call step(dt, frame) with the head's obstacles and scalp, render(camera, bustDepth) and draw
 * `compositeMesh` after the bust. No DOM access, no globals; every call saves and restores the
 * renderer's render target (with cube face and mip level), autoClear and info.autoReset (it
 * never touches the clear colour, viewport or scissor except in reset(), which restores them
 * too). The composite reads the bust depth by uv, so it may be drawn into a target of another
 * size than the depth texture (it must not be drawn into the target that owns that depth).
 *
 * Simulation (GPU, one full-screen draw per pass over a 2D atlas of the 3D grid, RGBA16F):
 *   advect velocity (+ buoyancy, wind, turbulence, damping, scalp push, pointer, obstacles)
 *   -> curl -> vorticity confinement -> divergence
 *   -> pressure: restrict to a half-resolution grid, Jacobi x pressureIterations there, prolong,
 *      Jacobi x pressureFine on the full grid (multigrid = 0: plain Jacobi on the full grid)
 *   -> subtract gradient -> advect scalars (+ emission, decay, wall fade)
 *   -> per-column occupied z range (+ dilation) for the renderer.
 * Rendering: half-resolution front-to-back ray march along the view rays, clipped to the box,
 * to the occupied column range and to the bust's depth (nearest and farthest of the covered
 * full-resolution texels, two outputs); a full-screen composite upsamples them depth-aware
 * (bilinear over the neighbours of the pixel's own kind, bust or background) and blends
 * premultiplied (ONE, ONE_MINUS_SRC_ALPHA).
 *
 * World space: units = backdrop image heights, X right, Y up, Z towards the viewer.
 */

import * as THREE from 'three';
import { createNoiseTexture } from '../noise.js';
import commonGlsl from './shaders/common.glsl?raw';
import emitterGlsl from './shaders/emitter.glsl?raw';
import boundaryGlsl from './shaders/boundary.glsl?raw';
import passVert from './shaders/pass.vert.glsl?raw';
import advectVelocityFrag from './shaders/advect-velocity.frag.glsl?raw';
import curlFrag from './shaders/curl.frag.glsl?raw';
import confineFrag from './shaders/confine.frag.glsl?raw';
import divergenceFrag from './shaders/divergence.frag.glsl?raw';
import jacobiFrag from './shaders/jacobi.frag.glsl?raw';
import gradientFrag from './shaders/gradient.frag.glsl?raw';
import restrictFrag from './shaders/restrict.frag.glsl?raw';
import prolongFrag from './shaders/prolong.frag.glsl?raw';
import advectScalarsFrag from './shaders/advect-scalars.frag.glsl?raw';
import columnsFrag from './shaders/columns.frag.glsl?raw';
import dilateFrag from './shaders/dilate.frag.glsl?raw';
import marchFrag from './shaders/march.frag.glsl?raw';
import compositeVert from './shaders/composite.vert.glsl?raw';
import compositeFrag from './shaders/composite.frag.glsl?raw';
import { createSampling } from './sampling.js';

export const GRID_PRESETS = {
  high: [96, 56, 48],
  low: [64, 40, 32],
};

export const QUALITY_PRESETS = {
  low: { pressureIterations: 16, pressureFine: 2, steps: 36, renderScale: 0.5 },
  high: { pressureIterations: 20, pressureFine: 3, steps: 48, renderScale: 0.5 },
  ultra: { pressureIterations: 30, pressureFine: 8, steps: 72, renderScale: 1.0 },
};

/** Every live-tunable number, read on every step()/render(). */
export const DEFAULT_PARAMS = {
  // --- simulation
  timeScale: 1.0,          // multiplies dt (after the 1/20 s clamp)
  buoyancy: 0.3,           // upward acceleration per unit of fuel (world units/s^2)
  wind: 0.12,              // push per unit of fuel along windDir (world units/s^2)
  windAmbient: 0.0,        // share of the wind that also moves clear air
  windLift: 0.25,          // y component of the wind direction (x is -1: backwards)
  windYoung: 0.0,          // share of the wind acting on fuel just off the scalp
  windAge: 1.2,            // fuel age (s) at which the wind acts fully
  damping: 0.6,            // velocity damping (1/s)
  vorticity: 3.5,          // confinement strength (0 skips the curl + confine passes)
  turbulence: 1.6,         // large-scale wandering force (world units/s^2): lobes and curls
  turbulenceScale: 2.4,    // its noise cells per world unit (3 = lobes of ~0.3)
  turbulenceSpeed: 0.25,   // how fast it drifts
  multigrid: 1,            // 1: two-level pressure solve (coarse grid + fine smoothing), 0: plain Jacobi
  pressureIterations: 20,  // Jacobi sweeps per step (on the coarse grid when multigrid = 1)
  pressureFine: 3,         // fine-grid Jacobi sweeps after the coarse solve (multigrid = 1)
  pressureWarmStart: 0.85, // previous pressure carried into the next solve
  emission: 1.2,           // fuel the scalp shell is driven towards (0..~1.5)
  emitRate: 9.0,           // how fast shell cells reach it (1/s)
  emitSpeed: 0.45,         // speed the scalp pushes the fuel out with (world units/s)
  emitOut: 3.0,            // weights of the push direction: along the scalp normal,
  emitUp: 1.0,             //   straight up,
  emitBack: 0.0,           //   and backwards (-X)
  emitVelRate: 7.0,        // how fast shell velocity reaches that push (1/s)
  shell: 0.9,              // emitter shell thickness (cranium unit-sphere units)
  tongueScale: 2.6,        // tongues across the scalp (noise cells over the cap radius)
  tongueSpeed: 0.35,       // tongue drift
  tongueLo: 0.40,          // noise -> tongue contrast window
  tongueHi: 0.68,
  tongueFloor: 0.25,       // emission between tongues
  headStart: 0.8,          // age (s) given to fuel released at the crown (0 at the hairline)
  hairline: 0.25,          // noise pull-in of the cap edge (cosine units): an irregular hairline
  hairlineScale: 3.0,      // its noise cells around the cap
  hairlineSoft: 0.2,       // cap edge fade width (cosine units)
  sides: 0.0,              // less emission on the sides of the skull (0 = even, 1 = none at the sides)
  decay: 0.05,             // fuel decay (1/s)
  ageDecay: 0.1,           // extra decay per second of age (1/s^2)
  wallFade: 2.5,           // cells over which scalars fade out at the box walls
  wallFadeRate: 6.0,       // strength of that fade (1/s)
  pointerRadius: 0.06,     // Gaussian radius of the pointer push (world units)
  pointerStrength: 1.0,    // fraction of the pointer speed given to the air
  pointerRate: 14.0,       // how fast the air under the pointer reaches it (1/s)
  // --- rendering
  steps: 48,               // ray-march samples across the box depth
  renderScale: 0.5,        // fire target size relative to setSize (applied on setSize)
  absorption: 70.0,        // opacity per unit fuel per world unit
  exposure: 1.0,
  shoulder: 0.88,          // composite soft-clip knee
  ageSpan: 0.8,            // seconds for fuel to reach the bright end of the ramp (cores)
  cooling: 0.6,            // fall back towards blue per ageSpan after that peak
  coreDensity: 1.0,        // denser fuel reaches the bright end sooner
  warmth: 1.0,             // share of the warm family (0 = all tongues cool)
  warmLo: 0.56,            // tongue phase window where the warm family takes over
  warmHi: 0.72,
  warmWobble: 0.35,        // detail-noise wobble of the warm/cool border inside a tongue
  rim: 0.35,               // light-blue glow of thin edges against the background
  rimFuel: 0.25,           // fuel below which an edge counts as thin
  paletteJitter: 0.12,     // ramp noise from the detail field (painterly variation)
  brightGlow: 0.8,         // extra emission of the bright end of the ramp
  bodyBright: 1.0,
  youngDark: 0.3,          // darkening of fuel just off the scalp (the roots merge into the head)
  youngFade: 0.35,         // seconds over which that darkening fades
  edgeFade: 8.0,           // render fade at the box walls (cells), so the box never shows
  edgeFadeTop: 2.0,        // the same at the top wall (cells): it sits above the image, so the
                           //   plume runs off the top of the frame at full strength
  detail: 0.02,            // flow-noise warp amplitude (world units)
  detailScale: 4.0,        // noise cells per world unit
  detailPeriod: 2.4,       // flow-noise phase length (s)
  detailTwist: 4.0,        // warp rotation per world unit of depth (rad)
  debug: 0,                // 0 final, 1 raw fuel (grey), 2 fuel coloured by age, 3 tongue phase (warm/cool)
};

const TRIANGLE = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]);
const NO_FRAME = Object.freeze({});
const NO_OBSTACLES = Object.freeze([]);

export function createFire(renderer, options = {}) {
  const { boundsMin, boundsMax, quality = 'high' } = options;
  if (!renderer.capabilities.isWebGL2) throw new Error('createFire: WebGL2 is required');
  if (!boundsMin || !boundsMax) throw new Error('createFire: boundsMin and boundsMax are required');
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.high;
  const gridIn = options.grid || (quality === 'low' ? GRID_PRESETS.low : GRID_PRESETS.high);
  // even sizes, so the coarse pressure grid is exactly half
  const [NX, NY, NZ] = gridIn.map((n) => Math.max(8, 2 * Math.round(n / 2)));
  const TX = Math.ceil(Math.sqrt((NZ * NY) / NX));
  const TY = Math.ceil(NZ / TX);
  const AW = NX * TX;
  const AH = NY * TY;
  const [CNX, CNY, CNZ] = [NX / 2, NY / 2, NZ / 2];
  const CTX = Math.ceil(Math.sqrt((CNZ * CNY) / CNX));
  const CTY = Math.ceil(CNZ / CTX);

  const bmin = new THREE.Vector3().copy(boundsMin);
  const bmax = new THREE.Vector3().copy(boundsMax);
  const cell = bmax.clone().sub(bmin).divide(new THREE.Vector3(NX, NY, NZ));

  const params = { ...DEFAULT_PARAMS, ...preset, ...(options.params || {}) };

  // ---------------------------------------------------------------- targets
  function makeTarget(w, h, format = THREE.RGBAFormat, count = 1) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      count,
      type: THREE.HalfFloatType,
      format,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    for (const t of rt.textures) t.colorSpace = THREE.NoColorSpace;
    return rt;
  }
  let velA = makeTarget(AW, AH);
  let velB = makeTarget(AW, AH);
  // pressure is RG16F (p, div | solid mark): half the bytes per fetch in the Jacobi loop
  let presA = makeTarget(AW, AH, THREE.RGFormat);
  let presB = makeTarget(AW, AH, THREE.RGFormat);
  let scalA = makeTarget(AW, AH);
  let scalB = makeTarget(AW, AH);
  let coarseA = makeTarget(CNX * CTX, CNY * CTY, THREE.RGFormat);
  let coarseB = makeTarget(CNX * CTX, CNY * CTY, THREE.RGFormat);
  const curlRT = makeTarget(AW, AH);
  const colRaw = makeTarget(NX, NY);
  const colRT = makeTarget(NX, NY);
  // the fire itself: [0] up to the nearest bust depth, [1] up to the farthest (see march)
  const fireRT = makeTarget(2, 2, THREE.RGBAFormat, 2);
  const simTargets = () => [velA, velB, presA, presB, coarseA, coarseB, scalA, scalB, curlRT, colRaw, colRT];

  const noiseTex = createNoiseTexture();

  // ---------------------------------------------------------------- uniforms
  const defines = { NX, NY, NZ, TX, TY };
  const U = {
    uBoundsMin: { value: bmin },
    uBoundsMax: { value: bmax },
    uCell: { value: cell },
    uDt: { value: 0 },
    uTime: { value: 0 },
    uIntensity: { value: 1 },
    uNoise: { value: noiseTex },
    uScalp: { value: new THREE.Matrix4() },
    uCapDir: { value: new THREE.Vector3(-0.45, 0.89, 0).normalize() },
    uCapCos: { value: 0.15 },
    uShell: { value: params.shell },
    uEmitOn: { value: 0 },
    uTongue: { value: new THREE.Vector4() },
    uTongueFloor: { value: 0 },
    uHairline: { value: new THREE.Vector4() },
  };

  const coarseDefines = { NX: CNX, NY: CNY, NZ: CNZ, TX: CTX, TY: CTY, FNX: NX, FNY: NY, FNZ: NZ, FTX: TX, COARSE: 1 };
  const prolongDefines = { ...defines, CNX, CNY, CNZ, CTX, CTY };
  const coarseCell = { value: cell.clone().multiplyScalar(2) };

  function passMaterial(frag, own = {}, header = '', pass = 'pass', materialDefines = defines) {
    const material = new THREE.RawShaderMaterial({
      name: `fire-${pass}`,
      glslVersion: THREE.GLSL3,
      defines: materialDefines,
      vertexShader: passVert,
      fragmentShader: commonGlsl + '\n' + header + '\n' + frag,
      uniforms: { ...U, ...own },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    material.userData.pass = pass;
    return material;
  }

  const obsMats = Array.from({ length: 6 }, () => new THREE.Matrix4());
  const obsVel = Array.from({ length: 6 }, () => new THREE.Vector3());

  const mAdvectVel = passMaterial(advectVelocityFrag, {
    uVel: { value: null },
    uScal: { value: null },
    uObs: { value: obsMats },
    uObsVel: { value: obsVel },
    uObsCount: { value: 0 },
    uBuoyancy: { value: 0 },
    uWindDir: { value: new THREE.Vector3() },
    uWind: { value: new THREE.Vector2() },
    uDamping: { value: 0 },
    uWindAge: { value: new THREE.Vector2() },
    uTurb: { value: new THREE.Vector4() },
    uEmitVel: { value: new THREE.Vector4() },
    uEmitVelRate: { value: 0 },
    uPointer: { value: new THREE.Vector4() },
    uPointerParams: { value: new THREE.Vector3() },
  }, emitterGlsl, 'advect-velocity');
  const mCurl = passMaterial(curlFrag, { uVel: { value: null } }, '', 'curl');
  const mConfine = passMaterial(confineFrag, {
    uVel: { value: null }, uCurl: { value: null }, uScal: { value: null }, uVorticity: { value: 0 },
  }, '', 'confine');
  const mDivergence = passMaterial(divergenceFrag, {
    uVel: { value: null }, uPrevP: { value: null }, uWarm: { value: 0 },
  }, boundaryGlsl, 'divergence');
  const mJacobi = passMaterial(jacobiFrag, { uP: { value: null } }, boundaryGlsl, 'jacobi');
  const mRestrict = passMaterial(restrictFrag, {
    uFineP: { value: null }, uPrevC: { value: null }, uWarm: { value: 0 }, uCell: coarseCell,
  }, boundaryGlsl, 'restrict', coarseDefines);
  const mJacobiCoarse = passMaterial(jacobiFrag, { uP: { value: null }, uCell: coarseCell }, boundaryGlsl, 'jacobi-coarse', coarseDefines);
  const mProlong = passMaterial(prolongFrag, { uFineP: { value: null }, uCoarseP: { value: null } }, boundaryGlsl, 'prolong', prolongDefines);
  const mGradient = passMaterial(gradientFrag, { uVel: { value: null }, uP: { value: null } }, boundaryGlsl, 'gradient');
  const mAdvectScal = passMaterial(advectScalarsFrag, {
    uVel: { value: null },
    uScal: { value: null },
    uDecay: { value: new THREE.Vector2() },
    uEmit: { value: new THREE.Vector2() },
    uWallFade: { value: new THREE.Vector2() },
    uHeadStart: { value: 0 },
  }, emitterGlsl, 'advect-scalars');
  const mColumns = passMaterial(columnsFrag, {
    uScal: { value: null }, uVel: { value: null }, uThreshold: { value: 0.003 },
  }, '', 'columns');
  const mDilate = passMaterial(dilateFrag, { uCols: { value: null } }, '', 'dilate');
  const mMarch = passMaterial(marchFrag, {
    uScal: { value: null },
    uCols: { value: colRT.texture },
    uDepth: { value: null },
    uHasDepth: { value: 0 },
    uTargetSize: { value: new THREE.Vector2(2, 2) },
    uDepthSize: { value: new THREE.Vector2(2, 2) },
    uInvViewProj: { value: new THREE.Matrix4() },
    uSteps: { value: 48 },
    uDetail: { value: new THREE.Vector4() },
    uShade: { value: new THREE.Vector4() },
    uGlow: { value: new THREE.Vector4() },
    uIris: { value: new THREE.Vector4() },
    uEdge: { value: new THREE.Vector2() },
    uWarmSel: { value: new THREE.Vector4() },
    uDebug: { value: 0 },
  }, '', 'march');

  const compositeMaterial = new THREE.RawShaderMaterial({
    name: 'fire-composite',
    glslVersion: THREE.GLSL3,
    vertexShader: compositeVert,
    fragmentShader: compositeFrag,
    uniforms: {
      uFire: { value: fireRT.textures[0] },
      uFireFar: { value: fireRT.textures[1] },
      uDepth: { value: null },
      uHasDepth: { value: 0 },
      uDepthSize: { value: new THREE.Vector2(1, 1) },
      uExposure: { value: 1 },
      uShoulder: { value: 0.78 },
      uRaw: { value: 0 },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const compositeGeometry = new THREE.PlaneGeometry(2, 2);
  const compositeMesh = new THREE.Mesh(compositeGeometry, compositeMaterial);
  compositeMesh.name = 'fire-composite';
  compositeMesh.frustumCulled = false;
  compositeMesh.renderOrder = 1000;

  // ---------------------------------------------------------------- pass plumbing
  const passGeometry = new THREE.BufferGeometry();
  passGeometry.setAttribute('position', new THREE.BufferAttribute(TRIANGLE, 3));
  const passMesh = new THREE.Mesh(passGeometry, mAdvectVel);
  passMesh.frustumCulled = false;
  passMesh.matrixAutoUpdate = false;
  const passScene = new THREE.Scene();
  passScene.matrixWorldAutoUpdate = false;
  passScene.add(passMesh);
  passScene.updateMatrixWorld(true);
  const passCamera = new THREE.Camera();

  let passHook = null; // lab profiling: called with the pass name before each draw
  /**
   * Compile every pass program off the main thread where the driver allows it
   * (KHR_parallel_shader_compile), so the first step()/render() does not stall the page.
   */
  async function compileAsync() {
    const mats = [mAdvectVel, mCurl, mConfine, mDivergence, mRestrict, mJacobiCoarse, mProlong,
      mJacobi, mGradient, mAdvectScal, mColumns, mDilate, mMarch];
    const prevMat = passMesh.material;
    for (const m of mats) {
      // three compiles synchronously inside compileAsync and only waits asynchronously, so the
      // render target and material only need to be in place for the call itself
      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(m === mMarch ? fireRT : velA);
      passMesh.material = m;
      const done = renderer.compileAsync(passScene, passCamera);
      passMesh.material = prevMat;
      renderer.setRenderTarget(prevTarget);
      await done;
    }
  }

  function run(material, target) {
    if (passHook) passHook(material.userData.pass);
    passMesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(passScene, passCamera);
  }

  // Every renderer.render() also resets renderer.info when info.autoReset is on, which would
  // wipe the page's own draw-call statistics ~30 times per frame: off while the passes run.
  const saved = { target: null, face: 0, level: 0, autoClear: true, infoAutoReset: true };
  function saveState() {
    saved.target = renderer.getRenderTarget();
    saved.face = renderer.getActiveCubeFace();
    saved.level = renderer.getActiveMipmapLevel();
    saved.autoClear = renderer.autoClear;
    saved.infoAutoReset = renderer.info.autoReset;
    renderer.autoClear = false;
    renderer.info.autoReset = false;
  }
  function restoreState() {
    renderer.setRenderTarget(saved.target, saved.face, saved.level);
    renderer.autoClear = saved.autoClear;
    renderer.info.autoReset = saved.infoAutoReset;
    saved.target = null;
  }

  // ---------------------------------------------------------------- sampling snippet
  const sampling = createSampling({ NX, NY, NZ, TX, AW, AH, bmin, bmax });
  sampling.uniforms.fireScalars.value = scalA.texture;

  // ---------------------------------------------------------------- step
  let time = 0;

  function step(dt, frame = NO_FRAME) {
    dt = Math.min(Math.max(Number(dt) || 0, 0), 1 / 20) * params.timeScale;
    if (!(dt > 0)) return;
    time += dt;
    U.uDt.value = dt;
    U.uTime.value = time;

    // frame inputs. A singular (or non-finite) obstacle matrix would map every cell to the
    // sphere's centre and turn the whole box solid: such obstacles are skipped.
    const obstacles = frame.obstacles || NO_OBSTACLES;
    const velocities = frame.obstacleVelocity;
    let count = 0;
    for (let i = 0; i < obstacles.length && count < 6; i++) {
      const m = obstacles[i];
      const det = m ? m.determinant() : 0;
      if (!(Math.abs(det) > 1e-12) || !Number.isFinite(det)) continue;
      obsMats[count].copy(m);
      const v = velocities && velocities[i];
      if (v) obsVel[count].copy(v);
      else obsVel[count].set(0, 0, 0);
      count++;
    }
    for (let i = count; i < 6; i++) {
      obsMats[i].identity();
      obsVel[i].set(0, 0, 0);
    }
    mAdvectVel.uniforms.uObsCount.value = count;
    const scalpDet = frame.scalp ? frame.scalp.determinant() : 0;
    if (Math.abs(scalpDet) > 1e-12 && Number.isFinite(scalpDet)) {   // (singular: every cell would sit at one radius)
      U.uScalp.value.copy(frame.scalp);
      U.uEmitOn.value = 1;
    } else {
      U.uEmitOn.value = 0;
    }
    if (frame.scalpCapDir) U.uCapDir.value.copy(frame.scalpCapDir).normalize();
    if (frame.scalpCapCos !== undefined) U.uCapCos.value = frame.scalpCapCos;
    U.uIntensity.value = Math.min(Math.max(frame.intensity === undefined ? 1 : frame.intensity, 0), 1);
    const p = frame.pointer;
    const pu = mAdvectVel.uniforms;
    const pointerRadius = Math.max(1e-3, params.pointerRadius);   // the shader divides by its square
    if (p && p.active && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      pu.uPointer.value.set(p.x, p.y, Number.isFinite(p.vx) ? p.vx : 0, Number.isFinite(p.vy) ? p.vy : 0);
      pu.uPointerParams.value.set(pointerRadius, params.pointerStrength, params.pointerRate);
    } else {
      pu.uPointerParams.value.set(pointerRadius, params.pointerStrength, 0);
    }

    // params -> uniforms
    U.uShell.value = params.shell;
    U.uTongue.value.set(params.tongueScale, params.tongueSpeed, params.tongueLo, params.tongueHi);
    U.uTongueFloor.value = params.tongueFloor;
    U.uHairline.value.set(Math.max(0, params.hairline), params.hairlineScale, Math.max(1e-3, params.hairlineSoft), Math.min(Math.max(params.sides, 0), 1));
    pu.uBuoyancy.value = params.buoyancy;
    pu.uWindDir.value.set(-1, params.windLift, 0).normalize();
    pu.uWind.value.set(params.wind, params.windAmbient);
    pu.uDamping.value = params.damping;
    pu.uWindAge.value.set(params.windYoung, Math.max(1e-3, params.windAge));
    pu.uTurb.value.set(params.turbulence, params.turbulenceScale, params.turbulenceSpeed, 1.0);
    pu.uEmitVel.value.set(params.emitSpeed, params.emitOut, params.emitUp, params.emitBack);
    pu.uEmitVelRate.value = params.emitVelRate;
    mConfine.uniforms.uVorticity.value = params.vorticity;
    const su = mAdvectScal.uniforms;
    su.uDecay.value.set(params.decay, params.ageDecay);
    su.uEmit.value.set(params.emission, params.emitRate);
    su.uWallFade.value.set(params.wallFade, params.wallFadeRate);
    su.uHeadStart.value = params.headStart;

    saveState();

    // 1. velocity: advect + forces + obstacles
    pu.uVel.value = velA.texture;
    pu.uScal.value = scalA.texture;
    run(mAdvectVel, velB);
    let v = velB;
    let vSpare = velA;

    // 2. vorticity confinement
    if (params.vorticity > 0) {
      mCurl.uniforms.uVel.value = v.texture;
      run(mCurl, curlRT);
      mConfine.uniforms.uVel.value = v.texture;
      mConfine.uniforms.uCurl.value = curlRT.texture;
      mConfine.uniforms.uScal.value = scalA.texture;
      run(mConfine, vSpare);
      const t = v; v = vSpare; vSpare = t;
    }

    // 3. projection. Two-level: the divergence is restricted to a half-resolution grid, solved
    //    there (pressureIterations Jacobi sweeps, warm started), prolonged as the initial guess
    //    of the fine grid and smoothed by pressureFine sweeps. multigrid = 0: plain fine Jacobi
    //    (pressureIterations sweeps, warm started from the last fine solution in presA).
    mDivergence.uniforms.uVel.value = v.texture;
    mDivergence.uniforms.uPrevP.value = presA.texture;
    mDivergence.uniforms.uWarm.value = params.multigrid ? 0 : params.pressureWarmStart;
    run(mDivergence, presB);
    let pr = presB;
    let prSpare = presA;
    let fineIters = Math.max(0, Math.round(params.pressureIterations));
    if (params.multigrid) {
      mRestrict.uniforms.uFineP.value = presB.texture;
      mRestrict.uniforms.uPrevC.value = coarseA.texture;
      mRestrict.uniforms.uWarm.value = params.pressureWarmStart;
      run(mRestrict, coarseB);
      let c = coarseB;
      let cSpare = coarseA;
      for (let i = 0; i < fineIters; i++) {
        mJacobiCoarse.uniforms.uP.value = c.texture;
        run(mJacobiCoarse, cSpare);
        const t = c; c = cSpare; cSpare = t;
      }
      coarseA = c;
      coarseB = cSpare;
      mProlong.uniforms.uFineP.value = presB.texture;
      mProlong.uniforms.uCoarseP.value = c.texture;
      run(mProlong, presA);
      pr = presA;
      prSpare = presB;
      fineIters = Math.max(0, Math.round(params.pressureFine));
    }
    for (let i = 0; i < fineIters; i++) {
      mJacobi.uniforms.uP.value = pr.texture;
      run(mJacobi, prSpare);
      const t = pr; pr = prSpare; prSpare = t;
    }
    presA = pr;
    presB = prSpare;
    mGradient.uniforms.uVel.value = v.texture;
    mGradient.uniforms.uP.value = pr.texture;
    run(mGradient, vSpare);
    velA = vSpare;
    velB = v;

    // 4. scalars
    su.uVel.value = velA.texture;
    su.uScal.value = scalA.texture;
    run(mAdvectScal, scalB);
    const ts = scalA; scalA = scalB; scalB = ts;

    // 5. occupied column ranges for the renderer
    mColumns.uniforms.uScal.value = scalA.texture;
    mColumns.uniforms.uVel.value = velA.texture;
    run(mColumns, colRaw);
    mDilate.uniforms.uCols.value = colRaw.texture;
    run(mDilate, colRT);

    restoreState();
    sampling.uniforms.fireScalars.value = scalA.texture;
  }

  // ---------------------------------------------------------------- render
  const viewInverse = new THREE.Matrix4();
  function render(camera, depthTexture = null, opts) {
    void opts; // near/far are implied by the camera (depth is unprojected); kept for the contract
    camera.updateMatrixWorld();
    // world <- clip: matrixWorld * projectionInverse
    viewInverse.copy(camera.projectionMatrix).invert();
    const mu = mMarch.uniforms;
    mu.uInvViewProj.value.multiplyMatrices(camera.matrixWorld, viewInverse);
    mu.uScal.value = scalA.texture;
    mu.uCols.value = colRT.texture;
    mu.uDepth.value = depthTexture || null;
    mu.uHasDepth.value = depthTexture ? 1 : 0;
    if (depthTexture && depthTexture.image) {
      mu.uDepthSize.value.set(depthTexture.image.width || 1, depthTexture.image.height || 1);
    }
    mu.uTargetSize.value.set(fireRT.width, fireRT.height);
    mu.uSteps.value = Math.max(4, Math.min(160, Math.round(params.steps)));
    mu.uDetail.value.set(params.detail, params.detailScale, Math.max(0.1, params.detailPeriod), params.detailTwist);
    mu.uShade.value.set(params.absorption, Math.max(0.05, params.ageSpan), Math.max(1e-3, params.rimFuel), params.warmth);
    mu.uGlow.value.set(params.brightGlow, params.youngDark, params.bodyBright, params.coreDensity);
    mu.uIris.value.set(params.warmWobble, params.paletteJitter, Math.max(1e-3, params.youngFade), params.cooling);
    mu.uWarmSel.value.set(params.warmLo, Math.max(params.warmLo + 1e-3, params.warmHi), params.rim, 0);
    mu.uEdge.value.set(Math.max(0.5, params.edgeFade), Math.max(0.5, params.edgeFadeTop));
    mu.uDebug.value = params.debug | 0;
    const cu = compositeMaterial.uniforms;
    cu.uDepth.value = depthTexture || null;
    cu.uHasDepth.value = mu.uHasDepth.value;
    cu.uDepthSize.value.copy(mu.uDepthSize.value);
    compositeMaterial.uniforms.uExposure.value = params.exposure;
    compositeMaterial.uniforms.uShoulder.value = Math.min(0.98, Math.max(0.1, params.shoulder));
    compositeMaterial.uniforms.uRaw.value = params.debug ? 1 : 0;

    saveState();
    run(mMarch, fireRT);
    restoreState();
  }

  // ---------------------------------------------------------------- size, reset, dispose
  let lastW = 2;
  let lastH = 2;
  function setSize(width, height) {
    lastW = Math.max(1, Math.round(width));
    lastH = Math.max(1, Math.round(height));
    const s = params.renderScale || preset.renderScale;
    const w = Math.max(1, Math.round(lastW * s));
    const h = Math.max(1, Math.round(lastH * s));
    if (w !== fireRT.width || h !== fireRT.height) fireRT.setSize(w, h);
  }

  const clearColor = new THREE.Color();
  /** Empties the simulation (not part of the integration contract; handy for captures). */
  function reset() {
    const target = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace();
    const level = renderer.getActiveMipmapLevel();
    const autoClear = renderer.autoClear;
    renderer.getClearColor(clearColor);
    const alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const rt of simTargets()) {
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(target, face, level);
    renderer.setClearColor(clearColor, alpha);
    renderer.autoClear = autoClear;
    time = 0;
  }

  function dispose() {
    for (const rt of [...simTargets(), fireRT]) rt.dispose();
    for (const m of [mAdvectVel, mCurl, mConfine, mDivergence, mRestrict, mJacobiCoarse, mProlong, mJacobi, mGradient, mAdvectScal, mColumns, mDilate, mMarch, compositeMaterial]) m.dispose();
    passGeometry.dispose();
    compositeGeometry.dispose();
    noiseTex.dispose();
  }

  reset();

  return {
    compileAsync,
    step,
    render,
    compositeMesh,
    setSize,
    sampling,
    params,
    dispose,
    reset,
    get time() { return time; },
    get size() { return { width: lastW, height: lastH }; },
    info: { grid: [NX, NY, NZ], tiles: [TX, TY], atlas: [AW, AH], coarseGrid: [CNX, CNY, CNZ], cell: cell.toArray(), quality },
    /** Lab profiling hook: fn(passName) runs before every draw (null to remove). */
    _setPassHook(fn) { passHook = fn || null; },
    // internals for the lab's debug views
    _targets: { get scalars() { return scalA; }, get velocity() { return velA; }, get columns() { return colRT; }, get fire() { return fireRT; } },
  };
}
