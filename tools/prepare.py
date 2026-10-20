#!/usr/bin/env python
"""
Prepare the WebGL textures for the JNSN landing page from the reference artwork.

The page never shows the reference directly: the fragment shader re-synthesises the
fine contour-line texture procedurally (so it stays crisp at any resolution and can
flow like magma) and takes only the *colour layout* and *region masks* from the art.

Input : tools/reference.webp
Output: src/tex/base.webp    RGB  colour base: glass card inpainted, line texture removed
        src/tex/detail.webp  RGB  glass card inpainted, NOT blurred (used for the sharp fox)
        src/tex/mask.webp    R person  G blue (fox + hair)  B magma (red); pale area = 1 - R - G - B
                                soft partition
        src/tex/fields.webp  R figure field (wide blur of person + blue, lines wrap around it)
                                G person, soft and saturated (sigma 12)   B blue, soft (sigma 20)
        src/tex/extra.webp   R hair region (blue pixels left of the crown split line)
                                G "shine" mask: hot orange/yellow highlights on the character
                                B baked line texture (high-pass of luminance, 128 = flat)
        src/tex/meta.json    measurements the runtime needs (image size, card rect, crown)
        tools/debug/*.png       visual checks of every intermediate

Run:  python tools/prepare.py          (needs:  pip install pillow numpy)
"""
import json
import os

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'tools', 'reference.webp')
OUT = os.path.join(ROOT, 'src', 'tex')
DBG = os.path.join(ROOT, 'tools', 'debug')

# Generous pixel box around the frosted card baked into the reference (x0, y0, x1, y1).
CARD = (150, 266, 1216, 597)
# Blue pixels left of this x (px) are the character's hair, right of it the spirit fox.
HAIR_SPLIT_X = 520
# Where the flames are born (normalised, y-down): the crown of the head, just above the card.
CROWN = (0.355, 0.235)

LINE_SIGMA = 5.0      # blur that removes the ~11 px line texture from the colour base
MASK_FEATHER = 3.0    # softness of the region partition edges


# ----------------------------------------------------------------------------- helpers

def gauss(a, sigma):
    """Gaussian blur of a float32 (H,W) or (H,W,C) array via FFT, edge-replicated borders."""
    if sigma <= 0:
        return a.astype(np.float32).copy()
    if a.ndim == 3:
        return np.stack([gauss(a[..., c], sigma) for c in range(a.shape[-1])], -1)
    pad = int(np.ceil(sigma * 3))
    p = np.pad(a.astype(np.float64), pad, mode='edge')
    H, W = p.shape
    fy = np.fft.fftfreq(H)
    fx = np.fft.rfftfreq(W)
    # Fourier transform of a Gaussian kernel (unit area): exp(-2 pi^2 sigma^2 f^2)
    k = np.exp(-2.0 * np.pi ** 2 * sigma ** 2 * (fy[:, None] ** 2 + fx[None, :] ** 2))
    out = np.fft.irfft2(np.fft.rfft2(p) * k, s=(H, W))
    return out[pad:pad + a.shape[0], pad:pad + a.shape[1]].astype(np.float32)


def flood_from(mask, seeds):
    """Pixels of a boolean mask connected (4-neighbourhood) to any seed pixel inside the mask."""
    im = Image.fromarray(np.where(mask, 255, 0).astype(np.uint8)).copy()  # numpy-backed images are read-only
    for (x, y) in seeds:
        if mask[y, x]:
            ImageDraw.floodfill(im, (x, y), 128)
    return np.asarray(im) == 128


def region_blur(img, onehot, sigma):
    """Blur colours inside each region only, so region boundaries stay pixel-sharp."""
    out = np.zeros_like(img)
    for k in range(onehot.shape[-1]):
        w = onehot[..., k]
        if w.max() <= 0:
            continue
        num = gauss(img * w[..., None], sigma)
        den = gauss(w, sigma)[..., None]
        out += np.where(den > 1e-4, num / np.maximum(den, 1e-4), 0.0) * w[..., None]
    return out


