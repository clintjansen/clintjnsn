(() => {
  const art = document.querySelector('.portrait');
  const frame = art.parentElement;
  const loader = document.getElementById('loader');
  const digits = loader.querySelector('.loader__digits');
  const fill = loader.querySelector('.loader__rule > i');
  const status = document.getElementById('loader-status');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const minimumDuration = reducedMotion ? 0 : 2800;
  const start = performance.now();
  let fontsReady = false;
  let shown = -1;

  frame.setAttribute('aria-busy', 'true');

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
      loader.classList.add('is-done');
      setTimeout(() => {
        loader.classList.add('is-hidden');
        status.textContent = 'Loaded';
        frame.setAttribute('aria-busy', 'false');
      }, reducedMotion ? 0 : 360);
    }, reducedMotion ? 0 : 250);
  }

  function tick(now) {
    const progress = minimumDuration ? Math.min(1, (now - start) / minimumDuration) : 1;
    setProgress(fontsReady ? progress : Math.min(0.95, progress));
    if (fontsReady && progress >= 1) reveal();
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
