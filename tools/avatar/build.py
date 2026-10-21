#!/usr/bin/env python
"""
The avatar bust: a sculpted signed-distance head, fitted to the painting (tools/reference2.webp).

  1. The painted silhouette ("canvas") exactly as tools/build_avatar.py makes it.
  2. A stylised anatomical head (skull, forehead, brow, eye sockets + eyes + lids, cheekbones,
     nose, lips, chin, jaw, ears) built from smooth SDF primitives in a head frame pitched 18 deg
     like the painting, plus a neck/trapezius/shoulder loft whose side-view rows are the painted
     rows (sculpt.py).
  3. Fit: a smooth 2D warp (x, y; the same for every z) pulls the sculpt's side-view outline onto
     the painted outline (closest-point displacements on the outline, spread by normalised
     Gaussian convolution, fading into the interior); iterated. The target outline is lightly
     smoothed (the back of the neck more: its painted edge is a soft blur against the lava).
  4. Two last fits act only near the midline plane (weight exp(-(z / 70 px)^2)): the side-view
     outline becomes exact (face profile within ~1 px) without trimming a flat strip of skin.
     (SDF_NOCUT=0 instead trims with the extruded silhouette, the older recipe.)
  5. Marching cubes -> Taubin -> quadric decimation -> normals from the field gradient ->
     skin weights (the build_avatar.py lines) -> bust.bin / bust.json / figure.webp.

Run: python tools/avatar/build.py [--preview] [--out DIR]   (default out: src/avatar)
     checks and renders of the result: python tools/avatar/check.py [tag]
Needs pillow numpy scipy scikit-image fast-simplification.
"""
import json
import math
import os
import sys
import time

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from skimage import measure
import fast_simplification

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import canvas as CV                      # noqa: E402
import field as FD                       # noqa: E402
import sculpt as SC                      # noqa: E402
import raster as RS                      # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, 'src', 'avatar')
if '--out' in sys.argv:
    OUT = os.path.abspath(sys.argv[sys.argv.index('--out') + 1])
WORK = os.path.join(HERE, 'work')
RENDERS = os.path.join(ROOT, 'tools', 'debug', 'avatar')

K_PX = CV.S12 * CV.H1                   # world -> ref2 px
TARGET_TRIS = int(os.environ.get('AVATAR_TRIS', '56000'))

BONES = {'chest': (600.0, 1260.0), 'neck': (720.0, 1000.0), 'head': (930.0, 640.0)}
# head bone above this line (ref2 px): the whole skull, face, jaw and the skin under the jaw turn
# rigidly with the head (the old line gave the jaw only ~0.7 head weight, so the chin lagged behind
# the face on a turn); the neck twists in the band below it
HEAD_LINE = ((700.0, 610.0), (1010.0, 930.0), 70.0)
CHEST_LINE = ((470.0, 960.0), (960.0, 1170.0), 60.0)


def world_of(x2, y2, z2):
    X, Y = CV.to_world(x2, y2)
    return np.stack([X, Y, np.asarray(z2) / K_PX], -1)


def side_of(px, py, line):
    (ax, ay), (bx, by), _ = line
    dx, dy = bx - ax, by - ay
    n = math.hypot(dx, dy)
    return ((px - ax) * dy - (py - ay) * dx) / n


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def skin_weights(verts):
    vx2 = (verts[:, 0] * CV.H1 - CV.OX) * CV.S12
    vy2 = (1.0 - verts[:, 1]) * CV.H1 * CV.S12
    s_head = side_of(vx2, vy2, HEAD_LINE)
    s_chest = side_of(vx2, vy2, CHEST_LINE)
    head = smoothstep(-HEAD_LINE[2], HEAD_LINE[2], s_head)
    chest = smoothstep(-CHEST_LINE[2], CHEST_LINE[2], -s_chest)
    chest *= 1 - head
    neck = np.clip(1 - head - chest, 0, 1)
    wts = np.stack([chest, neck, head], 1)
    wts /= np.maximum(wts.sum(1, keepdims=True), 1e-6)
    return wts


