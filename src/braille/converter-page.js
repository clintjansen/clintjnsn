import '../components/jnsn-wordmark.js';
import { createBrailleConverter } from './image-to-braille.js';

const $ = selector => document.querySelector(selector);
// The smile lab uses ES modules and needs the local server when this file is opened from disk.
if (location.protocol === 'file:') $('#smile-preview-link').href = 'http://127.0.0.1:5192/tools/smile-lab/';
const fileInput = $('#image-file');
const original = $('#original-image');
const art = $('#braille-output');
const stage = $('#output-stage');
const work = document.createElement('canvas');
const context = work.getContext('2d', { willReadFrequently: true });
const measurement = document.createElement('canvas').getContext('2d');
const fontReady = document.fonts.load('400 15px "JNSN Braille"', '⣿');
const types = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'image/bmp']);
const exportButtons = ['#copy-text', '#save-text', '#save-png'].map($);
let image = null;
let imageUrl = null;
let imageName = '';
let text = '';
let columns = 120;
let rows = 68;
let loadTicket = 0;
let pendingRender = 0;
let currentConverter = null;
let converterKey = '';

function error(message = '') { $('#error').textContent = message; $('#error').hidden = !message; }
function status(message) { $('#status').textContent = message; }
function enableImageControls(enabled) {
  $('#settings').disabled = !enabled;
  $('#clear-image').disabled = !enabled;
  exportButtons.forEach(button => { button.disabled = !enabled; });
}

function fit() {
  if (!image || art.hidden || stage.classList.contains('actual')) return;
  const scale = Math.min((stage.clientWidth - 32) / art.offsetWidth, (stage.clientHeight - 32) / art.offsetHeight);
  art.style.setProperty('--art-scale', Math.max(.001, scale));
}

function setView(actual) {
  stage.classList.toggle('actual', actual);
  $('#view-fit').setAttribute('aria-pressed', String(!actual));
  $('#view-actual').setAttribute('aria-pressed', String(actual));
  stage.scrollTo(0, 0);
  fit();
}

function settingsLabels() {
  $('#detail-value').textContent = $('#detail').value + ' columns';
  $('#contrast-value').textContent = (Number($('#contrast').value) / 100).toFixed(2) + '×';
  $('#shadows-value').textContent = $('#shadows').value;
}

function render() {
  pendingRender = 0;
  if (!image) return;
  try {
    measurement.font = '400 15px "JNSN Braille"';
    const cellAspect = measurement.measureText('⣿').width / (15 * 1.15);
    const aspect = image.naturalWidth / image.naturalHeight;
    columns = Number($('#detail').value);
    rows = Math.max(1, Math.round(columns * cellAspect / aspect));
    // Keep extremely tall images manageable while preserving their proportions.
    if (rows > 600) {
      columns = Math.max(1, Math.floor(600 * aspect / cellAspect));
      rows = Math.max(1, Math.min(600, Math.round(columns * cellAspect / aspect)));
    }
    const dark = $('#dark-paper').checked;
    work.width = columns * 2;
    work.height = rows * 4;
    context.fillStyle = dark ? '#000' : '#fff';
    context.fillRect(0, 0, work.width, work.height);
    context.filter = dark ? 'invert(1)' : 'none';
    context.drawImage(image, 0, 0, work.width, work.height);
    context.filter = 'none';
    const blackPoint = Number($('#shadows').value);
    const contrast = Number($('#contrast').value) / 100;
    const key = [columns, rows, blackPoint, contrast].join(':');
    if (key !== converterKey) {
      currentConverter = createBrailleConverter({ columns, rows, blackPoint, contrast });
      converterKey = key;
    }
    text = currentConverter(work);
    art.textContent = text;
    art.hidden = false;
    $('#empty-output').hidden = true;
    stage.classList.toggle('dark', dark);
    $('#braille-meta').textContent = columns + ' × ' + rows + ' characters · selectable text';
    fit();
    exportButtons.forEach(button => { button.disabled = false; });
  } catch (problem) {
    error('Could not convert this image. ' + problem.message);
    exportButtons.forEach(button => { button.disabled = true; });
  }
}

function scheduleRender() {
  settingsLabels();
  if (!pendingRender) pendingRender = requestAnimationFrame(render);
}

async function loadImage(file) {
  if (!file) return;
  if (!types.has(file.type)) {
    error('Choose a PNG, JPG, WebP, AVIF, GIF or BMP image.');
    return;
  }
  const ticket = ++loadTicket;
  const url = URL.createObjectURL(file);
  const candidate = new Image();
  error();
  status('Opening image…');
  try {
    candidate.src = url;
    await Promise.all([candidate.decode(), fontReady]);
    if (ticket !== loadTicket) { URL.revokeObjectURL(url); return; }
    if (!candidate.naturalWidth || !candidate.naturalHeight) throw new Error('The image has no dimensions.');
    const previousUrl = imageUrl;
    image = candidate;
    imageUrl = url;
    imageName = file.name || 'image';
    original.src = url;
    original.alt = 'Original image: ' + imageName;
    original.hidden = false;
    $('#drop-button').hidden = true;
    $('#filename').textContent = imageName;
    $('#filename').title = imageName;
    $('#original-meta').textContent = image.naturalWidth + ' × ' + image.naturalHeight + ' pixels';
    $('#choose-image').innerHTML = 'Replace image <span>↗</span>';
    enableImageControls(true);
    render();
    status('Ready. Adjust the settings or save your character art.');
    if (previousUrl) URL.revokeObjectURL(previousUrl);
  } catch (problem) {
    URL.revokeObjectURL(url);
    if (ticket !== loadTicket) return;
    error('This image could not be opened. Try another image or format.');
    status(image ? 'Your previous image is still open.' : 'Choose an image to begin.');
  }
}

