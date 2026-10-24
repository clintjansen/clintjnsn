import '../../src/components/jnsn-wordmark.js';
import { createBrailleConverter } from '../../src/braille/image-to-braille.js';
import { PortraitMotion, MOTION_DURATION, MOTION_FPS, MOTION_FRAME_COUNT } from './portrait-motion.js';
import atlasUrl from './turn-smile-atlas.png';

const $ = selector => document.querySelector(selector);
const art = $('#braille-art');
const frame = $('#art-frame');
const main = $('.preview-main');
const source = document.createElement('canvas');
source.width = 720;
source.height = 640;
const ctx = source.getContext('2d', { willReadFrequently: true });
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const COLS = 120;
const ROWS = 68;
const toBraille = createBrailleConverter({ columns: COLS, rows: ROWS });
const state = { mode: 'braille', playing: false, time: 0, ready: false };
let portraitMotion;
let textmodeInstance;
let textmodeReady = false;
let threeState;
let animationId = 0;
let previousTime = 0;
let renderVersion = 0;
let loaderVersion = 0;
const motionFrames = new Map();

function setError(error) {
  $('#error').hidden = false;
  $('#error').textContent = 'This renderer could not start: ' + error.message + '. Try Braille for the text-only version.';
  console.error(error);
}

function drawSource(time = state.time) {
  portraitMotion.draw(ctx, time / MOTION_DURATION);
}

function fit() {
  const padding = document.body.classList.contains('page-preview') ? 32 : 8;
  const width = Math.min(main.clientWidth - padding, (main.clientHeight - padding) * 1.125);
  frame.style.width = `${Math.max(1, width)}px`;
  frame.style.height = `${Math.max(1, width / 1.125)}px`;
  if (!art.hidden) art.style.setProperty('--preview-scale', Math.min(frame.clientWidth / art.offsetWidth, frame.clientHeight / art.offsetHeight));
  if (threeState) fitThree();
}

async function initTextmode() {
  if (textmodeInstance) return;
  const { textmode } = await import('textmode.js');
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 854;
  $('#textmode-output').append(canvas);
  textmodeInstance = textmode.create({ canvas, width: 960, height: 854, fontSize: 7, frameRate: 24, loadingScreen: { transition: 'none' } });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('textmode.js did not initialize')), 15000);
    textmodeInstance.setup(() => {
      const texture = textmodeInstance.createTexture(source);
      texture.characters('@%#*+=-:. ');
      texture.charColorMode('fixed').charColor(0, 0, 0);
      texture.cellColorMode('fixed').cellColor(255, 255, 255);
      textmodeInstance.draw(() => {
        textmodeInstance.background(255);
        textmodeInstance.image(texture, texture.width, texture.height);
      });
      textmodeReady = true;
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function initThree() {
  if (threeState) return;
  const [THREE, { AsciiEffect }] = await Promise.all([import('three'), import('three/addons/effects/AsciiEffect.js')]);
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  const texture = new THREE.CanvasTexture(source);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1.125, 1.125, 1, -1, .1, 10);
  camera.position.z = 2;
  const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2.25, 2), material));
  const effect = new AsciiEffect(renderer, ' .:-=+*#%@', { resolution: .21, scale: 1, strResolution: 'low' });
  effect.setSize(720, 640);
  effect.domElement.style.color = '#000';
  effect.domElement.style.backgroundColor = '#fff';
  $('#three-output').append(effect.domElement);
  threeState = { renderer, texture, effect, scene, camera, material };
  fitThree();
}

function fitThree() {
  const { effect } = threeState;
  effect.domElement.style.width = '720px';
  effect.domElement.style.height = '640px';
  effect.domElement.style.transform = `scale(${frame.clientWidth / 720},${frame.clientHeight / 640})`;
}

