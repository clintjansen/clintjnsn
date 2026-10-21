#!/usr/bin/env python
"""Checks and renders of the FINAL output (decoded from bust.bin / bust.json):
  - rest-pose silhouette vs the painted canvas: IoU inside the image frame, face-profile error
  - skin weight means per region
  - mesh sanity (closed, flipped faces vs field normals, triangle count)
  - renders (z-buffer rasteriser over the decimated triangles, real linear-blend skinning)
Run: python tools/avatar/check.py [tag] [folder]   (default folder: src/avatar)
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from skimage import measure

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import canvas as CV       # noqa: E402
import raster as RS       # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
RENDERS = os.path.join(ROOT, 'tools', 'debug', 'avatar')


def decode(binp, jsonp):
    meta = json.load(open(jsonp))
    buf = open(binp, 'rb').read()
    n = meta['vertexCount']
    L = meta['layout']
    q = np.frombuffer(buf, np.uint16, n * 3, L['position']).reshape(n, 3).astype(np.float64)
    nr = np.frombuffer(buf, np.int8, n * 4, L['normal']).reshape(n, 4)[:, :3].astype(np.float64) / 127
    w = np.frombuffer(buf, np.uint8, n * 4, L['skinWeight']).reshape(n, 4).astype(np.float64)
    it = np.uint16 if meta['indexType'] == 'uint16' else np.uint32
    idx = np.frombuffer(buf, it, meta['indexCount'], L['index']).reshape(-1, 3).astype(np.int64)
    lo = np.array(meta['posMin']); hi = np.array(meta['posMax'])
    v = lo + q / 65535 * (hi - lo)
    nr /= np.maximum(np.linalg.norm(nr, axis=1, keepdims=True), 1e-9)
    return meta, v.astype(np.float32), nr.astype(np.float32), w, idx


def silhouette(v, faces, shape):
    """rest-pose coverage on the canvas lattice (pixel (r, c) <-> x2 = c, y2 = r - PAD_TOP)"""
    x2, y2 = CV.to_px(v[:, 0], v[:, 1])
    sx = x2 + 0.5
    sy = y2 + CV.PAD_TOP + 0.5
    return RS.coverage(sx, sy, faces, shape[1], shape[0])


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else 'final'
    folder = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'src', 'avatar')
    os.makedirs(RENDERS, exist_ok=True)
    binp = os.path.join(folder, 'bust.bin')
    jsonp = os.path.join(folder, 'bust.json')
    meta, v, nrm, w8, faces = decode(binp, jsonp)
    canvas, ref = CV.load_canvas()
    H2 = ref.shape[0]
    print(f'vertices {len(v)}, triangles {len(faces)}, index type {meta["indexType"]}')
    wsum = w8[:, :3].sum(1)
    print('weights sum to 255:', bool((wsum == 255).all()))

    # --- silhouette fidelity
    sil = silhouette(v, faces, canvas.shape)
    fr = slice(CV.PAD_TOP, CV.PAD_TOP + H2)
    A = sil[fr]; B = canvas[fr]
    iou = (A & B).sum() / (A | B).sum()
    iou_all = (sil & canvas).sum() / (sil | canvas).sum()
    print(f'IoU inside the frame: {iou:.5f}   (whole padded canvas: {iou_all:.5f})')
    print(f'  pixels mesh-only {int((A & ~B).sum())}, canvas-only {int((B & ~A).sum())}, canvas {int(B.sum())}')
    # outline distances (sub-pixel contours of both masks)
    def contour_pts(m):
        cs = measure.find_contours(m.astype(np.float32), 0.5)
        return np.concatenate(cs, 0) if cs else np.zeros((0, 2))
    pc = contour_pts(canvas[fr]); pm = contour_pts(sil[fr])
    from scipy.spatial import cKDTree
    tm = cKDTree(pm); tc = cKDTree(pc)
    sel = (pc[:, 1] > 1150) & (pc[:, 0] >= 250) & (pc[:, 0] <= 1000)
    d1, _ = tm.query(pc[sel])
    selm = (pm[:, 1] > 1150) & (pm[:, 0] >= 250) & (pm[:, 0] <= 1000)
    d2, _ = tc.query(pm[selm])
    print(f'face profile (x2>1150, y2 250..1000): canvas->mesh max {d1.max():.2f} px mean {d1.mean():.2f}; '
          f'mesh->canvas max {d2.max():.2f} px mean {d2.mean():.2f}')
    dall, _ = tm.query(pc)
    dall2, ii = tc.query(pm)
    print(f'whole in-frame outline: canvas->mesh max {dall.max():.2f} px (p99 {np.percentile(dall, 99):.2f}); '
          f'mesh->canvas max {dall2.max():.2f} px (p99 {np.percentile(dall2, 99):.2f})')
    bad = np.argsort(-dall)[:6]
    print('  worst canvas outline points (y2, x2, err):', [(int(pc[i, 0]), int(pc[i, 1]), round(float(dall[i]), 1)) for i in bad])
    bad = np.argsort(-dall2)[:6]
    print('  worst mesh outline points (y2, x2, err):', [(int(pm[i, 0]), int(pm[i, 1]), round(float(dall2[i]), 1)) for i in bad])

    # overlay: painting, canvas outline (green), mesh silhouette (blue tint), differences (red)
    img = (ref * 0.55 * 255).astype(np.uint8).copy()
    tint = A & B
    img[tint] = (img[tint] * 0.5 + np.array([60, 90, 200]) * 0.5).astype(np.uint8)
    img[A & ~B] = [255, 40, 40]
    img[B & ~A] = [255, 220, 0]
    eb = B ^ ndi.binary_erosion(B)
    img[eb] = [0, 255, 0]
    im = Image.fromarray(img)
    im.save(os.path.join(RENDERS, f'{tag}_overlay.png'))
    im.crop((1100, 200, 1500, 1050)).resize((800, 1700), Image.NEAREST).save(os.path.join(RENDERS, f'{tag}_overlay_face.png'))

    # --- skin weights
    X, Y = v[:, 0], v[:, 1]
    wn = w8[:, :3] / 255.0
    regions = {
        'skull top (Y>0.9)': Y > 0.9,
        'forehead (Y>0.6, X>1.0)': (Y > 0.6) & (X > 1.0),
        'mid neck (0.12<Y<0.25, 0.5<X<0.7)': (Y > 0.12) & (Y < 0.25) & (X > 0.5) & (X < 0.7),
        'low chest (Y<-0.1)': Y < -0.1,
    }
    for k, m in regions.items():
        mw = wn[m].mean(0)
        print(f'weights {k}: n={int(m.sum())} chest {mw[0]:.3f} neck {mw[1]:.3f} head {mw[2]:.3f}')

    # --- mesh sanity: edge manifoldness, winding vs stored normals
    e = np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), 1)
    _, cnt = np.unique(e, axis=0, return_counts=True)
    print(f'edges used once (boundary): {int((cnt == 1).sum())}, more than twice: {int((cnt > 2).sum())}')
    fn = np.cross(v[faces[:, 1]] - v[faces[:, 0]], v[faces[:, 2]] - v[faces[:, 0]])
    agree = (fn * (nrm[faces[:, 0]] + nrm[faces[:, 1]] + nrm[faces[:, 2]])).sum(1)
    print(f'faces whose winding disagrees with the field normals: {int((agree < 0).sum())}')
    print('bounds', np.round(v.min(0), 3), np.round(v.max(0), 3))

    # --- renders
    piv = meta['bones']['pivot']
    wts = wn
    yaws = (0.0, 0.35, 0.6, 1.2)
    strip, heads, faces_ = [], [], []
    for yaw in yaws:
        vv, nn = RS.skin(v, nrm, wts, piv, yaw)
        strip.append((RS.render_view(vv, faces, nn, (0.80, 0.50), 520, 600, 760) * 255).astype(np.uint8))
        heads.append((RS.render_view(vv, faces, nn, (0.97, 0.60), 900, 600, 640) * 255).astype(np.uint8))
        faces_.append((RS.render_view(vv, faces, nn, (1.03, 0.49), 1700, 600, 640) * 255).astype(np.uint8))
    for name, arr in (('yaws', strip), ('heads', heads), ('faces', faces_)):
        canvas_img = np.concatenate(arr, 1)
        im = Image.fromarray(canvas_img).convert('RGB')
        dr = ImageDraw.Draw(im)
        for i, yaw in enumerate(yaws):
            dr.text((i * arr[0].shape[1] + 8, 8), f'yaw {yaw}', fill=(200, 0, 0))
        im.save(os.path.join(RENDERS, f'{tag}_{name}.png'))
    for yaw in yaws:
        vv, nn = RS.skin(v, nrm, wts, piv, yaw)
        Image.fromarray((RS.render_view(vv, faces, nn, (0.80, 0.50), 700, 900, 1000) * 255).astype(np.uint8)).save(
            os.path.join(RENDERS, f'{tag}_yaw{yaw:.2f}.png'))
    # extra: back three-quarter and a light from the front-right
    extra = []
    for yaw, li in ((-0.6, (-0.45, 0.55, 0.70)), (0.6, (0.35, 0.45, 0.82)), (1.2, (0.35, 0.45, 0.82))):
        vv, nn = RS.skin(v, nrm, wts, piv, yaw)
        extra.append((RS.render_view(vv, faces, nn, (0.97, 0.60) if yaw > 0 else (0.85, 0.55), 900 if yaw > 0 else 650, 600, 640, li) * 255).astype(np.uint8))
    Image.fromarray(np.concatenate(extra, 1)).save(os.path.join(RENDERS, f'{tag}_extra.png'))
    print('renders in', RENDERS)


if __name__ == '__main__':
    main()