def line_period(lum, box):
    """Dominant period (px) of the line texture inside a (x0, y0, x1, y1) box, via row FFT."""
    x0, y0, x1, y1 = box
    rows = lum[y0:y1, x0:x1]
    rows = rows - rows.mean(axis=1, keepdims=True)
    spec = np.abs(np.fft.rfft(rows, axis=1)).mean(axis=0)
    freqs = np.fft.rfftfreq(rows.shape[1])
    spec[freqs < 1.0 / 40.0] = 0  # ignore slow gradients
    return 1.0 / freqs[np.argmax(spec)]


def resize(a, size):
    """Bilinear resize of a float32 array to (w, h)."""
    if a.ndim == 2:
        im = Image.fromarray(np.ascontiguousarray(a, dtype=np.float32))
        return np.asarray(im.resize(size, Image.BILINEAR), dtype=np.float32)
    return np.stack([resize(a[..., c], size) for c in range(a.shape[-1])], -1)


def diffuse(values, known, iters):
    """Jacobi relaxation: every unknown pixel becomes the mean of its 4 neighbours."""
    v = values.copy()
    free = ~known
    for _ in range(iters):
        n = np.empty_like(v)
        n[1:-1] = v[:-2] + v[2:]
        n[0] = v[0] + v[1]
        n[-1] = v[-2] + v[-1]
        m = np.empty_like(v)
        m[:, 1:-1] = v[:, :-2] + v[:, 2:]
        m[:, 0] = v[:, 0] + v[:, 1]
        m[:, -1] = v[:, -2] + v[:, -1]
        avg = (n + m) * 0.25
        v[free] = avg[free]
    return v


def membrane_fill(values, known, iters=(1500, 160, 80, 40, 20, 14)):
    """
    Multi-scale membrane fill (Laplace interpolation) of the unknown pixels.
    Solves the coarsest pyramid level to convergence, then uses each solution,
    upsampled, as the starting point of the next finer level.
    """
    pyr = [(values, known)]
    while len(pyr) < len(iters) and min(pyr[-1][1].shape) > 24:
        v, k = pyr[-1]
        h2, w2 = k.shape[0] // 2, k.shape[1] // 2
        k2 = resize(k.astype(np.float32), (w2, h2)) > 0.999  # coarse pixel known only if fully known
        v2 = resize(v, (w2, h2))
        pyr.append((v2, k2))
    sol = None
    for level in range(len(pyr) - 1, -1, -1):
        v, k = pyr[level]
        if sol is not None:
            up = resize(sol, (k.shape[1], k.shape[0]))
            v = np.where(k[..., None] if v.ndim == 3 else k, v, up)
        else:
            fill = v[k].mean(axis=0)
            v = np.where(k[..., None] if v.ndim == 3 else k, v, fill)
        sol = diffuse(v, k, iters[len(pyr) - 1 - level])
    return sol


