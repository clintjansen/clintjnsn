"""Grid set-up, body tables from the painted rows, narrow-band evaluation of the sculpt, the
2D outline warp, and the canvas prism."""
import math
import os
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from scipy import ndimage as ndi

import sculpt as SC
from canvas import PAD_TOP, S12, H1, OX

K_PX = S12 * H1            # world units -> ref2 px (1164.5)


def smooth1d(v, s):
    return ndi.gaussian_filter1d(np.asarray(v, np.float64), s, mode='nearest')


def body_tables(canvas, top=470, inset_top=34):
    """rows y2 = top .. bottom of the canvas: back edge, front edge, half width, exponent, taper"""
    HC, W2 = canvas.shape
    ys = np.arange(top, HC - PAD_TOP)
    xb = np.zeros(len(ys)); xf = np.zeros(len(ys))
    for i, y in enumerate(ys):
        row = canvas[y + PAD_TOP]
        xs = np.nonzero(row)[0]
        runs = np.split(xs, np.where(np.diff(xs) > 1)[0] + 1)
        xb[i] = runs[0][0]
        xf[i] = runs[0][-1]
    # back edge: the painted nape / back; above the nape notch inset into the skull
    inset = inset_top * (1 - SC.smoothstep(540.0, 610.0, ys.astype(np.float64)))
    xb = xb + inset
    # front edge: the painted throat below the chin; above it the throat line continues up
    # behind the jaw (inside the head)
    y_fit = (ys >= 905) & (ys <= 950)
    k, b = np.polyfit(ys[y_fit], xf[y_fit], 1)
    ext = np.minimum(k * ys + b, 1085.0)
    t = SC.smoothstep(890.0, 910.0, ys.astype(np.float64))
    xf = np.where(ys < 960, ext * (1 - t) + xf * t, xf)
    xf = np.where(ys < 905, ext, xf)
    xb_s = smooth1d(xb, 45.0)
    xf_s = smooth1d(xf, 45.0)
    # the painted rows carry ~0.5 px of segmentation noise; its derivative tilts the normals into
    # horizontal bands, so the 3D shape uses smoother rows (the warp + trim restore the outline)
    xb = smooth1d(xb, 7.0)
    xf = smooth1d(xf, 6.0)

    # the soft rows never reach past the painted ones (the side view stays the painting): a soft
    # max/min, so the clamp adds no kinks of its own
    def soft_max(a, b, k=6.0):
        return 0.5 * (a + b + np.sqrt((a - b) ** 2 + k * k)) - 0.5 * k
    xb_s = soft_max(xb_s, xb - 12.0, 10.0)
    xf_s = -soft_max(-xf_s, -(xf + 12.0), 10.0)
    yy = ys.astype(np.float64)
    w = 182.0 + 16.0 * np.exp(-((yy - 650.0) / 90.0) ** 2)     # fuller under the skull (behind the jaw)
    w = w + (470.0 - 182.0) * SC.smoothstep(960.0, 1440.0, yy) + 50.0 * SC.smoothstep(1350.0, 1500.0, yy)
    w = w * (0.80 + 0.20 * SC.smoothstep(470.0, 640.0, yy))     # the column flows into the occiput
    n = 2.15 + 0.75 * SC.smoothstep(1000.0, 1400.0, yy)
    taper = 0.07 - 0.03 * SC.smoothstep(1000.0, 1400.0, yy)
    return SC.Body(ys, xb, xf, xb_s, xf_s, w, n, taper)


class Grid:
    def __init__(self, canvas, step_px, zmax_px=640.0, margin_px=40.0):
        ys, xs = np.nonzero(canvas)
        x0 = xs.min() - margin_px; x1 = xs.max() + margin_px
        y0 = ys.min() - PAD_TOP - margin_px; y1 = ys.max() - PAD_TOP + margin_px + 30
        self.step = float(step_px)
        self.x = np.arange(x0, x1 + step_px, step_px, dtype=np.float32)      # ref2 x
        self.y = np.arange(y0, y1 + step_px, step_px, dtype=np.float32)      # ref2 y (down)
        self.z = np.arange(-zmax_px, zmax_px + step_px, step_px, dtype=np.float32)
        self.shape = (len(self.x), len(self.y), len(self.z))


def _eval_chunk(args):
    xs, y, z, body, P, warps = args
    X, Y, Z = np.meshgrid(xs, y, z, indexing='ij')
    X, Y = apply_warps(X, Y, warps, Z)
    return SC.sculpt(X, Y, Z, body, P).astype(np.float32)