def smooth_back(canvas, sigma=14.0):
    """the canvas with its back-of-neck / nape outline smoothed (signed distance blurred there):
    the painted edge is a soft blur against the lava, and its segmentation wiggles would otherwise
    become horizontal bands across the neck. The face, throat and skull outlines are untouched."""
    d_out = ndi.distance_transform_edt(~canvas)
    d_in = ndi.distance_transform_edt(canvas)
    sd = np.where(canvas, -(d_in - 0.5), d_out - 0.5)
    sb = ndi.gaussian_filter(sd, sigma)
    # everywhere else a light blur: the segmentation leaves ~1 px wiggles on the skull and face
    # outline, and the outline fit turns each into a thin ridge across the skin (a line across the
    # forehead); a 3 px blur removes them and moves the profile by well under a pixel
    sl = ndi.gaussian_filter(sd, 3.0)
    rows, cols = np.mgrid[0:canvas.shape[0], 0:canvas.shape[1]].astype(np.float64)
    y2 = rows - CV.PAD_TOP
    wgt = smoothstep(900.0, 820.0, cols) * smoothstep(500.0, 560.0, y2)
    return (sl * (1 - wgt) + sb * wgt) < 0


def taubin(verts, faces, iterations=10, lam=0.5, mu=-0.53):
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
    return v


# ----------------------------------------------------------------------------- the fit

def outline_warp(G, grid, csdf, canvas_shape, h=2.0, max_d=30.0, sig0=5.0, fade0=10.0, fade1=110.0):
    """Displacement field that maps the sculpt's side-view outline (zero level of G, a 2D field
    on the grid's x/y lattice) onto the painted outline.

    At every painted-outline point q the pull-back displacement is G(q) grad G / |grad G|^2 (the
    Newton step onto the sculpt outline). These are spread by a multi-scale normalised Gaussian
    convolution whose width grows with the distance to the outline (sigma = max(sig0, 0.7 d)):
    detailed on the outline, nearly constant along the normal just inside it (so the local form
    moves rigidly, no ridge parallel to the outline), and smooth deeper in (no seam along the
    medial axis of thin parts such as the nose). It fades out between fade0 and fade1 px."""
    x0, y0 = float(grid.x[0]), float(grid.y[0])
    nxw = int((grid.x[-1] - x0) / h) + 1
    nyw = int((grid.y[-1] - y0) / h) + 1
    wx = x0 + np.arange(nxw) * h
    wy = y0 + np.arange(nyw) * h
    WX, WY = np.meshgrid(wx, wy)                          # (ny, nx), image layout
    gi = (WX - grid.x[0]) / grid.step
    gj = (WY - grid.y[0]) / grid.step
    Gs = ndi.map_coordinates(G, [gi, gj], order=3, mode='nearest')
    ggx, ggy = np.gradient(G, grid.step)
    Gx = ndi.map_coordinates(ggx, [gi, gj], order=1, mode='nearest')
    Gy = ndi.map_coordinates(ggy, [gi, gj], order=1, mode='nearest')
    g2 = np.maximum(Gx * Gx + Gy * Gy, 0.05)
    Cs = FD.sample_canvas_sdf(csdf, WX, WY)
    on = np.abs(Cs) < 0.75 * h
    dx = np.where(on, Gs * Gx / g2, 0.0)
    dy = np.where(on, Gs * Gy / g2, 0.0)
    mag = np.hypot(dx, dy)
    sc = np.minimum(1.0, max_d / np.maximum(mag, 1e-9))
    dx *= sc; dy *= sc
    m = on.astype(np.float64)
    sigmas = [sig0 * 2 ** k for k in range(6)]          # 4 .. 128 px
    lev = []
    for sg in sigmas:
        bw = ndi.gaussian_filter(m, sg / h)
        lev.append((ndi.gaussian_filter(dx, sg / h) / np.maximum(bw, 1e-12),
                    ndi.gaussian_filter(dy, sg / h) / np.maximum(bw, 1e-12)))
    dist = np.abs(Cs)
    sig = 0.5 * (sig0 + 0.7 * dist + np.sqrt((0.7 * dist - sig0) ** 2 + 4.0))     # smooth max
    t = np.clip(np.log2(sig / sig0), 0, len(sigmas) - 1 - 1e-6)
    k0 = np.floor(t).astype(int)
    fr = t - k0
    fr = fr * fr * (3 - 2 * fr)                          # C1 across the scale levels
    DX = np.zeros_like(dx); DY = np.zeros_like(dy)
    for k in range(len(sigmas) - 1):
        sel0 = k0 == k
        DX = np.where(sel0, lev[k][0] * (1 - fr) + lev[k + 1][0] * fr, DX)
        DY = np.where(sel0, lev[k][1] * (1 - fr) + lev[k + 1][1] * fr, DY)
    fade = 1.0 - smoothstep(fade0, fade1, dist)
    DX = np.nan_to_num(DX) * fade
    DY = np.nan_to_num(DY) * fade
    return FD.Warp(DX, DY, x0, y0, h), float(np.abs(Gs[on]).mean()), float(np.abs(Gs[on]).max())


