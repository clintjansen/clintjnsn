#!/usr/bin/env python
"""Diagnostic views of a bust (bust.bin/bust.json in a folder, or a raw mesh .npz from build.py): a
sheet of views with light from several sides. Run: python tools/avatar/view.py <folder> <out.png> [spec ...]
spec = yaw:cx:cy:scale[:lx:ly:lz]  (world units; scale px/unit)"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import raster as RS            # noqa: E402
from check import decode       # noqa: E402


def main():
    folder, out = sys.argv[1], sys.argv[2]
    specs = sys.argv[3:]
    if folder.endswith('.npz'):
        # a raw/preview mesh from build.py (world verts, faces, normals): orbit views or skinned
        # with the builder's weight lines
        import build as BD
        z = np.load(folder)
        v, faces, nrm = z['verts'].astype(np.float32), z['faces'].astype(np.int64), z['normals'].astype(np.float32)
        piv = BD.pivots_world()
        wts = BD.skin_weights(v)
    else:
        meta, v, nrm, w8, faces = decode(os.path.join(folder, 'bust.bin'), os.path.join(folder, 'bust.json'))
        piv = meta['bones']['pivot']
        wts = w8[:, :3] / 255.0
    if os.environ.get('GEO_NORMALS') == '1':
        # vertex normals from the triangles (area weighted) instead of the stored field normals
        fn = np.cross(v[faces[:, 1]] - v[faces[:, 0]], v[faces[:, 2]] - v[faces[:, 0]])
        acc = np.zeros_like(v, dtype=np.float64)
        for k in range(3):
            np.add.at(acc, faces[:, k], fn)
        acc /= np.maximum(np.linalg.norm(acc, axis=1, keepdims=True), 1e-12)
        nrm = acc.astype(np.float32)
    tiles = []
    for sp in specs:
        orbit = sp.startswith('o')
        p = [float(t) for t in sp.lstrip('o').split(':')]
        yaw, cx, cy, sc = p[:4]
        light = tuple(p[4:7]) if len(p) >= 7 else (-0.45, 0.55, 0.70)
        if orbit:
            # rigid turn of the whole bust about the vertical axis through the head pivot (shape check)
            R = RS.rot_y(-yaw)
            c = np.asarray(piv['head'], np.float64)
            vv = ((v - c) @ R.T + c).astype(np.float32)
            nn = (nrm @ R.T).astype(np.float32)
        else:
            vv, nn = RS.skin(v, nrm, wts, piv, yaw)
        img = (RS.render_view(vv, faces, nn, (cx, cy), sc, 520, 600, light) * 255).astype(np.uint8)
        im = Image.fromarray(img).convert('RGB')
        ImageDraw.Draw(im).text((6, 6), sp, fill=(200, 0, 0))
        tiles.append(np.asarray(im))
    cols = min(4, len(tiles))
    rows = (len(tiles) + cols - 1) // cols
    H, W = tiles[0].shape[:2]
    sheet = np.full((rows * H, cols * W, 3), 255, np.uint8)
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        sheet[r * H:(r + 1) * H, c * W:(c + 1) * W] = t
    Image.fromarray(sheet).save(out)
    print('wrote', out)


if __name__ == '__main__':
    main()
