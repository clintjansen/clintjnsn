"""The sculpt: a stylised anatomical head (in a head frame pitched like the painting) plus a
neck/trapezius/shoulder loft whose side-view extents follow the painted rows.

Units: reference2 pixels (40 px ~ 1 cm on this head). Evaluation coordinates are "ref2 space":
x2 right, y2 DOWN, z2 = Z * 1164.5 (towards the viewer).

Head frame: origin at the painted skull centre (1054, 339), f = forward (the face direction,
pitched 18 deg down), u = up, s = side (= Z).
"""
import math

import numpy as np

from sdf import (clamp, ellipsoid, rot, round_cone, smax, smin, smoothstep, sphere, ssub)

PITCH = math.radians(18.0)
CF, SF = math.cos(PITCH), math.sin(PITCH)
HC = (1054.0, 339.0)


def to_head(x2, y2):
    dx = x2 - np.float32(HC[0])
    dy = y2 - np.float32(HC[1])
    f = dx * np.float32(CF) + dy * np.float32(SF)
    u = dx * np.float32(SF) - dy * np.float32(CF)
    return f, u


def head_to_ref2(f, u):
    """inverse of to_head (for placing markers)"""
    dx = f * CF + u * SF
    dy = f * SF - u * CF
    return HC[0] + dx, HC[1] + dy


def sub3(p, c):
    return (p[0] - np.float32(c[0]), p[1] - np.float32(c[1]), p[2] - np.float32(c[2]))


def soft_abs(s, e=18.0):
    """|s| with a rounded bottom: bilateral parts mirrored with it meet the midline without a crease"""
    return np.sqrt(s * s + np.float32(e * e)) - np.float32(e)


def gauss(p, c, r):
    """a smooth bump in [0, 1] (Gaussian of the scaled distance); subtracted from a field it moves the
    surface out by about its amplitude, with no seam (unlike a union of primitives)"""
    x = (p[0] - np.float32(c[0])) / np.float32(r[0])
    y = (p[1] - np.float32(c[1])) / np.float32(r[1])
    z = (p[2] - np.float32(c[2])) / np.float32(r[2])
    return np.exp(-(x * x + y * y + z * z))


def cranium(f, u, s, P):
    """the braincase as ONE smooth superquadric: the painted skull ellipse in profile (s = 0), an
    s half-width that varies smoothly (broadest over the parietal eminences, narrower at the temples
    and the base, rounding in at the crown) and a flatter, broader front (transverse exponent
    2 -> 2.5 towards the forehead). One surface: no creases where separate shapes would meet."""
    W = (P['crane_w'] - 58.0 * smoothstep(-40.0, 330.0, f) - 24.0 * smoothstep(-120.0, -380.0, f))
    W = W * (1.0 - 0.13 * smoothstep(-110.0, -380.0, u)) * (1.0 - 0.05 * smoothstep(120.0, 340.0, u))
    n = 2.0 + 0.5 * smoothstep(80.0, 340.0, f)
    a = np.abs(f / np.float32(P['skull_rf'])) ** n + np.abs(s / W) ** n
    rfs = a ** (1.0 / n)
    r = np.sqrt(rfs * rfs + (u / np.float32(P['skull_ru'])) ** 2)
    return (r - 1.0) * np.float32(340.0)


def bend(p, R):
    """bend the s axis around a vertical cylinder: points at side s move forward by s^2/2R, so a
    primitive built straight in s follows a curved (arch-shaped) face front"""
    f, u, s = p
    return (f + s * s / np.float32(2 * R), u, s)


# ----------------------------------------------------------------------------------- head

