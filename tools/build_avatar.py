#!/usr/bin/env python
"""
Build the avatar's 3D bust from the reference painting (tools/reference2.webp).

How the shape is made
  1. Segment the painting into background (magma, pale) and figure (everything else).
  2. Keep the parts of the figure that are body (face profile, chin, throat, neck, shoulders)
     and add the skull, which the painting hides under the fire: an ellipse fitted to the
     visible face (the head is pitched ~18 degrees down; the nape lines up with the painted
     back of the neck).
  3. "Inflate" that silhouette into 3D: the half-thickness of the body at an image point grows
     with the distance to the silhouette edge (a rounded profile), capped per region (skull,
     face, jaw, neck, shoulders). Seen from the camera in its rest pose, the bust therefore has
     exactly the painted outline; turned, it is a smooth, believable volume.
  4. Marching cubes -> quadric decimation -> smooth normals -> skin weights for three bones.

Outputs
  src/avatar/bust.bin    compact binary mesh (layout in bust.json)
  src/avatar/bust.json   bones, bounds, quantisation, fire obstacles/scalp (world rest pose)
  src/avatar/figure.webp the bust's outline as a soft field in backdrop uv (lava line wrapping)
  tools/debug/avatar_*.png previews

World space: units = backdrop (reference.webp) image heights, X right, Y up (0 = image bottom),
Z towards the viewer. A reference2 pixel (x2, y2) sits at X = (x2/1.388 - 39)/839,
Y = 1 - (y2/1.388)/839 (measured by registering the two paintings' magma).

Run:  python tools/build_avatar.py   (needs pillow numpy scipy scikit-image fast-simplification)
"""
import json
import math
import os

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from skimage import measure
import fast_simplification

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF2 = os.path.join(ROOT, 'tools', 'reference2.webp')
OUT = os.path.join(ROOT, 'src', 'avatar')
DBG = os.path.join(ROOT, 'tools', 'debug')

S12, OX, H1, W1 = 1.388, -39.0, 839.0, 1383.0     # reference2 -> backdrop (reference) pixels
PAD_TOP, PAD_BOTTOM = 320, 340                      # the skull and the chest continue off-frame

# Skull ellipse in reference2 pixels (y down): centre, radii along / across the head's
# forward axis, and the pitch of that axis (the head looks ~18 degrees down).
SKULL_C = (1054.0, 339.0)
SKULL_R = (395.0, 375.0)
PITCH_DEG = 18.0

# Region caps: (x2, y2, half-thickness cap, rounding radius) in reference2 px / world units.
CONTROL = [
    (1054, 339, 0.250, 0.320),   # skull centre
    (1340, 360, 0.225, 0.280),   # forehead
    (1290, 560, 0.215, 0.280),   # brow / cheek
    (1415, 650, 0.200, 0.250),   # nose
    (1330, 790, 0.175, 0.230),   # mouth
    (1235, 905, 0.145, 0.190),   # chin
    (1030, 800, 0.190, 0.220),   # jaw angle
    (980, 560, 0.240, 0.300),    # side of the head, ear height
    (700, 640, 0.175, 0.200),    # nape
    (800, 980, 0.130, 0.150),    # neck
    (820, 1250, 0.150, 0.140),   # neck base, front
    (420, 1200, 0.300, 0.200),   # shoulder
    (250, 1400, 0.330, 0.220),   # chest, off-frame
]
RBF_SIGMA = 170.0

STEP = 0.0045        # marching-cubes voxel (world units)
TARGET_TRIS = int(os.environ.get("AVATAR_TRIS", "46000"))

# Bones (world rest pose). The head pivot sits behind the jaw under the ear, the neck pivot at
# the base of the neck, the chest below the frame.
def to_world(x2, y2):
    return ((x2 / S12 + OX) / H1, 1.0 - (y2 / S12) / H1)


BONES = {
    'chest': (600.0, 1260.0),
    'neck': (720.0, 1000.0),
    'head': (930.0, 640.0),
}
# Skin split lines in reference2 px: points left/below the first line are neck, below the
# second are chest. Blend widths in px.
HEAD_LINE = ((680.0, 600.0), (1060.0, 860.0), 110.0)   # wide blend: the turn twists the whole neck
CHEST_LINE = ((470.0, 960.0), (960.0, 1170.0), 60.0)