def rgb_to_hsv(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx = a.max(-1)
    mn = a.min(-1)
    d = np.maximum(mx - mn, 1e-6)
    s = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    h = np.where(mx == r, ((g - b) / d) % 6.0, np.where(mx == g, (b - r) / d + 2.0, (r - g) / d + 4.0)) * 60.0
    return h, s, mx


def save_webp(path, arr, lossless):
    im = Image.fromarray(np.clip(arr * 255.0 + 0.5, 0, 255).astype(np.uint8))
    im.save(path, 'WEBP', lossless=lossless, quality=100 if lossless else 92, method=6, exact=True)
    return os.path.getsize(path)


def save_png(path, arr):
    Image.fromarray(np.clip(arr * 255.0 + 0.5, 0, 255).astype(np.uint8)).save(path)


# ----------------------------------------------------------------------------- pipeline

def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(DBG, exist_ok=True)

    img = np.asarray(Image.open(SRC).convert('RGB'), dtype=np.float32) / 255.0
    H, W, _ = img.shape
    print(f'reference {W}x{H}')

    x0, y0, x1, y1 = CARD
    outside_card = np.ones((H, W), dtype=bool)
    outside_card[y0:y1, x0:x1] = False

    # ---- 1. classify regions on the line-free (blurred) colours -------------------------
    smooth = gauss(img, LINE_SIGMA)
    h, s, v = rgb_to_hsv(smooth)
    magma = ((h < 28) | (h > 335)) & (s > 0.50) & (v > 0.30)
    white = (s < 0.33) & (v > 0.68)
    blue = (h >= 175) & (h <= 275) & (s > 0.30) & (v > 0.60)
    person = (h >= 200) & (h <= 290) & (v <= 0.60) & ((s > 0.30) | (v < 0.30))
    person |= v < 0.20
    person &= ~white & ~magma & ~blue

    onehot = np.stack([person, blue, magma, white], -1).astype(np.float32)   # R G B A
    known = onehot.sum(-1) > 0.5
    known &= outside_card
    print(f'labelled {known.mean() * 100:.1f}% of pixels directly; filling the rest')

    # ---- 2. propagate labels into fringes and under the card ---------------------------
    soft = membrane_fill(onehot, known)
    labels = soft.argmax(-1)
    P, B, M, Wt = 0, 1, 2, 3
    xs_ = np.arange(W)[None, :]
    ys_ = np.arange(H)[:, None]
    border = [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1), (W // 2, 0), (W - 1, H // 2), (0, H // 2)]
    # Light-blue tints inside the pale right-hand area belong to that area, not to the fox.
    labels[(labels == B) & (xs_ > 1050) & (ys_ > 300)] = Wt
    # The pale top of the fox is part of the blue layer.
    labels[(labels == Wt) & (ys_ < 290) & (xs_ < 1040)] = B
    # The fox lives at the top; blue below the head (collar glow, shoulder reflections) is the character's.
    labels[(labels == B) & (ys_ > 520)] = P
    for _ in range(2):
        # Magma not connected to the background magma: orange flame tongues in the hair (top)
        # or hot reflections on the character (bottom).
        magma_bg = flood_from(labels == M, border)
        isolated = (labels == M) & ~magma_bg
        labels[isolated & (ys_ < 300)] = B
        labels[isolated & (ys_ >= 300)] = P
        # Anything fully enclosed by the character moves with him: fill holes.
        not_person = labels != P
        reachable = flood_from(not_person, border)
        labels[not_person & ~reachable] = P
    # Thin dark outlines and far-away dark blobs are not the character: keep the body and the
    # crown island only, and let everything else take the label of its surroundings.
    body = flood_from(labels == P, [(650, 700), (515, 250), (520, 255), (500, 245)])
    stray = (labels == P) & ~body
    onehot_fix = np.eye(4, dtype=np.float32)[labels]
    onehot_fix = membrane_fill(onehot_fix, ~stray)
    labels = np.where(stray, onehot_fix[..., 1:].argmax(-1) + 1, labels)
    # Image border rows/columns carry encoder artefacts: copy the neighbouring ring over them.
    labels[:2] = labels[2]
    labels[-2:] = labels[-3]
    labels[:, :2] = labels[:, 2:3]
    labels[:, -2:] = labels[:, -3:-2]
    onehot = np.eye(4, dtype=np.float32)[labels]

    # ---- 3. soft partition masks --------------------------------------------------------
    mask = gauss(onehot, MASK_FEATHER)
    mask /= np.maximum(mask.sum(-1, keepdims=True), 1e-6)

    # ---- 4. colour base: inpaint the card, then remove the line texture ------------------
    detail_rgb = membrane_fill(img, outside_card)
    lum0 = detail_rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    period = line_period(lum0, (20, 380, 220, 520))
    print(f'row-crossing line period ~{period:.1f} px (true spacing ~11 px); base blur sigma {LINE_SIGMA}')
    base_rgb = region_blur(detail_rgb, onehot, LINE_SIGMA)

    # ---- 5. shine: hot orange/yellow highlights on or next to the character --------------
    h2, s2, v2 = rgb_to_hsv(img)
    hot = (h2 >= 20) & (h2 <= 62) & (s2 > 0.55) & (v2 > 0.66)
    near_person = gauss(onehot[..., 0], 14.0) > 0.03
    shine = gauss((hot & near_person & outside_card).astype(np.float32), 1.5)
    shine = np.clip(shine * 1.6, 0, 1)

    # ---- 6. baked line texture (high-pass luminance) for optional use on the character ---
    lum = detail_rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    highpass = lum - gauss(lum, LINE_SIGMA)
    baked = np.clip(0.5 + highpass * 3.0, 0, 1)

    # ---- 7. helper fields --------------------------------------------------------------
    figure = onehot[..., 0] + onehot[..., 1]
    fields = np.stack([
        np.clip(gauss(figure, 40.0), 0, 1),
        np.clip(gauss(onehot[..., 0], 12.0) * 1.6, 0, 1),
        np.clip(gauss(onehot[..., 1], 20.0), 0, 1),
    ], -1)
    # Wide and soft: the flames fade across the split instead of stopping at a line.
    hair = np.clip(gauss(onehot[..., 1] * (np.arange(W)[None, :] < HAIR_SPLIT_X), 28.0) * 1.3, 0, 1)
    extra = np.stack([hair, shine, baked], -1)

    # ---- 8. write textures (RGB only: colour hidden under alpha 0 is not safe in WebGL) ---
    sizes = {
        'base.webp': save_webp(os.path.join(OUT, 'base.webp'), base_rgb, lossless=False),
        'detail.webp': save_webp(os.path.join(OUT, 'detail.webp'), detail_rgb, lossless=False),
        'mask.webp': save_webp(os.path.join(OUT, 'mask.webp'), mask[..., :3], lossless=True),
        'fields.webp': save_webp(os.path.join(OUT, 'fields.webp'), fields, lossless=True),
        'extra.webp': save_webp(os.path.join(OUT, 'extra.webp'), extra, lossless=False),
    }
    for k, n in sizes.items():
        print(f'  {k:12s} {n / 1024:7.0f} KB')

    ys, xs = np.nonzero(onehot[..., 0] > 0.5)
    person_box = [float(xs.min() / W), float(ys.min() / H), float(xs.max() / W), float(ys.max() / H)]
    ys, xs = np.nonzero(onehot[..., 1] > 0.5)
    blue_box = [float(xs.min() / W), float(ys.min() / H), float(xs.max() / W), float(ys.max() / H)]
    meta = {
        'width': W, 'height': H,
        'card': [x0 / W, y0 / H, x1 / W, y1 / H],
        'crown': list(CROWN),
        'linePeriod': float(period),
        'hairSplitX': HAIR_SPLIT_X / W,
        'personBox': person_box,
        'blueBox': blue_box,
        'coverage': {k: float(onehot[..., i].mean()) for i, k in enumerate(['person', 'blue', 'magma', 'white'])},
    }
    with open(os.path.join(OUT, 'meta.json'), 'w') as f:
        json.dump(meta, f, indent=2)
    print('meta', json.dumps(meta['coverage']))

    # ---- 9. debug images -----------------------------------------------------------------
    palette = np.array([[0.1, 0.1, 0.4], [0.3, 0.7, 1.0], [0.9, 0.2, 0.1], [0.95, 0.95, 0.9]], dtype=np.float32)
    save_png(os.path.join(DBG, 'labels.png'), onehot @ palette)
    save_png(os.path.join(DBG, 'labels_direct.png'), np.where(known[..., None], np.stack([person, blue, magma, white], -1).astype(np.float32) @ palette, 0.0))
    save_png(os.path.join(DBG, 'base.png'), base_rgb)
    save_png(os.path.join(DBG, 'detail.png'), detail_rgb)
    save_png(os.path.join(DBG, 'mask.png'), mask[..., :3])
    save_png(os.path.join(DBG, 'fields.png'), fields)
    save_png(os.path.join(DBG, 'hair.png'), np.repeat(hair[..., None], 3, -1))
    save_png(os.path.join(DBG, 'shine.png'), np.repeat(shine[..., None], 3, -1))
    save_png(os.path.join(DBG, 'baked.png'), np.repeat(baked[..., None], 3, -1))
    print('debug images in', DBG)


if __name__ == '__main__':
    main()
