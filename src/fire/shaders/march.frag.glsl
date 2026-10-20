// march.frag.glsl — front-to-back emission/absorption ray march of the fire volume, one ray
// per pixel of the (half-resolution) fire target. Output: premultiplied RGBA, twice: up to the
// nearest and up to the farthest bust depth of the full-resolution texels the pixel covers, so
// the composite can pick per full-resolution pixel (no leak over the head, no gap beside it).
//
// The ray is clipped to the box, to the occupied z range of its grid column (columns pass)
// and to the bust (depth texture of the same camera), and samples sit on world-aligned planes
// so neighbouring rays never show different slicing.

uniform sampler2D uScal;
uniform sampler2D uCols;
uniform sampler2D uNoise;
uniform sampler2D uDepth;
uniform float uHasDepth;
uniform vec2 uTargetSize;
uniform vec2 uDepthSize;
uniform mat4 uInvViewProj;
uniform int uSteps;
uniform float uTime;
uniform vec4 uDetail;        // x warp amplitude (world), y noise scale (cells / world unit), z flow period (s), w depth twist (rad / world unit)
uniform vec4 uShade;         // x absorption, y seconds to the bright cores, z rim (fuel below which edges glow light blue), w warm share
uniform vec4 uGlow;          // x glow of the bright end of the ramp, y darkening of fuel just off the scalp, z body brightness, w density -> core boost
uniform vec4 uIris;          // x noise wobble of the warm/cool border, y ramp jitter, z young fade (s), w cooling after the peak
uniform vec4 uWarmSel;       // x, y phase window of the warm family, z rim strength
uniform vec2 uEdge;          // x fade width at the box walls (cells), y the same at the top wall (above the image)
uniform int uDebug;

layout(location = 0) out vec4 fragColor;   // fire in front of the nearest bust depth of the covered texels
layout(location = 1) out vec4 fragFar;     // fire in front of the farthest one (differs on silhouette texels)

#define MAX_STEPS 160

// Two hue families sharing one brightness ramp, like the reference. Every flame tongue carries a
// phase (set where it left the scalp); it picks the family:
//   cool: deep blue, ultramarine, saturated blue, electric blue, cyan, near white
//   warm: deep blue, ultramarine, violet, magenta, orange, pale yellow
// so a warm tongue is a yellow-orange core ringed by magenta and violet that melts into the
// blue body, and a cool tongue has a white-cyan core. The ramp position u rises with the age
// of the fuel (and its density), from the dark roots at the scalp to the bright cores.
const vec3 COOL[6] = vec3[6](
  vec3(0.080, 0.025, 0.680),
  vec3(0.095, 0.035, 0.900),
  vec3(0.150, 0.120, 1.000),
  vec3(0.250, 0.520, 1.000),
  vec3(0.520, 0.880, 1.000),
  vec3(0.940, 0.975, 1.000)
);
const vec3 WARM[6] = vec3[6](
  vec3(0.080, 0.025, 0.680),
  vec3(0.095, 0.035, 0.900),
  vec3(0.420, 0.110, 0.950),
  vec3(0.900, 0.240, 0.640),
  vec3(0.990, 0.540, 0.160),
  vec3(0.995, 0.900, 0.560)
);
const vec3 RIM = vec3(0.30, 0.62, 1.00);

vec3 ramp(float u, float warm) {
  u = clamp(u, 0.0, 1.0) * 5.0;
  int i = min(int(u), 4);
  float f = smoothstep(0.0, 1.0, u - float(i));
  return mix(mix(COOL[i], COOL[i + 1], f), mix(WARM[i], WARM[i + 1], f), warm);
}