# ----------------------------------------------------------------------------- helpers

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
    fx, fy = math.cos(a), math.sin(a)            # forward axis (y down)
    dx = xx - SKULL_C[0]
    dy = yy - SKULL_C[1]
    u = dx * fx + dy * fy
    v = -dx * fy + dy * fx
    return (u / SKULL_R[0]) ** 2 + (v / SKULL_R[1]) ** 2 <= 1.0


def side_of(px, py, line):
    (ax, ay), (bx, by), _ = line
    dx, dy = bx - ax, by - ay
    n = math.hypot(dx, dy)
    return ((px - ax) * dy - (py - ay) * dx) / n      # > 0 above/left of a->b (pixel coords, y down)


def poisson_inflate(mask, px_to_world, K=2.8, factor=3):
    """sqrt of the solution of -lap(u) = K in the mask (u = 0 outside), in world units."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.linalg import spsolve
    H, W = mask.shape
    hd, wd = (H + factor - 1) // factor, (W + factor - 1) // factor
    pad = np.zeros((hd * factor, wd * factor), np.float32)
    pad[:H, :W] = mask
    m = pad.reshape(hd, factor, wd, factor).mean((1, 3)) > 0.5
    idx = -np.ones(m.shape, np.int64)
    ys, xs = np.nonzero(m)
    idx[ys, xs] = np.arange(len(ys))
    hs = factor * px_to_world
    rows, cols, vals = [np.arange(len(ys))], [np.arange(len(ys))], [np.full(len(ys), 4.0)]
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        yy, xx = ys + dy, xs + dx
        ok = (yy >= 0) & (yy < hd) & (xx >= 0) & (xx < wd)
        nb = np.full(len(ys), -1, np.int64)
        nb[ok] = idx[yy[ok], xx[ok]]
        inside = nb >= 0
        rows.append(np.nonzero(inside)[0]); cols.append(nb[inside]); vals.append(np.full(inside.sum(), -1.0))
    A = coo_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(len(ys), len(ys))).tocsr()
    u = spsolve(A, np.full(len(ys), K * hs * hs))
    ud = np.zeros(m.shape, np.float64)
    ud[ys, xs] = np.maximum(u, 0)
    uf = ndi.zoom(ud, factor, order=3)[:H, :W]
    uf = np.where(mask, np.maximum(uf, 0), 0)
    return np.sqrt(uf).astype(np.float32)


def taubin(verts, faces, iterations=10, lam=0.5, mu=-0.53):
    """Taubin smoothing: removes marching-cubes terracing without shrinking the shape."""
    n = len(verts)
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    e = np.concatenate([e, e[:, ::-1]])
    deg = np.bincount(e[:, 0], minlength=n).astype(np.float64)
    v = verts.astype(np.float64)
    for _ in range(iterations):
        for f in (lam, mu):
            acc = np.zeros_like(v)
            np.add.at(acc, e[:, 0], v[e[:, 1]])
            v = v + f * (acc / np.maximum(deg, 1)[:, None] - v)
    return v.astype(np.float32)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ----------------------------------------------------------------------------- build

def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(DBG, exist_ok=True)
    a = np.asarray(Image.open(REF2).convert('RGB'), dtype=np.float32) / 255.0
    H2, W2, _ = a.shape
    fig = segment_figure(a)

    # --- silhouette on a padded canvas (y from -PAD_TOP to H2 + PAD_BOTTOM) ---------------
    HC = H2 + PAD_TOP + PAD_BOTTOM
    y0 = -PAD_TOP
    canvas = np.zeros((HC, W2), bool)
    yy = np.arange(HC)[:, None] + y0
    xx = np.arange(W2)[None, :]
    rows = np.arange(H2)[:, None]
    cols = np.arange(W2)[None, :]
    body = fig & ((rows > 640) | ((cols > 1150) & (rows > 240)))
    canvas[PAD_TOP:PAD_TOP + H2] = body
    # chest and shoulders continue below the frame: repeat the last good row
    # (the morphology in segment_figure erodes the last few rows: copy one safely inside)
    canvas[PAD_TOP + H2 - 8:] = canvas[PAD_TOP + H2 - 9]
    # close the thin magma tongue between neck and shoulder at the bottom of the frame
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
    # blend the back of the skull into the painted nape: close concavities only in that corner
    yy_, xx_ = np.mgrid[0:HC, 0:W2]
    corner = (xx_ < 1000) & (yy_ + y0 < 780) & (yy_ + y0 > 300)
    disk = (np.hypot(*np.mgrid[-70:71, -70:71]) <= 70)
    closed = ndi.binary_closing(canvas, structure=disk)
    canvas = np.where(corner, closed, canvas)
    canvas = ndi.gaussian_filter(canvas.astype(np.float32), 3.0) > 0.5

    # --- inflation fields -----------------------------------------------------------------
    px_to_world = 1.0 / (S12 * H1)
    d_in = ndi.distance_transform_edt(canvas) * px_to_world
    d_out = ndi.distance_transform_edt(~canvas) * px_to_world
    # region caps by RBF (evaluated at quarter resolution, then upsampled)
    q = 4
    gy, gx = np.mgrid[0:HC:q, 0:W2:q].astype(np.float32)
    gy += y0
    wsum = np.zeros_like(gx)
    cap = np.zeros_like(gx)
    rad = np.zeros_like(gx)
    for cx, cy, c, rr in CONTROL:
        w = np.exp(-((gx - cx) ** 2 + (gy - cy) ** 2) / (2 * RBF_SIGMA ** 2)) + 1e-12
        wsum += w
        cap += w * c
        rad += w * rr
    cap /= wsum
    rad /= wsum
    cap = ndi.zoom(cap, (HC / cap.shape[0], W2 / cap.shape[1]), order=1)[:HC, :W2]
    rad = ndi.zoom(rad, (HC / rad.shape[0], W2 / rad.shape[1]), order=1)[:HC, :W2]
    # Smooth "pressure" inflation: solve -lap(u) = K inside the silhouette, u = 0 on it, and take
    # sqrt(u). A disc becomes an exact hemisphere, a band a round tube, and unlike a distance
    # transform there are no creases along the shape's medial axis. The region caps then soften
    # the thickness where the painting wants flatter forms (face, neck).
    half_raw = poisson_inflate(canvas, px_to_world, K=2.8, factor=3)
    p_ = 4.0
    half = half_raw * cap / np.power(half_raw ** p_ + cap ** p_, 1.0 / p_)
    field2d = np.where(canvas, half, -d_out).astype(np.float32)   # > 0 inside, signed

    # --- sample on a world-space voxel grid -------------------------------------------------
    ys_c, xs_c = np.nonzero(canvas)
    Xmin, Ymax = to_world(xs_c.min(), ys_c.min() + y0)
    Xmax, Ymin = to_world(xs_c.max(), ys_c.max() + y0)
    Xmin -= 0.03; Xmax += 0.03; Ymin -= 0.03; Ymax += 0.03
    Zmax = float(half.max()) + 0.03
    nx = int(math.ceil((Xmax - Xmin) / STEP)) + 1
    ny = int(math.ceil((Ymax - Ymin) / STEP)) + 1
    nz = int(math.ceil(2 * Zmax / STEP)) + 1
    Xs = Xmin + np.arange(nx) * STEP
    Ys = Ymin + np.arange(ny) * STEP
    Zs = -Zmax + np.arange(nz) * STEP
    # world -> canvas pixel
    PX = (Xs * H1 - OX) * S12
    PY = (1.0 - Ys) * H1 * S12 - y0
    GX, GY = np.meshgrid(PX, PY, indexing='ij')
    f2 = ndi.map_coordinates(field2d, [GY.ravel(), GX.ravel()], order=1, mode='nearest').reshape(nx, ny)
    vol = f2[:, :, None] - np.abs(Zs)[None, None, :]
    print(f'volume {nx}x{ny}x{nz} = {vol.size / 1e6:.1f} M voxels')

    verts, faces, _, _ = measure.marching_cubes(vol, level=0.0, spacing=(STEP, STEP, STEP))
    print(f'marching cubes: {len(verts)} verts, {len(faces)} tris')
    verts = taubin(verts, faces, iterations=12)
    ratio = 1.0 - TARGET_TRIS / len(faces)
    if ratio > 0:
        verts, faces = fast_simplification.simplify(verts.astype(np.float32), faces.astype(np.int32), target_reduction=ratio)
    print(f'decimated: {len(verts)} verts, {len(faces)} tris')

    # Normals straight from the volume (outward = -grad), so they are exact whatever the
    # triangulation; then make every face's winding agree with them.
    gx, gy, gz = np.gradient(vol, STEP)
    idx = [(verts[:, k] / STEP) for k in range(3)]
    vn = -np.stack([ndi.map_coordinates(g, idx, order=1, mode='nearest') for g in (gx, gy, gz)], 1)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
    v0, v1, v2 = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    fn = np.cross(v1 - v0, v2 - v0)
    flip = (fn * (vn[faces[:, 0]] + vn[faces[:, 1]] + vn[faces[:, 2]])).sum(1) < 0
    faces[flip] = faces[flip][:, [0, 2, 1]]
    print(f'faces re-oriented: {int(flip.sum())}')
    verts = verts + np.array([Xmin, Ymin, -Zmax], dtype=np.float32)

    # --- skin weights (chest, neck, head) ----------------------------------------------------
    vx2 = (verts[:, 0] * H1 - OX) * S12
    vy2 = (1.0 - verts[:, 1]) * H1 * S12
    s_head = side_of(vx2, vy2, HEAD_LINE)
    s_chest = side_of(vx2, vy2, CHEST_LINE)
    head = smoothstep(-HEAD_LINE[2], HEAD_LINE[2], s_head)        # above the nape->throat line
    chest = smoothstep(-CHEST_LINE[2], CHEST_LINE[2], -s_chest)   # below the neck-base line
    chest *= 1 - head
    neck = np.clip(1 - head - chest, 0, 1)
    wts = np.stack([chest, neck, head], 1)
    wts /= np.maximum(wts.sum(1, keepdims=True), 1e-6)

    # --- write the compact binary -----------------------------------------------------------
    pmin = verts.min(0)
    pmax = verts.max(0)
    qpos = np.round((verts - pmin) / (pmax - pmin) * 65535).astype(np.uint16)
    qnrm = np.zeros((len(verts), 4), np.int8)
    qnrm[:, :3] = np.round(vn * 127).astype(np.int8)
    qw = np.zeros((len(verts), 4), np.uint8)
    qw[:, :3] = np.round(wts * 255).astype(np.uint8)
    qw[:, 1] = 255 - qw[:, 0].astype(int) - qw[:, 2].astype(int)     # exact sum 255
    idx_type = np.uint16 if len(verts) < 65536 else np.uint32
    qidx = faces.astype(idx_type).ravel()
    blobs = [qpos.tobytes(), qnrm.tobytes(), qw.tobytes(), qidx.tobytes()]
    offsets = []
    off = 0
    for bl in blobs:
        offsets.append(off)
        off += len(bl)
        off = (off + 3) // 4 * 4
    with open(os.path.join(OUT, 'bust.bin'), 'wb') as fh:
        for bl, o in zip(blobs, offsets):
            fh.seek(o)
            fh.write(bl)
        fh.truncate(off)

    def ellipsoid(cx2, cy2, ra2, rb2, rz, angle_deg=PITCH_DEG):
        X, Y = to_world(cx2, cy2)
        return {'center': [X, Y, 0.0], 'radii': [ra2 * px_to_world, rb2 * px_to_world, rz],
                'rotationZ': -math.radians(angle_deg)}       # y-up: pitched down = negative

    bones = {k: [*to_world(*v), 0.0] for k, v in BONES.items()}
    meta = {
        'units': 'backdrop image heights; X right, Y up, Z towards the viewer; rest pose = painting',
        'vertexCount': int(len(verts)),
        'indexCount': int(qidx.size),
        'indexType': 'uint16' if idx_type == np.uint16 else 'uint32',
        'posMin': pmin.tolist(),
        'posMax': pmax.tolist(),
        'layout': {'position': offsets[0], 'normal': offsets[1], 'skinWeight': offsets[2], 'index': offsets[3]},
        'bones': {'order': ['chest', 'neck', 'head'], 'parent': {'chest': None, 'neck': 'chest', 'head': 'neck'}, 'pivot': bones},
        # Volumes that block the fire (attached to bones), and the scalp the fire grows from.
        'obstacles': [
            dict(bone='head', **ellipsoid(*SKULL_C, SKULL_R[0], SKULL_R[1], 0.25)),
            dict(bone='head', **ellipsoid(1300, 690, 150, 270, 0.17, 25)),
            dict(bone='neck', **ellipsoid(840, 960, 170, 300, 0.12, 30)),
        ],
        'scalp': dict(bone='head', capDir=[-0.80, 0.60, 0.0], capCos=-0.50,   # brow line to the nape, and the near side shell=0.10,
                      **ellipsoid(*SKULL_C, SKULL_R[0], SKULL_R[1], 0.25)),
    }
    with open(os.path.join(OUT, 'bust.json'), 'w') as fh:
        json.dump(meta, fh, indent=2)
    print('bust.bin', off // 1024, 'KB;', meta['vertexCount'], 'verts', meta['indexCount'] // 3, 'tris')

    # --- outline field in backdrop uv (for the lava's line wrapping) -----------------------
    # backdrop pixel (x1, y1) <- reference2 pixel ((x1 + 39) * 1.388, y1 * 1.388)
    by, bx = np.mgrid[0:int(H1), 0:int(W1)].astype(np.float32)
    cx = (bx - OX) * S12
    cy = by * S12 - y0
    dout_b = ndi.map_coordinates(d_out.astype(np.float32), [cy.ravel(), cx.ravel()], order=1, mode='nearest').reshape(by.shape)
    fig_b = np.exp(-dout_b * 9.0)
    Image.fromarray(np.clip(fig_b * 255 + 0.5, 0, 255).astype(np.uint8)).save(os.path.join(OUT, 'figure.webp'), lossless=True)

    # --- previews ----------------------------------------------------------------------------
    preview(vol, Xmin, Ymin, -Zmax, a)
    sil_vis = np.stack([canvas * 0.9] * 3, -1)
    sil_vis[PAD_TOP:PAD_TOP + H2] = np.maximum(sil_vis[PAD_TOP:PAD_TOP + H2], a * 0.45)
    Image.fromarray((sil_vis * 255).astype(np.uint8)).resize((W2 // 2, HC // 2)).save(os.path.join(DBG, 'avatar_silhouette.png'))
    print('previews in', DBG)


def preview(vol, X0, Y0, Z0, ref):
    """Orthographic ray-cast of the voxel volume at a few yaw angles, lambert + rim shading."""
    nx, ny, nz = vol.shape
    res = 360
    imgs = []
    for yaw in (0.0, 35.0, -30.0):
        a = math.radians(yaw)
        ca, sa = math.cos(a), math.sin(a)
        # screen grid in world: X' in [X0, X0 + nx*STEP], Y in [Y0, Y0 + ny*STEP]
        W = nx * STEP
        Hh = ny * STEP
        sx = np.linspace(X0, X0 + W, res)
        sy = np.linspace(Y0 + Hh, Y0, int(res * Hh / W))
        sz = np.linspace(-Z0, Z0, nz)            # from front (+Z) to back
        cxw = X0 + W / 2
        SX, SY, SZ = np.meshgrid(sx, sy, sz, indexing='ij')
        # rotate the sample points back into the model's rest frame (yaw about Y through the centre)
        RX = cxw + (SX - cxw) * ca - SZ * sa
        RZ = (SX - cxw) * sa + SZ * ca
        ix = (RX - X0) / STEP
        iy = (SY - Y0) / STEP
        iz = (RZ - Z0) / STEP
        val = ndi.map_coordinates(vol, [ix.ravel(), iy.ravel(), iz.ravel()], order=1, cval=-1).reshape(SX.shape)
        inside = val > 0
        hit = inside.any(-1)
        first = np.argmax(inside, -1)
        depth = np.where(hit, sz[first], -1.0)
        gy_, gx_ = np.gradient(depth)
        n = np.stack([-gx_ * 40, gy_ * 40, np.ones_like(depth)], -1)
        n /= np.linalg.norm(n, axis=-1, keepdims=True)
        L = np.array([-0.4, 0.6, 0.7]); L /= np.linalg.norm(L)
        lam = np.clip((n * L).sum(-1), 0, 1)
        rim = (1 - np.clip(n[..., 2], 0, 1)) ** 2
        img = np.stack([0.08 + 0.35 * lam + 0.5 * rim, 0.10 + 0.40 * lam + 0.3 * rim, 0.30 + 0.60 * lam + 0.2 * rim], -1)
        img = np.where(hit[..., None], img, 0.85)
        imgs.append((np.clip(img.transpose(1, 0, 2), 0, 1) * 255).astype(np.uint8))
    strip = np.concatenate(imgs, 1)
    Image.fromarray(strip).save(os.path.join(DBG, 'avatar_preview.png'))


if __name__ == '__main__':
    main()