def main():
    preview = '--preview' in sys.argv
    t0 = time.time()
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(RENDERS, exist_ok=True)
    canvas_paint, ref = CV.load_canvas()
    canvas = smooth_back(canvas_paint)          # the fit target (see smooth_back)
    body = FD.body_tables(canvas)
    P = dict(SC.DEFAULT)
    step = 8.0 if preview else 3.8
    grid = FD.Grid(canvas, step)
    print(f'grid {grid.shape} = {np.prod(grid.shape) / 1e6:.1f} M, step {step} px')
    csdf = FD.canvas_sdf(canvas)

    warps = []
    n_fit = 0 if preview else int(os.environ.get('SDF_FIT', '4'))
    for it in range(n_fit + 1):
        F, nb = FD.evaluate(grid, body, P, warps)
        G = FD.projection(F)
        print(f'  eval {it}: band {nb / 1e6:.2f} M pts, {time.time() - t0:.0f}s')
        if it == n_fit:
            break
        wp, err_mean, err_max = outline_warp(G, grid, csdf, canvas.shape)
        print(f'  fit {it}: outline error before: mean {err_mean:.2f} px, max {err_max:.2f} px')
        warps.append(wp)
    # residual: a last fit that acts only near the midline plane (the side-view outline is formed
    # at z ~ 0), so the outline becomes exact without the trim flattening a strip of skin
    ZFIT = float(os.environ.get('SDF_ZFIT', '70')) if not preview else 0.0
    if ZFIT > 0:
        for it in range(2):
            wp, err_mean, err_max = outline_warp(G, grid, csdf, canvas.shape, sig0=3.0, fade0=6.0, fade1=60.0)
            print(f'  z-fit {it}: outline error before: mean {err_mean:.2f} px, max {err_max:.2f} px')
            wp.zsig = ZFIT
            warps.append(wp)
            F, nb = FD.evaluate(grid, body, P, warps)
            G = FD.projection(F)
        wp, err_mean, err_max = outline_warp(G, grid, csdf, canvas.shape)
        print(f'  z-fit: outline error after: mean {err_mean:.2f} px, max {err_max:.2f} px')
    np.save(os.path.join(WORK, 'proj_G.npy'), G)

    # --- exact outline: smooth intersection with the extruded painted silhouette
    X2, Y2 = np.meshgrid(grid.x, grid.y, indexing='ij')
    C2 = FD.sample_canvas_sdf(csdf, X2, Y2)
    if not preview:
        DIL = float(os.environ.get('SDF_DIL', '0.0'))
        KI = float(os.environ.get('SDF_KI', '2.5'))
        if os.environ.get('SDF_NOCUT', '1') != '1':
            F = SC.smax(F - DIL, C2[:, :, None], KI)
            print(f'  cookie cut: dilation {DIL} px, smooth {KI} px')
    print(f'field ready {time.time() - t0:.0f}s')

    verts, faces, _, _ = measure.marching_cubes(F, level=0.0, spacing=(step, step, step))
    verts = verts + np.array([grid.x[0], grid.y[0], grid.z[0]], np.float32)
    print(f'marching cubes: {len(verts)} verts, {len(faces)} tris')
    verts = taubin(verts, faces, iterations=8 if not preview else 4)
    target = TARGET_TRIS if not preview else 40000
    ratio = 1.0 - target / len(faces)
    if ratio > 0:
        verts, faces = fast_simplification.simplify(verts.astype(np.float32), faces.astype(np.int32), target_reduction=ratio)
    print(f'decimated: {len(verts)} verts, {len(faces)} tris')
    # normals from the field (y2 points down, so flip the y component for world)
    gx, gy, gz = np.gradient(F, step)
    idx = [(verts[:, 0] - grid.x[0]) / step, (verts[:, 1] - grid.y[0]) / step, (verts[:, 2] - grid.z[0]) / step]
    g = np.stack([ndi.map_coordinates(a, idx, order=1, mode='nearest') for a in (gx, gy, gz)], 1)
    vn = np.stack([g[:, 0], -g[:, 1], g[:, 2]], 1)      # outward = +grad (F < 0 inside)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
    vw = world_of(verts[:, 0], verts[:, 1], verts[:, 2]).astype(np.float32)
    v0, v1, v2 = vw[faces[:, 0]], vw[faces[:, 1]], vw[faces[:, 2]]
    fn = np.cross(v1 - v0, v2 - v0)
    flip = (fn * (vn[faces[:, 0]] + vn[faces[:, 1]] + vn[faces[:, 2]])).sum(1) < 0
    faces = faces.copy()
    faces[flip] = faces[flip][:, [0, 2, 1]]
    print(f'faces re-oriented: {int(flip.sum())} / {len(faces)}')
    np.savez_compressed(os.path.join(WORK, 'mesh_preview.npz' if preview else 'mesh_raw.npz'),
                        verts=vw, faces=faces, normals=vn.astype(np.float32))
    if preview:
        quick_renders(vw, faces, vn.astype(np.float32), ref, canvas, 'preview')
        print(f'done {time.time() - t0:.0f}s')
        return
    write_outputs(vw, faces, vn.astype(np.float32), canvas)
    print(f'done {time.time() - t0:.0f}s')


