"""The painted silhouette ("canvas"): the painting segmented into figure and background, plus the
skull the painting hides under the fire (an ellipse fitted to the visible face). It was the
outline of the first, inflated bust (git history: tools/build_avatar.py before the sculpt) and is
the rest-pose silhouette the sculpt is fitted to. Cached in tools/avatar/work/canvas.npz."""
import math
import os

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
REF2 = os.path.join(ROOT, 'tools', 'reference2.webp')
WORK = os.path.join(HERE, 'work')

S12, OX, H1, W1 = 1.388, -39.0, 839.0, 1383.0
PAD_TOP, PAD_BOTTOM = 320, 340
SKULL_C = (1054.0, 339.0)
SKULL_R = (395.0, 375.0)
PITCH_DEG = 18.0
PX = 1.0 / (S12 * H1)          # reference2 px -> world units


def to_world(x2, y2):
    return ((np.asarray(x2) / S12 + OX) / H1, 1.0 - (np.asarray(y2) / S12) / H1)


def to_px(X, Y):
    return ((np.asarray(X) * H1 - OX) * S12, (1.0 - np.asarray(Y)) * H1 * S12)


def segment_figure(a):
    sm = ndi.gaussian_filter(a, (4, 4, 0))
    r, g, b = sm[..., 0], sm[..., 1], sm[..., 2]
    mx = sm.max(-1)
    mn = sm.min(-1)
    d = np.maximum(mx - mn, 1e-6)
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    s = (mx - mn) / np.maximum(mx, 1e-6)
    magma = ((h < 30) | (h > 335)) & (s > 0.45) & (mx > 0.3)
    pale = (s < 0.42) & (mx > 0.62)
    fig = ~(magma | pale)
    fig = ndi.binary_opening(fig, iterations=3)
    fig = ndi.binary_closing(fig, iterations=3)
    lab, n = ndi.label(fig)
    sizes = ndi.sum(fig, lab, range(1, n + 1))
    fig = lab == 1 + int(np.argmax(sizes))
    return ndi.binary_fill_holes(fig)


def skull_mask(shape, y0):
    H, W = shape
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    yy += y0
    a = math.radians(PITCH_DEG)
    fx, fy = math.cos(a), math.sin(a)
    dx = xx - SKULL_C[0]
    dy = yy - SKULL_C[1]
    u = dx * fx + dy * fy
    v = -dx * fy + dy * fx
    return (u / SKULL_R[0]) ** 2 + (v / SKULL_R[1]) ** 2 <= 1.0


def compute_canvas():
    a = np.asarray(Image.open(REF2).convert('RGB'), dtype=np.float32) / 255.0
    H2, W2, _ = a.shape
    fig = segment_figure(a)
    HC = H2 + PAD_TOP + PAD_BOTTOM
    y0 = -PAD_TOP
    canvas = np.zeros((HC, W2), bool)
    rows = np.arange(H2)[:, None]
    cols = np.arange(W2)[None, :]
    body = fig & ((rows > 640) | ((cols > 1150) & (rows > 240)))
    canvas[PAD_TOP:PAD_TOP + H2] = body
    canvas[PAD_TOP + H2 - 8:] = canvas[PAD_TOP + H2 - 9]
    for row in range(PAD_TOP + 980, HC):
        xs = np.nonzero(canvas[row])[0]
        if len(xs) < 2:
            continue
        runs = np.split(xs, np.where(np.diff(xs) > 1)[0] + 1)
        for r0, r1 in zip(runs[:-1], runs[1:]):
            if r1[0] - r0[-1] < 220 and r0[-1] < 760:
                canvas[row, r0[-1]:r1[0]] = True
    canvas |= skull_mask(canvas.shape, y0)
    canvas = ndi.binary_fill_holes(canvas)
    yy_, xx_ = np.mgrid[0:HC, 0:W2]
    corner = (xx_ < 1000) & (yy_ + y0 < 780) & (yy_ + y0 > 300)
    disk = (np.hypot(*np.mgrid[-70:71, -70:71]) <= 70)
    closed = ndi.binary_closing(canvas, structure=disk)
    canvas = np.where(corner, closed, canvas)
    canvas = ndi.gaussian_filter(canvas.astype(np.float32), 3.0) > 0.5
    return canvas, a, fig


def load_canvas():
    os.makedirs(WORK, exist_ok=True)
    p = os.path.join(WORK, 'canvas.npz')
    if os.path.exists(p):
        z = np.load(p)
        return z['canvas'], z['ref'].astype(np.float32) / 255.0
    canvas, a, _ = compute_canvas()
    np.savez_compressed(p, canvas=canvas, ref=(a * 255).astype(np.uint8))
    return canvas, a