vec3 unproject(vec2 ndc, float z) {
  vec4 p = uInvViewProj * vec4(ndc, z, 1.0);
  return p.xyz / p.w;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 ndc = gl_FragCoord.xy / uTargetSize * 2.0 - 1.0;
  vec3 ro = unproject(ndc, -1.0);
  vec3 rd = normalize(unproject(ndc, 1.0) - ro);

  vec3 srd = vec3(abs(rd.x) < 1e-6 ? 1e-6 : rd.x, abs(rd.y) < 1e-6 ? 1e-6 : rd.y, abs(rd.z) < 1e-6 ? 1e-6 : rd.z);
  vec3 ia = (uBoundsMin - ro) / srd;
  vec3 ib = (uBoundsMax - ro) / srd;
  vec3 lo = min(ia, ib);
  vec3 hi = max(ia, ib);
  float tBox = max(max(lo.x, lo.y), max(lo.z, 0.0));
  float tEnd = min(min(hi.x, hi.y), hi.z);
  if (tEnd <= tBox) { fragColor = vec4(0.0); fragFar = vec4(0.0); return; }
  float ds = (tEnd - tBox) / float(uSteps);
  float ta = tBox;
  float tb = tEnd;

  // Occupied z range of this grid column.
  vec3 gIn = (ro + rd * tBox - uBoundsMin) / uCell;
  vec4 col = texelFetch(uCols, clamp(ivec2(floor(gIn.xy)), ivec2(0), ivec2(NX - 1, NY - 1)), 0);
  if (col.z > col.w) { fragColor = vec4(0.0); fragFar = vec4(0.0); return; }
  if (abs(rd.z) > 0.5) {
    float tz0 = (col.w - ro.z) / rd.z;
    float tz1 = (col.z - ro.z) / rd.z;
    ta = max(ta, min(tz0, tz1));
    tb = min(tb, max(tz0, tz1));
  }

  // Stop at the bust. tNear: nearest depth of the full-resolution texels this pixel covers (no
  // fire behind the head leaks over its edge), tb: the farthest (no gap beside the head).
  float tNear = tb;
  if (uHasDepth > 0.5) {
    vec2 ratio = uDepthSize / uTargetSize;
    ivec2 pix = ivec2(gl_FragCoord.xy);
    ivec2 a = ivec2(floor(vec2(pix) * ratio));
    ivec2 b = min(ivec2(ceil(vec2(pix + 1) * ratio)) - 1, a + 1);
    ivec2 mx = ivec2(uDepthSize) - 1;
    float d0 = texelFetch(uDepth, clamp(a, ivec2(0), mx), 0).r;
    float d1 = texelFetch(uDepth, clamp(ivec2(b.x, a.y), ivec2(0), mx), 0).r;
    float d2 = texelFetch(uDepth, clamp(ivec2(a.x, b.y), ivec2(0), mx), 0).r;
    float d3 = texelFetch(uDepth, clamp(b, ivec2(0), mx), 0).r;
    float dzNear = min(min(d0, d1), min(d2, d3));
    float dzFar = max(max(d0, d1), max(d2, d3));
    if (dzNear < 1.0) tNear = min(tb, dot(unproject(ndc, dzNear * 2.0 - 1.0) - ro, rd));
    if (dzFar < 1.0) tb = min(tb, dot(unproject(ndc, dzFar * 2.0 - 1.0) - ro, rd));
  }
  if (tb <= ta) { fragColor = vec4(0.0); fragFar = vec4(0.0); return; }

  float kStart = max(floor((ta - tBox) / ds), 0.0);
  int n = int(ceil((tb - tBox) / ds) - kStart);

  // Small-scale detail: a view-coherent warp of the lookups, from two phases of the tiling
  // noise advected by the column's mean flow (classic flow-map blend), so the detail drifts
  // with the flames instead of sliding over them. It twists slowly with depth.
  vec4 nz = vec4(0.0);
  if (uDetail.x > 0.0) {
    vec2 flow = textureLod(uCols, gIn.xy / vec2(float(NX), float(NY)), 0.0).xy;
    float per = uDetail.z;
    float ph = uTime / per;
    float f0 = fract(ph);
    float f1 = fract(ph + 0.5);
    float wA = 1.0 - abs(2.0 * f0 - 1.0);
    vec2 base = (ro.xy + rd.xy * tBox) * uDetail.y;
    vec2 offA = vec2(hash12(vec2(floor(ph), 1.7)), hash12(vec2(floor(ph), 9.2))) * 8.0;
    vec2 offB = vec2(hash12(vec2(floor(ph + 0.5), 4.1)), hash12(vec2(floor(ph + 0.5), 2.3))) * 8.0;
    vec4 nA = textureLod(uNoise, (base - flow * uDetail.y * per * f0 + offA) * 0.125, 0.0) - 0.5;
    vec4 nB = textureLod(uNoise, (base - flow * uDetail.y * per * f1 + offB) * 0.125, 0.0) - 0.5;
    nz = (nA * wA + nB * (1.0 - wA)) * (2.0 / sqrt(wA * wA + (1.0 - wA) * (1.0 - wA)));
  }

  vec3 acc = vec3(0.0);
  float T = 1.0;
  vec3 accNear = vec3(0.0);
  float TNear = 1.0;
  bool near = tNear < tb;   // a silhouette pixel: snapshot when the ray passes tNear
  float dsum = 0.0;
  float asum = 0.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= n) break;
    float t = tBox + (kStart + float(i) + 0.5) * ds;
    if (near && t > tNear) { accNear = acc; TNear = T; near = false; }
    float seg = clamp(min(tb, t + 0.5 * ds) - max(ta, t - 0.5 * ds), 0.0, ds);
    vec3 p = ro + rd * t;
    float ang = p.z * uDetail.w;
    vec2 wv = nz.xy * cos(ang) + nz.zw * sin(ang);
    vec3 g = (p + vec3(wv * uDetail.x, 0.0) - uBoundsMin) / uCell;
    vec4 s = sampleGrid(uScal, g);
    // Never show the box: fade over uEdge.x cells at every wall. The fade scales opacity and
    // emission only; the colour comes from the raw fuel (a faded edge must not read as a thin
    // edge with its rim glow).
    vec3 eg = min(g, GRIDF - g);
    eg.y = min(g.y, (GRIDF.y - g.y) * (uEdge.x / uEdge.y));
    float wall = smoothstep(0.0, uEdge.x, min(min(eg.x, eg.y), eg.z));
    float d = s.r;
    if (d * wall < 1e-3) continue;
    float inv = 1.0 / max(s.r, 1e-3);
    float age = s.g * inv;
    float phase = s.b * inv;

    if (uDebug != 0) {
      dsum += d * wall * seg;
      asum += d * wall * seg * (uDebug == 3 ? phase : age);
      continue;
    }

    // Ramp position: rises with age to the bright cores (denser fuel gets there first), then
    // cools back towards blue.
    float rise = age / uShade.y;
    float u = min(rise, 1.0) - max(rise - 1.0, 0.0) * uIris.w;
    u = max(u, min(rise, 0.32));
    u *= 1.0 + uGlow.w * (smoothstep(0.15, 0.9, d) - 0.5);
    u += uIris.y * nz.w;
    // family: warm tongues by phase (the detail noise wobbles the border between families)
    float warm = smoothstep(uWarmSel.x, uWarmSel.y, phase + uIris.x * nz.z) * uShade.w;
    vec3 c = ramp(u, warm);
    // thin edges glow light blue against the background
    float thin = 1.0 - smoothstep(0.0, uShade.z, d);
    c = mix(c, RIM, thin * uWarmSel.z * smoothstep(0.2, 0.5, u));
    // fuel just off the scalp is darker, so the roots merge into the navy head
    c *= uGlow.z * (1.0 - uGlow.y * (1.0 - smoothstep(0.0, uIris.z, age)));
    float bright = smoothstep(0.45, 0.85, u);
    float sigma = uShade.x * d * wall;
    float a = 1.0 - exp(-sigma * seg);
    acc += T * (c * a + c * (bright * uGlow.x * d * wall * seg));
    T *= 1.0 - a;
    if (T < 0.004) break;
  }

  if (uDebug == 1) {
    float v = 1.0 - exp(-dsum * uShade.x * 0.5);
    fragColor = vec4(vec3(v), 1.0);
    fragFar = fragColor;
    return;
  }
  if (uDebug == 3) {
    float v = 1.0 - exp(-dsum * uShade.x * 0.5);
    float ph = asum / max(dsum, 1e-5);
    fragColor = vec4(ramp(0.85, smoothstep(uWarmSel.x, uWarmSel.y, ph)) * v, 1.0);
    fragFar = fragColor;
    return;
  }
  if (uDebug == 2) {
    float v = 1.0 - exp(-dsum * uShade.x * 0.5);
    float ag = asum / max(dsum, 1e-5);
    vec3 ac = ramp(ag / uShade.y, 0.0);
    fragColor = vec4(ac * v, 1.0);
    fragFar = fragColor;
    return;
  }
  fragFar = vec4(acc, 1.0 - T);
  fragColor = near ? fragFar : (tNear < tb ? vec4(accNear, 1.0 - TNear) : fragFar);
}