# ----------------------------------------------------------------------------- outputs

def write_outputs(verts, faces, vn, canvas):
    wts = skin_weights(verts)
    pmin = verts.min(0).astype(np.float64)
    pmax = verts.max(0).astype(np.float64)
    qpos = np.round((verts - pmin) / (pmax - pmin) * 65535).astype(np.uint16)
    qnrm = np.zeros((len(verts), 4), np.int8)
    qnrm[:, :3] = np.round(vn * 127).astype(np.int8)
    qw = np.zeros((len(verts), 4), np.uint8)
    qw[:, :3] = np.round(wts * 255).astype(np.uint8)
    qw[:, 1] = 255 - qw[:, 0].astype(int) - qw[:, 2].astype(int)
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

    px_to_world = 1.0 / K_PX

    def ellipsoid(cx2, cy2, ra2, rb2, rz, angle_deg=CV.PITCH_DEG):
        X, Y = CV.to_world(cx2, cy2)
        return {'center': [float(X), float(Y), 0.0], 'radii': [ra2 * px_to_world, rb2 * px_to_world, rz],
                'rotationZ': -math.radians(angle_deg)}

    bones = {k: [*(float(t) for t in CV.to_world(*v)), 0.0] for k, v in BONES.items()}
    meta = {
        'units': 'backdrop image heights; X right, Y up, Z towards the viewer; rest pose = painting',
        'vertexCount': int(len(verts)),
        'indexCount': int(qidx.size),
        'indexType': 'uint16' if idx_type == np.uint16 else 'uint32',
        'posMin': pmin.tolist(),
        'posMax': pmax.tolist(),
        'layout': {'position': offsets[0], 'normal': offsets[1], 'skinWeight': offsets[2], 'index': offsets[3]},
        'bones': {'order': ['chest', 'neck', 'head'], 'parent': {'chest': None, 'neck': 'chest', 'head': 'neck'}, 'pivot': bones},
        'obstacles': OBSTACLES(ellipsoid),
        # the flames start just under the eyes at the front (the painting) and reach the nape at the back
        'scalp': dict(bone='head', capDir=[-0.275, 0.961, 0.0], capCos=-0.644,
                      **ellipsoid(*CV.SKULL_C, CV.SKULL_R[0], CV.SKULL_R[1], 0.25)),
    }
    with open(os.path.join(OUT, 'bust.json'), 'w') as fh:
        json.dump(meta, fh, indent=2)
    print('bust.bin', off // 1024, 'KB;', meta['vertexCount'], 'verts', meta['indexCount'] // 3, 'tris')

    # figure.webp: the outline as a soft field in backdrop uv (identical recipe to build_avatar.py)
    W1 = int(CV.W1)
    d_out = ndi.distance_transform_edt(~canvas) * px_to_world
    by, bx = np.mgrid[0:int(CV.H1), 0:W1].astype(np.float32)
    cx = (bx - CV.OX) * CV.S12
    cy = by * CV.S12 + CV.PAD_TOP
    dout_b = ndi.map_coordinates(d_out.astype(np.float32), [cy.ravel(), cx.ravel()], order=1, mode='nearest').reshape(by.shape)
    fig_b = np.exp(-dout_b * 9.0)
    Image.fromarray(np.clip(fig_b * 255 + 0.5, 0, 255).astype(np.uint8)).save(os.path.join(OUT, 'figure.webp'), lossless=True)


def OBSTACLES(ellipsoid):
    return [
        dict(bone='head', **ellipsoid(*CV.SKULL_C, CV.SKULL_R[0], CV.SKULL_R[1], 0.25)),
        dict(bone='head', **ellipsoid(1300, 690, 150, 270, 0.17, 25)),
        dict(bone='neck', **ellipsoid(840, 960, 170, 300, 0.12, 30)),
    ]


# ----------------------------------------------------------------------------- previews

def pivots_world():
    return {k: [*(float(t) for t in CV.to_world(*v)), 0.0] for k, v in BONES.items()}


def quick_renders(vw, faces, vn, ref, canvas, tag, yaws=(0.0, 0.35, 0.6, 1.2), scale=520, light=(-0.45, 0.55, 0.70)):
    wts = skin_weights(vw)
    piv = pivots_world()
    imgs = []
    W, H = 600, 720
    center = (0.80, 0.52)
    for yaw in yaws:
        v, n = RS.skin(vw, vn, wts, piv, yaw)
        img = RS.render_view(v, faces, n, center, scale, W, H, light)
        imgs.append((img * 255).astype(np.uint8))
    strip = np.concatenate(imgs, 1)
    Image.fromarray(strip).save(os.path.join(RENDERS, f'{tag}_yaws.png'))
    # head close-ups
    imgs = []
    for yaw in yaws:
        v, n = RS.skin(vw, vn, wts, piv, yaw)
        img = RS.render_view(v, faces, n, (0.95, 0.60), 1000, 620, 700, light)
        imgs.append((img * 255).astype(np.uint8))
    Image.fromarray(np.concatenate(imgs, 1)).save(os.path.join(RENDERS, f'{tag}_heads.png'))
    # face close-ups (light from the front-right too) and the back three-quarter
    imgs = []
    for yaw, li in ((0.6, light), (0.6, (0.3, 0.4, 0.85)), (1.2, (0.3, 0.4, 0.85)), (-0.6, light)):
        v, n = RS.skin(vw, vn, wts, piv, yaw)
        cen = (1.02, 0.50) if yaw > 0 else (0.80, 0.55)
        img = RS.render_view(v, faces, n, cen, 1500 if yaw > 0 else 700, 560, 640, li)
        imgs.append((img * 255).astype(np.uint8))
    Image.fromarray(np.concatenate(imgs, 1)).save(os.path.join(RENDERS, f'{tag}_face.png'))


if __name__ == '__main__':
    main()
