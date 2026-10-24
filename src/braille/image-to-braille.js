const DOT_BITS = [[1, 8], [2, 16], [4, 32], [64, 128]];

/**
 * Create an image/canvas/video → Unicode Braille converter.
 * Its returned function produces selectable text; it does not draw the output.
 * Default settings preserve the smile preview's 120 × 68 character grid.
 */
export function createBrailleConverter({ columns: cols = 120, rows = 68, blackPoint = 26, contrast = 1.22 } = {}) {
  if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
    throw new RangeError('columns and rows must be positive integers');
  }
  if (!Number.isFinite(blackPoint) || !Number.isFinite(contrast) || contrast <= 0) {
    throw new RangeError('blackPoint must be finite and contrast must be positive');
  }
  const sample = document.createElement('canvas');
  const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
  if (!sampleCtx) throw new Error('Canvas 2D is unavailable');
  return function toBraille(canvas) {
    const width = cols * 2;
    const height = rows * 4;
    sample.width = width;
    sample.height = height;
    sampleCtx.drawImage(canvas, 0, 0, width, height);
    const rgba = sampleCtx.getImageData(0, 0, width, height).data;
    const gray = new Float32Array(width * height);
    for (let i = 0; i < gray.length; i++) {
      // Keep bright teeth clean while retaining the face's midtone detail.
      const luminance = (2126 * rgba[i * 4] + 7152 * rgba[i * 4 + 1] + 722 * rgba[i * 4 + 2]) / 10000;
      gray[i] = Math.max(0, Math.min(255, (luminance - blackPoint) * contrast));
    }
    const dots = new Uint8Array(width * height);
    // Floyd–Steinberg diffusion keeps this a real 2 × 4 dot mapping, not a ramp.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const value = gray[i] < 128 ? 0 : 255;
        dots[i] = value === 0 ? 1 : 0;
        const error = gray[i] - value;
        if (x + 1 < width) gray[i + 1] += error * 7 / 16;
        if (y + 1 < height) {
          if (x > 0) gray[i + width - 1] += error * 3 / 16;
          gray[i + width] += error * 5 / 16;
          if (x + 1 < width) gray[i + width + 1] += error / 16;
        }
      }
    }
    const lines = [];
    for (let row = 0; row < rows; row++) {
      let line = '';
      for (let col = 0; col < cols; col++) {
        let bits = 0;
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            if (dots[(row * 4 + dy) * width + col * 2 + dx]) bits |= DOT_BITS[dy][dx];
          }
        }
        line += String.fromCodePoint(0x2800 + bits);
      }
      lines.push(line);
    }
    return lines.join('\n');
  };
}
