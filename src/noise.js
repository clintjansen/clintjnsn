/**
 * noise.js — a tiling noise texture so the fragment shader can build fbm from a couple of
 * texture fetches instead of ~100 ALU ops per octave (integrated GPUs are fill-rate bound).
 *
 * 512x512 RGBA, each channel an independent 2-octave periodic gradient noise in [0, 1]
 * (cells of 64 and 32 texels). The shader samples it at p / 8, so one texture = 8 cells =
 * 8 units of its noise space, exactly like the procedural version it replaced.
 */

import * as THREE from 'three';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Periodic gradient noise on a grid of `cells` x `cells`, evaluated for every texel. */
function gradientNoise(size, cells, rand, out, stride, offset, amplitude) {
  const gx = new Float32Array(cells * cells);
  const gy = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) {
    const a = rand() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const scale = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * scale;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const vy = fade(ty);
    const y1 = (y0 + 1) % cells;
    for (let x = 0; x < size; x++) {
      const fx = x * scale;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const vx = fade(tx);
      const x1 = (x0 + 1) % cells;
      const i00 = y0 * cells + x0, i10 = y0 * cells + x1, i01 = y1 * cells + x0, i11 = y1 * cells + x1;
      const d00 = gx[i00] * tx + gy[i00] * ty;
      const d10 = gx[i10] * (tx - 1) + gy[i10] * ty;
      const d01 = gx[i01] * tx + gy[i01] * (ty - 1);
      const d11 = gx[i11] * (tx - 1) + gy[i11] * (ty - 1);
      const n = (d00 + (d10 - d00) * vx) + ((d01 + (d11 - d01) * vx) - (d00 + (d10 - d00) * vx)) * vy;
      out[(y * size + x) * stride + offset] += n * amplitude;
    }
  }
}

export function createNoiseTexture({ size = 512, seed = 1337 } = {}) {
  const rand = mulberry32(seed);
  const acc = new Float32Array(size * size * 4);
  for (let ch = 0; ch < 4; ch++) {
    gradientNoise(size, 8, rand, acc, 4, ch, 1.0);
    gradientNoise(size, 16, rand, acc, 4, ch, 0.5);
  }
  // Gradient noise peaks near +-0.7 per octave; map the 2-octave sum into 0..255.
  const data = new Uint8Array(size * size * 4);
  const norm = 1 / (0.7 * 1.5);
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(-1, Math.min(1, acc[i] * norm));
    data[i] = Math.round((v * 0.5 + 0.5) * 255);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