function clearImage() {
  ++loadTicket;
  cancelAnimationFrame(pendingRender);
  pendingRender = 0;
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = null;
  image = null;
  imageName = '';
  text = '';
  fileInput.value = '';
  original.removeAttribute('src');
  original.alt = '';
  original.hidden = true;
  $('#drop-button').hidden = false;
  $('#filename').textContent = 'NO IMAGE SELECTED';
  $('#filename').removeAttribute('title');
  $('#original-meta').textContent = 'PNG, JPG, WebP, AVIF, GIF or BMP';
  $('#braille-meta').textContent = 'Image proportions are preserved';
  $('#empty-output').hidden = false;
  art.textContent = '';
  art.hidden = true;
  work.width = work.height = 1;
  $('#choose-image').innerHTML = 'Choose image <span>↗</span>';
  enableImageControls(false);
  error();
  status('Choose an image to begin.');
}

function download(blob, suffix) {
  const stem = imageName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'image';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = stem + '-braille.' + suffix;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#choose-image').addEventListener('click', () => fileInput.click());
$('#drop-button').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { loadImage(fileInput.files[0]); fileInput.value = ''; });
$('#clear-image').addEventListener('click', clearImage);
['#detail', '#contrast', '#shadows', '#dark-paper'].forEach(selector => $(selector).addEventListener('input', scheduleRender));
$('#reset-settings').addEventListener('click', () => {
  $('#detail').value = '120';
  $('#contrast').value = '122';
  $('#shadows').value = '26';
  $('#dark-paper').checked = false;
  setView(false);
  scheduleRender();
});
$('#view-fit').addEventListener('click', () => setView(false));
$('#view-actual').addEventListener('click', () => setView(true));

document.addEventListener('dragover', event => {
  if ([...event.dataTransfer.items].some(item => item.kind === 'file')) {
    event.preventDefault();
    $('#drop-area').classList.add('drag-over');
  }
});
document.addEventListener('dragleave', event => { if (!event.relatedTarget) $('#drop-area').classList.remove('drag-over'); });
document.addEventListener('drop', event => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  $('#drop-area').classList.remove('drag-over');
  loadImage(event.dataTransfer.files[0]);
});
document.addEventListener('paste', event => {
  const file = [...event.clipboardData.files].find(item => types.has(item.type));
  if (file) { event.preventDefault(); loadImage(file); }
});

$('#copy-text').addEventListener('click', async () => {
  if (!text) return;
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const field = document.createElement('textarea');
      field.value = text;
      field.style.cssText = 'position:fixed;left:-10000px;top:0';
      document.body.append(field);
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      if (!copied) throw new Error('Clipboard unavailable');
    }
    status('Braille text copied.');
  } catch { status('Clipboard unavailable here. Select the character art to copy it, or save the .txt file.'); }
});
$('#save-text').addEventListener('click', () => { if (text) download(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'txt'); });
$('#save-png').addEventListener('click', async () => {
  if (!text) return;
  const button = $('#save-png');
  button.disabled = true;
  error();
  try {
    await fontReady;
    const font = '400 15px "JNSN Braille"';
    measurement.font = font;
    const width = Math.ceil(measurement.measureText(text.split('\n')[0]).width);
    const height = Math.ceil(rows * 15 * 1.15);
    const padding = 24;
    const scale = Math.max(width, height) < 4000 ? 2 : 1;
    const png = document.createElement('canvas');
    png.width = (width + padding * 2) * scale;
    png.height = (height + padding * 2) * scale;
    const pen = png.getContext('2d');
    pen.scale(scale, scale);
    const dark = $('#dark-paper').checked;
    pen.fillStyle = dark ? '#111' : '#fff';
    pen.fillRect(0, 0, width + padding * 2, height + padding * 2);
    pen.fillStyle = dark ? '#fff' : '#000';
    pen.font = font;
    pen.textBaseline = 'top';
    text.split('\n').forEach((line, index) => pen.fillText(line, padding, padding + index * 15 * 1.15));
    const blob = await new Promise(resolve => png.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not create the PNG.');
    download(blob, 'png');
    status('PNG saved with the Braille font and spacing.');
  } catch (problem) { error('Could not save the PNG. ' + problem.message); }
  finally { button.disabled = !image; }
});

new ResizeObserver(fit).observe(stage);
document.fonts.addEventListener('loadingdone', () => { if (image) scheduleRender(); });
window.addEventListener('pagehide', () => { if (imageUrl) URL.revokeObjectURL(imageUrl); });
settingsLabels();
