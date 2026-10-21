"""A small numpy z-buffer rasteriser for triangle meshes (orthographic), with Lambert + rim
shading, and linear-blend skinning for the avatar's three bones."""
import math

import numpy as np


def rasterize(sx, sy, sz, faces, W, H, attrs=None):
    """sx, sy: screen pixel coords (x right, y down); sz: depth (bigger = nearer).
    Returns (tri index per pixel or -1, barycentrics (H, W, 3), depth)."""
    v0, v1, v2 = faces[:, 0], faces[:, 1], faces[:, 2]
    x0, x1, x2 = sx[v0], sx[v1], sx[v2]
    y0, y1, y2 = sy[v0], sy[v1], sy[v2]
    xmin = np.floor(np.minimum(np.minimum(x0, x1), x2)).astype(np.int64)
    xmax = np.ceil(np.maximum(np.maximum(x0, x1), x2)).astype(np.int64)
    ymin = np.floor(np.minimum(np.minimum(y0, y1), y2)).astype(np.int64)
    ymax = np.ceil(np.maximum(np.maximum(y0, y1), y2)).astype(np.int64)
    ok = (xmax >= 0) & (ymax >= 0) & (xmin < W) & (ymin < H)
    den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    ok &= np.abs(den) > 1e-12
    span = np.maximum(xmax - xmin, ymax - ymin) + 1
    all_pix, all_z, all_t, all_b = [], [], [], []
    lo = 0
    for K in (2, 4, 8, 16, 32, 64, 128, 256, 4096):
        sel = np.nonzero(ok & (span > lo) & (span <= K))[0]
        lo = K
        if not len(sel):
            continue
        oy, ox = np.mgrid[0:K, 0:K]
        ox = ox.ravel(); oy = oy.ravel()
        for c0 in range(0, len(sel), max(1, 4_000_000 // (K * K))):
            t = sel[c0:c0 + max(1, 4_000_000 // (K * K))]
            px = xmin[t][:, None] + ox[None, :]
            py = ymin[t][:, None] + oy[None, :]
            cx = px + 0.5
            cy = py + 0.5
            d = den[t][:, None]
            b0 = ((y1[t][:, None] - y2[t][:, None]) * (cx - x2[t][:, None]) + (x2[t][:, None] - x1[t][:, None]) * (cy - y2[t][:, None])) / d
            b1 = ((y2[t][:, None] - y0[t][:, None]) * (cx - x2[t][:, None]) + (x0[t][:, None] - x2[t][:, None]) * (cy - y2[t][:, None])) / d
            b2 = 1 - b0 - b1
            e = -1e-6
            m = (b0 >= e) & (b1 >= e) & (b2 >= e) & (px >= 0) & (py >= 0) & (px < W) & (py < H)
            m &= (px <= xmax[t][:, None]) & (py <= ymax[t][:, None])
            if not m.any():
                continue
            ti = np.broadcast_to(t[:, None], m.shape)[m]
            bb0, bb1, bb2 = b0[m], b1[m], b2[m]
            z = bb0 * sz[v0[ti]] + bb1 * sz[v1[ti]] + bb2 * sz[v2[ti]]
            all_pix.append(py[m] * W + px[m])
            all_z.append(z)
            all_t.append(ti)
            all_b.append(np.stack([bb0, bb1, bb2], 1))
    tri = -np.ones(H * W, np.int64)
    bary = np.zeros((H * W, 3), np.float32)
    depth = np.full(H * W, -np.inf, np.float32)
    if all_pix:
        pix = np.concatenate(all_pix)
        z = np.concatenate(all_z)
        tt = np.concatenate(all_t)
        bb = np.concatenate(all_b)
        order = np.lexsort((-z, pix))
        pix, z, tt, bb = pix[order], z[order], tt[order], bb[order]
        first = np.ones(len(pix), bool)
        first[1:] = pix[1:] != pix[:-1]
        tri[pix[first]] = tt[first]
        bary[pix[first]] = bb[first]
        depth[pix[first]] = z[first]
    return tri.reshape(H, W), bary.reshape(H, W, 3), depth.reshape(H, W)


def coverage(sx, sy, faces, W, H):
    """binary coverage mask (pixel centres inside any triangle)"""
    tri, _, _ = rasterize(sx, sy, np.zeros_like(sx), faces, W, H)
    return tri >= 0


def shade(tri, bary, faces, normals, light=(-0.45, 0.55, 0.70), bg=1.0):
    """grey Lambert + a little rim on white. normals in view space (x right, y up, z to viewer)."""
    H, W = tri.shape
    m = tri >= 0
    n = np.zeros((H, W, 3), np.float32)
    f = faces[tri[m]]
    b = bary[m]
    nn = normals[f[:, 0]] * b[:, 0:1] + normals[f[:, 1]] * b[:, 1:2] + normals[f[:, 2]] * b[:, 2:3]
    nn /= np.maximum(np.linalg.norm(nn, axis=1, keepdims=True), 1e-9)
    n[m] = nn
    L = np.asarray(light, np.float32)
    L /= np.linalg.norm(L)
    lam = np.clip((n * L).sum(-1), 0, 1)
    L2 = np.array([0.6, 0.2, 0.5], np.float32); L2 /= np.linalg.norm(L2)
    fill = np.clip((n * L2).sum(-1), 0, 1)
    rim = (1 - np.clip(n[..., 2], 0, 1)) ** 3
    g = 0.10 + 0.70 * lam + 0.12 * fill + 0.18 * rim
    img = np.where(m, np.clip(g, 0, 1), bg)
    return img


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def skin(verts, normals, weights, pivots, yaw):
    """linear blend skinning as three.js does for this rig (yaw only):
    neck.rotation.y = -0.38 yaw about the neck pivot, head.rotation.y = -0.62 yaw (child of neck)."""
    Pn = np.asarray(pivots['neck'], np.float64)
    Ph = np.asarray(pivots['head'], np.float64)
    Rn = rot_y(-yaw * 0.38)
    Rh = rot_y(-yaw * 0.62)
    # world transforms relative to rest: M = T * R * T^-1
    M_chest = (np.eye(3), np.zeros(3))
    M_neck = (Rn, Pn - Rn @ Pn)
    Rnh = Rn @ Rh
    # head: Tn Rn T(Ph-Pn) Rh T(-Ph) -> x' = Rn (Rh (x - Ph) + Ph - Pn) + Pn
    M_head = (Rnh, Rn @ (Ph - Pn) + Pn - Rnh @ Ph)
    Ms = [M_chest, M_neck, M_head]
    v = np.zeros_like(verts, dtype=np.float64)
    nrm = np.zeros_like(normals, dtype=np.float64)
    for i, (R, t) in enumerate(Ms):
        w = weights[:, i:i + 1].astype(np.float64)
        v += w * (verts @ R.T + t)
        nrm += w * (normals @ R.T)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)
    return v.astype(np.float32), nrm.astype(np.float32)


def render_view(verts, faces, normals, center, scale, W, H, light=(-0.45, 0.55, 0.70)):
    """orthographic view down -Z: world (X, Y) -> pixels around `center` at `scale` px/unit"""
    sx = (verts[:, 0] - center[0]) * scale + W / 2
    sy = (center[1] - verts[:, 1]) * scale + H / 2
    sz = verts[:, 2]
    tri, bary, depth = rasterize(sx, sy, sz, faces, W, H)
    return shade(tri, bary, faces, normals, light)
