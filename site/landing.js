import './components/jnsn-wordmark.js';

(() => {
  const art = document.querySelector('.portrait');
  const frame = art.parentElement;
  const loader = document.getElementById('loader');
  const digits = loader.querySelector('.loader__digits');
  const fill = loader.querySelector('.loader__rule > i');
  const status = document.getElementById('loader-status');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let fontsReady = false;
  let shown = -1;

  frame.setAttribute('aria-busy', 'true');
  frame.inert = true;
  document.body.classList.add('loader-active');
  loader.classList.add('is-running');
  loader.dataset.phase = 'assembling';
  const start = performance.now();

  function fitArtwork() {
    // offset dimensions ignore the current transform, so repeated resizing is stable.
    const width = art.offsetWidth;
    const height = art.offsetHeight;
    if (!width || !height) return;
    const margin = Math.min(24, frame.clientWidth * 0.04, frame.clientHeight * 0.04);
    const scale = Math.min(
      (frame.clientWidth - margin * 2) / width,
      (frame.clientHeight - margin * 2) / height,
    );
    art.style.setProperty('--art-scale', Math.max(0.01, scale));
  }

  function setProgress(progress) {
    const next = Math.max(shown, Math.floor(Math.min(1, progress) * 100));
    if (next === shown) return;
    shown = next;
    digits.textContent = String(next);
    fill.style.width = next + '%';
  }

  function reveal() {
    setProgress(1);
    fitArtwork();
    setTimeout(() => {
      loader.dataset.phase = 'revealing';
      loader.classList.add('is-done');
      setTimeout(() => {
        loader.classList.add('is-hidden');
        loader.classList.remove('is-running');
        document.body.classList.remove('loader-active');
        status.textContent = 'Loaded';
        frame.setAttribute('aria-busy', 'false');
        frame.inert = false;
      }, reducedMotion.matches ? 0 : 840);
    }, reducedMotion.matches ? 0 : 320);
  }

  function tick(now) {
    const elapsed = reducedMotion.matches ? 1 : Math.min(1, (now - start) / 3400);
    const progress = 1 - Math.pow(1 - elapsed, 1.5);
    setProgress(fontsReady ? progress : Math.min(0.95, progress));
    const phase = elapsed < .6 ? 'assembling' : elapsed < .91 ? 'locked' : 'ready';
    if (loader.dataset.phase !== phase) {
      loader.dataset.phase = phase;
      document.getElementById('loader-phase').textContent = phase === 'locked' ? 'CHARACTER LOCKED IN' : 'MAKE AN IMPRESSION';
    }
    if (fontsReady && elapsed >= 1) reveal();
    else requestAnimationFrame(tick);
  }

  window.addEventListener('resize', fitArtwork);
  window.visualViewport?.addEventListener('resize', fitArtwork);
  document.fonts.addEventListener('loadingdone', fitArtwork);
  fitArtwork();
  setProgress(0);

  // A failed or stalled font must never leave the intro covering the portrait.
  let fontTimeout;
  Promise.race([
    Promise.allSettled([
      document.fonts.load('400 15px "JNSN Braille"', '\u28ff'),
      document.fonts.load('500 16px "JetBrains Mono"', '0123456789LOADING%'),
    ]),
    new Promise(resolve => { fontTimeout = setTimeout(resolve, 8000); }),
  ]).then(() => {
    clearTimeout(fontTimeout);
    fontsReady = true;
    fitArtwork();
  });

  // This loop ends with the intro. The portrait itself never animates.
  requestAnimationFrame(tick);
})();
