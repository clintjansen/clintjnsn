"""Signed-distance primitives (numpy, float32). Negative inside. Points are tuples of arrays."""
import numpy as np


def clamp(x, a, b):
    return np.minimum(np.maximum(x, a), b)


def smoothstep(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b + (a - b) * h - k * h * (1.0 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def ssub(a, b, k):
    """a minus b (smooth)"""
    return smax(a, -b, k)


def rot(p, axis, deg):
    """rotate the point set by -deg about axis (i.e. express p in a frame rotated by +deg)"""
    a = np.radians(deg)
    c, s = np.float32(np.cos(a)), np.float32(np.sin(a))
    x, y, z = p
    if axis == 0:      # about f
        return (x, c * y + s * z, -s * y + c * z)
    if axis == 1:      # about u
        return (c * x - s * z, y, s * x + c * z)
    return (c * x + s * y, -s * x + c * y, z)   # about s


def sub(p, c):
    return (p[0] - np.float32(c[0]), p[1] - np.float32(c[1]), p[2] - np.float32(c[2]))


def ellipsoid(p, c, r):
    """IQ's bound for an ellipsoid (good near the surface)."""
    x, y, z = sub(p, c)
    rx, ry, rz = (np.float32(v) for v in r)
    k0 = np.sqrt((x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2)
    k1 = np.sqrt((x / (rx * rx)) ** 2 + (y / (ry * ry)) ** 2 + (z / (rz * rz)) ** 2)
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def sphere(p, c, r):
    x, y, z = sub(p, c)
    return np.sqrt(x * x + y * y + z * z) - np.float32(r)


def round_cone(p, a, b, r1, r2):
    """IQ's round cone between points a (radius r1) and b (radius r2)."""
    a = np.asarray(a, np.float32)
    b = np.asarray(b, np.float32)
    ba = b - a
    l2 = float(ba @ ba)
    rr = r1 - r2
    a2 = l2 - rr * rr
    il2 = 1.0 / l2
    px, py, pz = p[0] - a[0], p[1] - a[1], p[2] - a[2]
    y = px * ba[0] + py * ba[1] + pz * ba[2]
    z = y - l2
    xx = (px * l2 - ba[0] * y) ** 2 + (py * l2 - ba[1] * y) ** 2 + (pz * l2 - ba[2] * y) ** 2
    y2 = y * y * l2
    z2 = z * z * l2
    k = np.sign(rr) * rr * rr * xx
    out = (np.sqrt(xx * a2 * il2) + y * rr) * il2 - r1
    out = np.where(np.sign(z) * a2 * z2 > k, np.sqrt(xx + z2) * il2 - r2, out)
    out = np.where(np.sign(y) * a2 * y2 < k, np.sqrt(xx + y2) * il2 - r1, out)
    return out.astype(np.float32)