function syncPoseUI(time) {
  const progress = Math.max(0, Math.min(1, time / MOTION_DURATION));
  const percent = Math.round(progress * 100);
  $('#motion-progress').value = Math.round(progress * 1000);
  $('#motion-progress').setAttribute('aria-valuetext', progress === 0 ? 'Neutral image' : progress === 1 ? 'Facing the camera with a big smile' : percent + '% through the head turn and smile');
  $('#motion-percent').textContent = percent + '%';
  $('[data-expression="neutral"]').setAttribute('aria-pressed', String(progress === 0));
  $('[data-expression="smile"]').setAttribute('aria-pressed', String(progress === 1));
  $('#caption').textContent = progress === 0 ? 'A neutral expression.' : progress === 1 ? 'A big smile. Eye contact.' : 'Keyframe morph preview…';
  art.setAttribute('aria-label', progress === 0 ? 'Neutral portrait converted from an image into Braille characters' : progress === 1 ? 'Front-facing Braille portrait with a broad confident smile' : 'Braille portrait turning toward the camera and smiling');
  if (!state.playing) $('#play').innerHTML = (progress === 1 ? 'Replay' : progress > 0 ? 'Resume' : 'Play') + ' turn + smile <span>▷</span>';
}

function render(time = state.time) {
  if (!state.ready) return;
  const frameIndex = Math.round(time / MOTION_DURATION * (MOTION_FRAME_COUNT - 1));
  drawSource(state.mode === 'frames' ? frameIndex / (MOTION_FRAME_COUNT - 1) * MOTION_DURATION : time);
  if (state.mode === 'braille' || state.mode === 'frames') {
    if (state.mode === 'frames') {
      if (!motionFrames.has(frameIndex)) motionFrames.set(frameIndex, toBraille(source));
      art.textContent = motionFrames.get(frameIndex);
    } else art.textContent = toBraille(source);
    fit();
  } else if (state.mode === 'textmode' && textmodeReady) textmodeInstance.redraw();
  else if (state.mode === 'three' && threeState) {
    threeState.texture.needsUpdate = true;
    threeState.effect.render(threeState.scene, threeState.camera);
  }
  syncPoseUI(time);
}

function tick(now) {
  if (!state.playing || document.hidden) return;
  if (now - previousTime >= 1000 / MOTION_FPS) {
    state.time = Math.min(MOTION_DURATION, state.time + now - previousTime);
    previousTime = now;
    render();
    if (state.time >= MOTION_DURATION) { stop(); return; }
  }
  animationId = requestAnimationFrame(tick);
}

function stop() {
  state.playing = false;
  cancelAnimationFrame(animationId);
  $('#play').setAttribute('aria-pressed', 'false');
  syncPoseUI(state.time);
  if (textmodeReady) textmodeInstance.noLoop();
}

function play() {
  if (!state.ready || state.playing) return;
  if (state.time >= MOTION_DURATION) state.time = 0;
  state.playing = true;
  $('#play').setAttribute('aria-pressed', 'true');
  $('#play').innerHTML = 'Pause turn + smile <span>Ⅱ</span>';
  previousTime = performance.now();
  animationId = requestAnimationFrame(tick);
}

async function changeMode() {
  const version = ++renderVersion;
  stop();
  state.mode = $('#renderer').value;
  $('#error').hidden = true;
  art.hidden = !['braille', 'frames'].includes(state.mode);
  $('#textmode-output').hidden = state.mode !== 'textmode';
  $('#three-output').hidden = state.mode !== 'three';
  main.setAttribute('aria-busy', 'true');
  $('#render-note').textContent = 'Preparing renderer…';
  try {
    if (state.mode === 'textmode') { await initTextmode(); textmodeInstance.noLoop(); }
    if (state.mode === 'three') await initThree();
    if (version !== renderVersion) return;
    const notes = {
      braille: 'Image → selectable Braille text · keyframe morph',
      textmode: 'textmode.js 0.18 · live canvas to ASCII',
      three: 'Three.js AsciiEffect · animated portrait texture',
      frames: '24 fps Braille poses · JSON export for ASCII Motion',
    };
    $('#render-note').textContent = notes[state.mode];
    render();
    fit();
  } catch (error) {
    if (version !== renderVersion) return;
    setError(error);
    $('#renderer').value = state.mode = 'braille';
    art.hidden = false;
    $('#textmode-output').hidden = $('#three-output').hidden = true;
    $('#render-note').textContent = 'Image → selectable Braille text';
    render();
  }
  finally { if (version === renderVersion) main.setAttribute('aria-busy', 'false'); }
}