def head(f, u, s, P):
    p = (f, u, s)
    sa = soft_abs(s)
    pm = (f, u, sa)                       # mirrored (bilateral features), soft at the midline

    # --- neurocranium: one smooth superquadric (see cranium)
    d = cranium(f, u, s, P)
    # brow: a soft ridge across the front above the eyes, strongest over each eye
    brow = gauss(p, (372.0, -30.0, 0.0), (60.0, 24.0, 165.0)) * (0.55 + 0.45 * gauss(pm, (372.0, -30.0, 100.0), (60.0, 30.0, 60.0)))
    d = d - P['brow'] * brow

    # --- face masses: midface (maxilla), lower face (mandible body), ramus + masseter
    d = smin(d, ellipsoid(p, (155.0, -200.0, 0.0), (220.0, 170.0, 256.0)), 60.0)
    d = smin(d, ellipsoid(p, (140.0, -397.0, 0.0), (215.0, 139.0, 206.0)), 60.0)
    d = smin(d, ellipsoid(p, (48.0, -325.0, 0.0), (110.0, 152.0, 198.0)), 60.0)

    # --- cheekbones (zygoma): broad soft bumps, not balls
    d = d - P['cheek'] * gauss(pm, (300.0, -150.0, 168.0), (58.0, 34.0, 52.0))
    # --- buccal fill (cheek over the teeth), soft and further forward: no muzzle step
    d = smin(d, ellipsoid(pm, (215.0, -305.0, 140.0), (135.0, 112.0, 95.0)), 60.0)

    # --- muzzle (dental arch): wide and flat, part of the face rather than a snout; chin
    d = smin(d, ellipsoid(p, (268.0, -345.0, 0.0), (128.0, 124.0, 178.0)), 50.0)
    # philtrum / upper lip skin, from the nose base down to the lip
    d = smin(d, ellipsoid(p, (349.0, -300.0, 0.0), (72.0, 44.0, 84.0)), 28.0)
    d = smin(d, ellipsoid(p, (308.0, -470.0, 0.0), (75.0, 73.0, 112.0)), 34.0)
    # mentalis: fills the soft fold between the lower lip and the chin
    d = smin(d, ellipsoid(p, (344.0, -416.0, 0.0), (42.0, 34.0, 52.0)), 28.0)
    # under the chin: the soft floor of the mouth
    sm = ellipsoid(rot(sub3(p, (246.0, -502.0, 0.0)), 2, -8.5), (0, 0, 0), (100.0, 38.0, 115.0))
    d = smin(d, sm, 24.0)

    # --- mandible: body (chin -> gonion) and ramus (gonion -> in front of the ear), full masses
    jaw = round_cone(pm, (250.0, -478.0, 60.0), (-10.0, -405.0, 165.0), 48.0, 38.0)
    jaw = smin(jaw, round_cone(pm, (-10.0, -405.0, 165.0), (15.0, -265.0, 178.0), 38.0, 28.0), 30.0)
    d = smin(d, jaw, 58.0)
    # under the jaw (submandibular): the soft slope from the jaw line down into the neck, so the
    # jaw does not overhang a narrow throat (a groove in every turned view)
    sub = ellipsoid(rot(sub3(pm, P['sub_c']), 2, -15.7), (0, 0, 0), P['sub_r'])
    d = smin(d, sub, P['sub_k'])

    # --- eyes: a soft, shallow socket; an almond eye mound with an upper and a lower lid
    ef, eu, es = P['eye_f'], P['eye_u'], P['eye_s']
    sock = ellipsoid(pm, (ef + 66.0, eu + 2.0, es - 8.0), (34.0, 42.0, 50.0))
    d = ssub(d, sock, 26.0)
    er = P['eye_r']
    eye = sphere(pm, (ef, eu, es), er)
    lid_up = smax(sphere(pm, (ef, eu, es), er + 4.5),
                  (eu + P['lid_up']) - u + 0.30 * (f - ef - er), 3.0)
    lid_lo = smax(sphere(pm, (ef, eu, es), er + 3.0),
                  u - (eu - P['lid_lo']) - 0.15 * (f - ef - er), 3.0)
    eyes = smin(eye, smin(lid_up, lid_lo, 2.0), 2.0)
    d = smin(d, eyes, 8.0)

    # --- nose: dorsum, tip, columella, body wedge, alae, nostrils
    nose = round_cone(p, (376.0, -60.0, 0.0), (438.0, -184.0, 0.0), 17.0, 22.0)
    nose = smin(nose, sphere(p, (444.0, -199.0, 0.0), 23.0), 16.0)
    nose = smin(nose, round_cone(p, (447.0, -213.0, 0.0), (420.0, -275.0, 0.0), 18.0, 13.0), 14.0)
    wedge = ellipsoid(rot(sub3(p, (372.0, -168.0, 0.0)), 2, 27.0), (0, 0, 0), (50.0, 104.0, 46.0))
    nose = smin(nose, wedge, 18.0)
    nose = smin(nose, ellipsoid(pm, (386.0, -240.0, 44.0), (34.0, 24.0, 23.0)), 28.0)
    d = smin(d, nose, 20.0)
    d = ssub(d, ellipsoid(pm, (418.0, -262.0, 21.0), (15.0, 5.5, 9.0)), 4.0)

    # --- lips on the arch, mouth crease
    # lips: full in the middle, thinning towards the corners (a lens, not a bar)
    pl = bend(p, 175.0)
    ul = smin(ellipsoid(pl, (399.0, -341.0, 0.0), (15.0, 16.0, 88.0)),
              ellipsoid(pl, (401.0, -339.0, 0.0), (17.0, 18.0, 46.0)), 8.0)
    ll = smin(ellipsoid(pl, (392.0, -380.0, 0.0), (15.0, 20.0, 80.0)),
              ellipsoid(pl, (395.0, -381.0, 0.0), (18.0, 23.0, 44.0)), 8.0)
    d = smin(d, smin(ul, ll, 3.0), 12.0)
    d = ssub(d, ellipsoid(pl, (416.0, -356.0, 0.0), (8.0, 2.2, 76.0)), 2.0)

    # --- ears
    d = smin(d, ear(pm, P), 12.0)
    return d