def _eval_points(args):
    X, Y, Z, body, P, warps = args
    X, Y = apply_warps(X, Y, warps, Z)
    return SC.sculpt(X, Y, Z, body, P).astype(np.float32)


def apply_warps(X, Y, warps, Z=None):
    """pull-back through the warps (last first): p <- p - D(p). A warp with a z-sigma acts only
    near the midline plane (weight exp(-(z / zsig)^2)): it corrects the side-view outline (formed
    at z ~ 0) without moving the rest of the surface."""
    for wp in reversed(warps):
        dx, dy = wp.sample(X, Y)
        if wp.zsig is not None and Z is not None:
            wz = np.exp(-(Z / np.float32(wp.zsig)) ** 2)
            dx = dx * wz
            dy = dy * wz
        X = X - dx
        Y = Y - dy
    return X, Y


class Warp:
    """a 2D displacement field on a ref2 pixel lattice (canvas coordinates)"""

    def __init__(self, dx, dy, x0, y0, h, zsig=None):
        self.dx = dx.astype(np.float32); self.dy = dy.astype(np.float32)
        self.x0, self.y0, self.h = x0, y0, h
        self.zsig = zsig

    def sample(self, X, Y):
        ix = (X - self.x0) / self.h
        iy = (Y - self.y0) / self.h
        sh = X.shape
        c = [iy.ravel(), ix.ravel()]
        return (ndi.map_coordinates(self.dx, c, order=1, mode='nearest').reshape(sh),
                ndi.map_coordinates(self.dy, c, order=1, mode='nearest').reshape(sh))


def evaluate(grid, body, P, warps=(), workers=16, band_cells=2.5, coarse=4):
    """sculpt on the grid: coarse pass, then exact values in a narrow band around the surface
    (numpy releases the GIL, so threads parallelise well)"""
    gx, gy, gz = grid.x, grid.y, grid.z
    cx, cy, cz = gx[::coarse], gy[::coarse], gz[::coarse]
    warps = list(warps)
    with ThreadPoolExecutor(workers) as ex:
        parts = list(ex.map(_eval_chunk, [(cx[i:i + 1], cy, cz, body, P, warps) for i in range(len(cx))]))
    Fc = np.concatenate(parts, 0)
    fx = np.arange(len(gx)) / coarse
    fy = np.arange(len(gy)) / coarse
    fz = np.arange(len(gz)) / coarse
    F = np.empty(grid.shape, np.float32)

    def up(i0):
        sl = slice(i0, min(i0 + 8, len(gx)))
        I, J, K = np.meshgrid(fx[sl], fy, fz, indexing='ij')
        F[sl] = ndi.map_coordinates(Fc, [I, J, K], order=1, mode='nearest')
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(up, range(0, len(gx), 8)))
    band = band_cells * coarse * grid.step * 1.8
    idx = np.nonzero(np.abs(F) < band)
    n = len(idx[0])
    cs = 65536
    def run(i):
        s = slice(i, i + cs)
        return _eval_points((gx[idx[0][s]], gy[idx[1][s]], gz[idx[2][s]], body, P, warps))
    with ThreadPoolExecutor(workers) as ex:
        vals = list(ex.map(run, range(0, n, cs)))
    F[idx] = np.concatenate(vals)
    return F, n


def projection(F):
    """2D field (x, y) = min over z: its zero level is the side-view outline"""
    return F.min(axis=2)


def canvas_sdf(canvas, pad_bottom=60):
    """signed distance (px, + outside) of the painted silhouette on the canvas lattice, closed at
    the bottom (pad rows)."""
    c = np.concatenate([canvas, np.zeros((pad_bottom, canvas.shape[1]), bool)], 0)
    d_out = ndi.distance_transform_edt(~c)
    d_in = ndi.distance_transform_edt(c)
    sd = np.where(c, -(d_in - 0.5), d_out - 0.5)
    return ndi.gaussian_filter(sd, 0.7).astype(np.float32)


def sample_canvas_sdf(csdf, X, Y):
    """canvas SDF at ref2 coords (X right, Y down)"""
    sh = np.shape(X)
    return ndi.map_coordinates(csdf, [(np.asarray(Y) + PAD_TOP).ravel(), np.asarray(X).ravel()],
                               order=1, mode='nearest').reshape(sh)