function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function makeMotionFrames() {
  const count = Math.ceil(MOTION_DURATION * 12 / 1000) + 1;
  const frames = [];
  for (let i = 0; i < count; i++) {
    drawSource(i / (count - 1) * MOTION_DURATION);
    frames.push(toBraille(source));
    if (i % 4 === 0) await new Promise(resolve => requestAnimationFrame(resolve));
  }
  return frames;
}

async function replayLoader(ready = Promise.resolve()) {
  const version = ++loaderVersion;
  let prepared = false;
  let preparationError;
  Promise.resolve(ready).then(() => { prepared = true; }, error => { prepared = true; preparationError = error; });
  const loader = $('#loader');
  const shell = $('.preview-shell');
  loader.classList.remove('is-running', 'is-done', 'is-hidden');
  loader.dataset.phase = 'assembling';
  $('#loader-phase').textContent = 'ASSEMBLING CHARACTER';
  $('.loader__digits').textContent = '0';
  $('.loader__rule > i').style.width = '0%';
  document.body.classList.add('loader-active');
  shell.inert = true;
  // Flush the reset so Replay restarts every CSS animation from its first frame.
  void loader.offsetWidth;
  loader.classList.add('is-running');
  $('#loader-status').textContent = 'Loading';
  const start = performance.now();
  await new Promise(resolve => {
    function update(now) {
      if (version !== loaderVersion) return resolve();
      const elapsed = reducedMotion.matches ? 1 : Math.min(1, (now - start) / 3400);
      const progress = Math.min(prepared ? 1 : .95, 1 - Math.pow(1 - elapsed, 1.5));
      $('.loader__digits').textContent = Math.floor(progress * 100);
      $('.loader__rule > i').style.width = `${progress * 100}%`;
      const phase = elapsed < .6 ? 'assembling' : elapsed < .91 ? 'locked' : prepared ? 'ready' : 'preparing';
      if (loader.dataset.phase !== phase) {
        loader.dataset.phase = phase;
        $('#loader-phase').textContent = phase === 'locked' ? 'CHARACTER LOCKED IN' : phase === 'preparing' ? 'PREPARING PORTRAIT' : 'MAKE AN IMPRESSION';
      }
      if ((elapsed < 1 || !prepared) && !preparationError) requestAnimationFrame(update);
      else resolve();
    }
    requestAnimationFrame(update);
  });
  if (version !== loaderVersion) return;
  if (preparationError) throw preparationError;
  if (!reducedMotion.matches) await new Promise(resolve => setTimeout(resolve, 320));
  if (version !== loaderVersion) return;
  loader.dataset.phase = 'revealing';
  loader.classList.add('is-done');
  if (!reducedMotion.matches) await new Promise(resolve => setTimeout(resolve, 840));
  if (version === loaderVersion) {
    loader.classList.add('is-hidden');
    loader.classList.remove('is-running');
    document.body.classList.remove('loader-active');
    shell.inert = false;
    $('#loader-status').textContent = 'Loaded';
  }
}