def ear(pm, P):
    c = (P['ear_f'], P['ear_u'], P['ear_s'])
    q = sub3(pm, c)
    q = rot(q, 2, P['ear_tilt'])            # long axis leans back
    q = rot(q, 1, P['ear_flare'])           # back edge stands off the head
    disc = ellipsoid(q, (0, 0, 0), (60.0, 122.0, 15.0))
    bowl = ellipsoid(q, (6.0, -6.0, 13.0), (42.0, 92.0, 12.0))
    e = ssub(disc, bowl, 5.0)
    concha = ellipsoid(q, (14.0, -28.0, 9.0), (24.0, 30.0, 13.0))
    e = ssub(e, concha, 4.0)
    return e


# ----------------------------------------------------------------------------------- body

class Body:
    """neck -> trapezius -> shoulders: one superellipse cross-section per row y2, spanning the
    painted row in x at z = 0 (so the side view is the painting) and a smoothed version of the
    painted rows away from the midline (so kinks of the outline do not run across the body),
    with a designed half-width in z."""

    def __init__(self, y_tab, xb, xf, xb_soft, xf_soft, w, n, taper):
        self.y0 = float(y_tab[0])
        self.tabs = [np.asarray(v, np.float32) for v in (xb, xf, xb_soft, xf_soft, w, n, taper)]
        self.top = float(y_tab[0])
        self.bottom = float(y_tab[-1])

    @staticmethod
    def front_n(y2):
        return 0.9 * (1.0 - smoothstep(980.0, 1250.0, y2))

    def _tab(self, tab, i0, t):
        return tab[i0] * (1 - t) + tab[i0 + 1] * t

    def __call__(self, x2, y2, z2):
        i = clamp(y2 - self.y0, 0, len(self.tabs[0]) - 1.001)
        i0 = np.floor(i).astype(np.int32)
        t = (i - i0).astype(np.float32)
        xb, xf, xbs, xfs, w, n, tp = (self._tab(tb, i0, t) for tb in self.tabs)
        m = smoothstep(0.05, 0.45, np.abs(z2) / w)
        xb = xb + (xbs - xb) * m
        xf = xf + (xfs - xf) * m
        c = 0.5 * (xb + xf)
        a = np.maximum(0.5 * (xf - xb), 1.0)
        tx = (x2 - c) / a
        wl = w * (1.0 - tp * clamp(tx, -1.0, 1.0))           # front narrower than the back
        # the upper neck is fuller towards the throat (a squarer front): the jaw must not overhang a
        # lens-shaped throat (a groove under the jaw in every turned view)
        n = n + self.front_n(y2) * smoothstep(-0.2, 0.6, tx)
        qx = np.abs(tx)
        qz = np.abs(z2) / wl
        r = (qx ** n + qz ** n) ** (1.0 / n)
        d = (r - 1.0) * np.minimum(a, wl)
        # rounded top (inside the head) and the flat bottom below the frame
        d = smax(d, (self.top + 10.0) - y2, 30.0)
        d = np.maximum(d, y2 - self.bottom)
        return d


# ----------------------------------------------------------------------------------- all

DEFAULT = dict(
    skull_rf=395.0, skull_ru=375.0, skull_w=286.0, crane_w=302.0, brow=8.0, cheek=12.0,
    eye_f=298.0, eye_u=-82.0, eye_s=118.0, eye_r=46.0, lid_up=-2.0, lid_lo=22.0,
    ear_f=-48.0, ear_u=-150.0, ear_s=284.0, ear_tilt=16.0, ear_flare=22.0,
    neck_k=64.0, scm_k=56.0,
    sub_c=(85.0, -473.0, 105.0), sub_r=(105.0, 40.0, 86.0), sub_k=40.0,
)


def scm(x2, y2, z2):
    """sternocleidomastoid: from behind the ear (mastoid) down to the sternum, on both sides
    (ref2 coordinates). It fills the groove between the jaw and the neck and gives the turned neck
    its diagonal form."""
    q = (x2, y2, soft_abs(z2, 24.0))
    m = round_cone(q, (893.0, 528.0, 178.0), (884.0, 1150.0, 48.0), 34.0, 26.0)
    return m


def sculpt(x2, y2, z2, body, P=DEFAULT):
    f, u = to_head(x2, y2)
    d = head(f, u, z2, P)
    d = smin(d, body(x2, y2, z2), P['neck_k'])
    d = smin(d, scm(x2, y2, z2), P['scm_k'])
    return d