document.querySelectorAll('[data-expression]').forEach(button => button.addEventListener('click', () => {
  stop();
  state.time = button.dataset.expression === 'neutral' ? 0 : MOTION_DURATION;
  render();
}));
$('#renderer').addEventListener('change', changeMode);
$('#play').addEventListener('click', () => {
  if (state.playing) { stop(); render(); } else play();
});
$('#motion-progress').addEventListener('input', event => {
  const value = Number(event.target.value);
  stop();
  state.time = value / 1000 * MOTION_DURATION;
  render();
});
$('#replay-loader').addEventListener('click', () => replayLoader());
$('#page-preview').addEventListener('click', async () => {
  stop();
  state.time = 0;
  render();
  document.body.classList.add('page-preview');
  fit();
  await replayLoader();
  if (!reducedMotion.matches && document.body.classList.contains('page-preview')) play();
});
$('#back-to-controls').addEventListener('click', () => { document.body.classList.remove('page-preview'); fit(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { document.body.classList.remove('page-preview'); fit(); }
  if (!document.body.classList.contains('page-preview') || /INPUT|SELECT|BUTTON/.test(event.target.tagName)) return;
  if (event.code === 'Space') { event.preventDefault(); if (state.playing) stop(); else play(); }
  if (['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    stop();
    state.time = event.key === 'Home' ? 0 : event.key === 'End' ? MOTION_DURATION : Math.max(0, Math.min(MOTION_DURATION, state.time + (event.key === 'ArrowLeft' ? -1 : 1) * MOTION_DURATION * .05));
    render();
  }
});
$('#download-art').addEventListener('click', () => {
  drawSource();
  download(toBraille(source), 'clint-portrait-' + Math.round(state.time / MOTION_DURATION * 100) + '.txt', 'text/plain;charset=utf-8');
  render();
});
$('#export-motion').addEventListener('click', async () => {
  stop();
  const controls = document.querySelectorAll('button, select, input');
  controls.forEach(control => { control.disabled = true; });
  main.setAttribute('aria-busy', 'true');
  $('#export-motion').textContent = 'Preparing frames…';
  try {
    const textFrames = await makeMotionFrames();
    const duration = MOTION_DURATION / (textFrames.length - 1);
    const frames = textFrames.map((text, index) => ({
      index, duration,
      cells: text.split('\n').flatMap((line, y) => [...line].map((char, x) => ({ x, y, char, color: '#000000', bgColor: '#FFFFFF' }))),
    }));
    const width = COLS;
    download(JSON.stringify({ version: '1.0', width, height: ROWS, frameCount: frames.length, frameRate: 1000 / duration, frames }), 'clint-turn-smile-ascii-motion.json', 'application/json');
  } catch (error) { setError(error); }
  finally {
    $('#export-motion').textContent = 'ASCII Motion JSON ↓';
    controls.forEach(control => { control.disabled = !state.ready; });
    main.setAttribute('aria-busy', 'false');
    render();
  }
});
document.addEventListener('visibilitychange', () => {
  cancelAnimationFrame(animationId);
  if (!document.hidden && state.playing) { previousTime = performance.now(); animationId = requestAnimationFrame(tick); }
});
reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) { stop(); render(); } });
new ResizeObserver(fit).observe(main);
document.fonts.addEventListener('loadingdone', fit);
window.addEventListener('pagehide', event => {
  cancelAnimationFrame(animationId);
  if (event.persisted) return;
  textmodeInstance?.destroy();
  if (threeState) { threeState.texture.dispose(); threeState.material.dispose(); threeState.scene.children[0].geometry.dispose(); threeState.renderer.dispose(); }
});
window.addEventListener('pageshow', event => {
  if (!event.persisted || !state.ready) return;
  render();
  fit();
  if (state.playing) { previousTime = performance.now(); animationId = requestAnimationFrame(tick); }
});

async function preparePortrait() {
  const [atlas] = await Promise.all([
    new Promise((resolve, reject) => {
      const image = new Image();
      const timeout = setTimeout(() => { image.src = ''; reject(new Error('Portrait loading timed out')); }, 15000);
      image.onload = () => { clearTimeout(timeout); resolve(image); };
      image.onerror = () => { clearTimeout(timeout); reject(new Error('Head-turn atlas is unavailable')); };
      image.src = new URL(atlasUrl, import.meta.url).href;
    }),
    new Promise(resolve => {
      const timeout = setTimeout(resolve, 8000);
      Promise.allSettled([
        document.fonts.load('15px "JNSN Braille"', '⣿'),
        document.fonts.load('12px "JetBrains Mono"', 'LOADING'),
      ]).then(() => { clearTimeout(timeout); resolve(); });
    }),
  ]);
  portraitMotion = new PortraitMotion(atlas, source.width, source.height);
  state.ready = true;
  await changeMode();
}

async function start() {
  document.querySelectorAll('button, select, input').forEach(button => { button.disabled = true; });
  try {
    await replayLoader(preparePortrait());
  } catch (error) {
    setError(error);
    $('#loader').classList.add('is-hidden');
    document.body.classList.remove('loader-active');
    $('.preview-shell').inert = false;
    $('#loader-status').textContent = 'Animation unavailable';
  }
  finally {
    document.querySelectorAll('button, select, input').forEach(button => { button.disabled = !state.ready; });
    main.setAttribute('aria-busy', 'false');
  }
  if (state.ready && !reducedMotion.matches) play();
}
start();
