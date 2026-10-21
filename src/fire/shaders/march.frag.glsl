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
uniform vec3 uEdge;          // x fade width at the box walls (cells), y the same at the top wall (above the image), z at the Z walls (they face the camera)
uniform vec4 uLit;           // x ramp lift by the light (scalars .a), y darkening of the unlit folds, z neutral light level, w fine detail amplitude (share of uDetail.x)
uniform vec2 uBands;         // x colour bands along the ramp (0 = smooth), y softness of the steps between them (0..0.5)
uniform vec3 uDensity;       // opacity contrast curve: x knee (fuel), y strength, z softness (share of the knee it ramps over): thin haze turns clear, so the tongues get edges
uniform vec4 uHeight;        // the painting's vertical gradient: x, y world heights where the ramp runs from start to end, z share of height in the ramp position (vs the fuel's age), w detail-noise wobble of it
uniform float uRimWarm;      // thin edges: 0 glow light blue, 1 iridescent (violet, pink, orange, peach) like the painting's rims
uniform vec4 uFan;           // the painting's composition: the plume is drawn wider with height around a vertical axis, so
                             //   the flames behind the head lean up and back and the ones over the face up and forwards.
                             //   x axis X (world), y height where the spread starts, z height where it is full, w spread behind (x < axis)
uniform float uFanFront;     //   spread in front (x > axis)
uniform float uMapAge;       // gradient map: share of the fuel's age (vs the fuel along the ray) in the non-height part: age runs along each tongue
uniform float uRimGlow;      // a glow along the fire's edge against the background (added light: the painting's bright profile rim)
uniform float uMapBust;      // over the head the curve starts at 0 and ends this much later: the flames fade softly into the face
uniform vec2 uMapAlpha;      // gradient map opacity curve (smoothstep lo, hi): the painting's opaque colour fields with short soft edges, no veils
uniform vec4 uMap;           // gradient map (the painting's smooth colour fields): x share of it in the result (0 = per-sample colour),
                             //   y fuel along the ray that reaches the middle of the ramp, z fuel below which the ray is a rim,
                             //   w share of the ramp position that comes from height (the rest from the fuel along the ray)
uniform int uDebug;

layout(location = 0) out vec4 fragColor;   // fire in front of the nearest bust depth of the covered texels
layout(location = 1) out vec4 fragFar;     // fire in front of the farthest one (differs on silhouette texels)

#define MAX_STEPS 160

// Two hue families sharing one brightness ramp, sampled from the painting (tools/reference2.webp).
// Every flame tongue carries a phase (set where it left the scalp); it picks the family:
//   cool: violet-navy, deep violet-blue, electric violet-blue (the body), azure, pale cyan, cream
//   warm: violet-navy, deep violet-blue, purple, pink, orange, pale yellow
// The ramp position u rises with height (the painting's gradient, brow to the top of the frame)
// and with the age of the fuel, so the body is the painting's fully saturated, fully bright
// violet-blue and only the top of the plume turns azure, cyan and cream.
const vec3 COOL[6] = vec3[6](
  vec3(0.070, 0.050, 0.420),
  vec3(0.150, 0.050, 0.820),
  vec3(0.200, 0.100, 1.000),
  vec3(0.280, 0.520, 0.990),
  vec3(0.500, 0.850, 0.960),
  vec3(0.920, 0.880, 0.740)
);
const vec3 WARM[6] = vec3[6](
  vec3(0.070, 0.050, 0.420),
  vec3(0.200, 0.050, 0.860),
  vec3(0.600, 0.130, 0.930),
  vec3(0.880, 0.240, 0.640),
  vec3(0.950, 0.520, 0.240),
  vec3(0.920, 0.840, 0.540)
);
const vec3 RIM = vec3(0.30, 0.62, 1.00);
// the painting's iridescent rims, from the body outwards: violet, pink, orange, peach
vec3 rimWarm(float t) {
  t = clamp(t, 0.0, 1.0) * 3.0;
  vec3 a = vec3(0.420, 0.080, 0.960);
  vec3 b = vec3(0.920, 0.260, 0.520);
  vec3 c = vec3(0.960, 0.520, 0.220);
  vec3 d = vec3(0.930, 0.780, 0.560);
  return t < 1.0 ? mix(a, b, smoothstep(0.0, 1.0, t)) : t < 2.0 ? mix(b, c, smoothstep(1.0, 2.0, t)) : mix(c, d, smoothstep(2.0, 3.0, t));
}

vec3 ramp(float u, float warm) {
  u = clamp(u, 0.0, 1.0) * 5.0;
  int i = min(int(u), 4);
  float f = smoothstep(0.0, 1.0, u - float(i));
  return mix(mix(COOL[i], COOL[i + 1], f), mix(WARM[i], WARM[i + 1], f), warm);
}

// The gradient map: one colour for the whole ray, from how much fuel it crossed (the plume's core
// is bright azure to cyan, its body the painting's violet-blue, its edges violet) and from the
// height of that fuel (the painting's vertical gradient), the warm family where warm tongues dominate,
// and the thin rims iridescent (pink, orange, peach). Premultiplied by the ray's opacity.
vec4 mapColour(vec4 g, float w, float alpha, vec4 nz, float onBust) {
  if (alpha <= 1e-4 || w <= 1e-6) return vec4(0.0);
  // the edge of the colour field: where the ray's raw opacity crosses the curve's knee
  float edgeA = 1.0 - smoothstep(uMapAlpha.x, min(1.0, uMapAlpha.y + 0.25), alpha);
  if (uMapAlpha.x > 0.0 || uMapAlpha.y < 1.0) {
    float lo = mix(uMapAlpha.x, 0.0, onBust);
    float hi = min(1.0, uMapAlpha.y + uMapBust * onBust);
    alpha = smoothstep(lo, hi, alpha);
  }
  float fuel = g.x;
  float age = g.y / w;
  float warmShare = g.z / w;
  float hy = g.w / w + uHeight.w * (nz.x + nz.y) * (uHeight.y - uHeight.x);
  float uf = 1.0 - exp(-fuel / max(uMap.y, 1e-4) * 0.6931);   // 0.5 at uMap.y
  float uh = clamp((hy - uHeight.x) / (uHeight.y - uHeight.x), 0.0, 1.0);
  float ua = clamp(age / uShade.y, 0.0, 1.0);
  float u = mix(mix(uf, ua, uMapAge), uh, uMap.w) + uIris.y * nz.w;
  // young fuel (just off the scalp) stays deep, so the roots merge into the navy head
  u *= 1.0 - uGlow.y * (1.0 - smoothstep(0.0, uIris.z, age));
  float warm = clamp(smoothstep(0.35, 0.75, warmShare) * uShade.w, 0.0, 1.0);   // only rays mostly through warm tongues: local, saturated accents
  vec3 c = ramp(u, warm);
  // rims only where the fire meets the background (over the head its thin edge stays deep violet)
  float thin = max(1.0 - smoothstep(0.0, uMap.z, fuel), edgeA) * (1.0 - onBust);
  vec3 rc = mix(RIM, rimWarm(thin * (0.85 + 0.3 * nz.y)), uRimWarm);
  c = mix(c, rc, thin * uWarmSel.z);
  c *= uGlow.z;
  // the glowing rim: a band of added light where the colour field's edge meets the background
  float glow = 4.0 * edgeA * (1.0 - edgeA) * (1.0 - onBust) * uRimGlow;
  vec3 gc = rimWarm(0.6 + 0.22 * edgeA);
  return vec4(c * alpha + gc * glow, alpha);
}

// Where the simulation is sampled for a point p of the drawn fire: the sim's plume, widened with
// height around the axis (a pure x-warp: rays of the orthographic camera stay in one grid column).
vec3 fanned(vec3 p) {
  if (uFan.w <= 0.0 && uFanFront <= 0.0) return p;
  float h = smoothstep(uFan.y, uFan.z, p.y);
  float s = (p.x < uFan.x ? uFan.w : uFanFront) * h;
  return vec3(uFan.x + (p.x - uFan.x) / (1.0 + s), p.y, p.z);
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
  // the drawn fire reaches further out than the simulation box where the fan widens it
  vec3 rbMin = uBoundsMin;
  vec3 rbMax = uBoundsMax;
  rbMin.x = uFan.x + (uBoundsMin.x - uFan.x) * (1.0 + max(uFan.w, 0.0));
  rbMax.x = uFan.x + (uBoundsMax.x - uFan.x) * (1.0 + max(uFanFront, 0.0));
  vec3 ia = (rbMin - ro) / srd;
  vec3 ib = (rbMax - ro) / srd;
  vec3 lo = min(ia, ib);
  vec3 hi = max(ia, ib);
  float tBox = max(max(lo.x, lo.y), max(lo.z, 0.0));
  float tEnd = min(min(hi.x, hi.y), hi.z);
  if (tEnd <= tBox) { fragColor = vec4(0.0); fragFar = vec4(0.0); return; }
  float ds = (tEnd - tBox) / float(uSteps);
  float ta = tBox;
  float tb = tEnd;

  // Occupied z range of this grid column (of the fanned position: the ray's x is constant).
  vec3 pIn = fanned(ro + rd * tBox);
  vec3 gIn = (pIn - uBoundsMin) / uCell;
  if (gIn.x < 0.0 || gIn.x > GRIDF.x) { fragColor = vec4(0.0); fragFar = vec4(0.0); return; }
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
  float bustNear = 0.0;     // the ray ends on the bust (nearest / farthest covered depth texel)
  float bustFar = 0.0;
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
    bustNear = dzNear < 1.0 ? 1.0 : 0.0;
    bustFar = dzFar < 1.0 ? 1.0 : 0.0;
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
    vec2 base = pIn.xy * uDetail.y;
    vec2 offA = vec2(hash12(vec2(floor(ph), 1.7)), hash12(vec2(floor(ph), 9.2))) * 8.0;
    vec2 offB = vec2(hash12(vec2(floor(ph + 0.5), 4.1)), hash12(vec2(floor(ph + 0.5), 2.3))) * 8.0;
    vec4 nA = textureLod(uNoise, (base - flow * uDetail.y * per * f0 + offA) * 0.125, 0.0) - 0.5;
    vec4 nB = textureLod(uNoise, (base - flow * uDetail.y * per * f1 + offB) * 0.125, 0.0) - 0.5;
    if (uLit.w > 0.0) {
      // a finer octave (2.7x) riding the same flow: small licks and frayed edges on the tongues
      const float FINE = 2.7;
      nA += uLit.w * (textureLod(uNoise, ((base - flow * uDetail.y * per * f0) * FINE + offA.yx + 3.1) * 0.125, 0.0).wzyx - 0.5);
      nB += uLit.w * (textureLod(uNoise, ((base - flow * uDetail.y * per * f1) * FINE + offB.yx + 7.9) * 0.125, 0.0).wzyx - 0.5);
    }
    nz = (nA * wA + nB * (1.0 - wA)) * (2.0 / sqrt(wA * wA + (1.0 - wA) * (1.0 - wA)));
  }

  vec3 acc = vec3(0.0);
  float T = 1.0;
  vec3 accNear = vec3(0.0);
  float TNear = 1.0;
  bool near = tNear < tb;   // a silhouette pixel: snapshot when the ray passes tNear
  float dsum = 0.0;
  float asum = 0.0;
  // gradient map: the fuel along the ray, and its fuel-weighted age, warm share and height
  // (weighted by what the viewer still sees of it: transmittance), up to here and up to tNear
  vec4 gm = vec4(0.0);      // x fuel, y age, z warm share, w height (sums)
  float gw = 0.0;           // weight sum
  vec4 gmNear = vec4(0.0);
  float gwNear = 0.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= n) break;
    float t = tBox + (kStart + float(i) + 0.5) * ds;
    if (near && t > tNear) { accNear = acc; TNear = T; gmNear = gm; gwNear = gw; near = false; }
    float seg = clamp(min(tb, t + 0.5 * ds) - max(ta, t - 0.5 * ds), 0.0, ds);
    vec3 p = ro + rd * t;
    float ang = p.z * uDetail.w;
    vec2 wv = nz.xy * cos(ang) + nz.zw * sin(ang);
    vec3 g = (fanned(p) + vec3(wv * uDetail.x, 0.0) - uBoundsMin) / uCell;
    vec4 s = sampleGrid(uScal, g);
    // Never show the box: fade over uEdge.x cells at every wall. The fade scales opacity and
    // emission only; the colour comes from the raw fuel (a faded edge must not read as a thin
    // edge with its rim glow).
    vec3 eg = min(g, GRIDF - g);
    eg.y = min(g.y, (GRIDF.y - g.y) * (uEdge.x / uEdge.y));
    eg.z *= uEdge.x / uEdge.z;
    float wall = smoothstep(0.0, uEdge.x, min(min(eg.x, eg.y), eg.z));
    float d = s.r;
    if (d * wall < 1e-3) continue;
    float inv = 1.0 / max(s.r, 1e-3);
    float age = s.g * inv;
    float phase = s.b * inv;

    if (uDebug != 0) {
      dsum += d * wall * seg;
      asum += d * wall * seg * (uDebug == 3 ? phase : uDebug == 4 ? s.a : age);
      continue;
    }

    // Ramp position: rises with age to the bright cores (denser fuel gets there first), then
    // cools back towards blue.
    float rise = age / uShade.y;
    float u = min(rise, 1.0) - max(rise - 1.0, 0.0) * uIris.w;
    u = max(u, min(rise, 0.32));
    // the painting's vertical gradient: by height, wobbled by the drifting detail noise
    if (uHeight.z > 0.0) {
      float hy = p.y + uHeight.w * (nz.x + nz.y) * (uHeight.y - uHeight.x);
      float hU = clamp((hy - uHeight.x) / (uHeight.y - uHeight.x), 0.0, 1.0);
      u = mix(u, hU, uHeight.z);
    }
    u *= 1.0 + uGlow.w * (smoothstep(0.15, 0.9, d) - 0.5);
    u += uIris.y * nz.w;
    // light through the fuel (scalars .a): lit crests climb the ramp towards cyan and white,
    // the folds between tongues sink towards deep ultramarine
    float lit = s.a;
    u += uLit.x * (lit - uLit.z);
    // painterly colour fields: the ramp position gathers into bands with soft but clear steps
    // between them (like the painting's zones of ultramarine, blue, cyan, white)
    if (uBands.x > 0.0) {
      float ub = clamp(u, 0.0, 1.0) * uBands.x;
      float fb = fract(ub);
      u = (ub - fb + smoothstep(0.5 - uBands.y, 0.5 + uBands.y, fb)) / uBands.x;
    }
    // family: warm tongues by phase (the detail noise wobbles the border between families)
    float warm = smoothstep(uWarmSel.x, uWarmSel.y, phase + uIris.x * nz.z) * uShade.w;
    vec3 c = ramp(u, warm);
    // thin edges glow light blue against the background
    float thin = 1.0 - smoothstep(0.0, uShade.z, d);
    if (uRimWarm > 0.0) {
      // iridescent rim: the thinner the fuel, the further along violet, pink, orange, peach
      vec3 rc = rimWarm(thin * (0.85 + 0.3 * nz.y));
      c = mix(c, mix(RIM, rc, uRimWarm), thin * uWarmSel.z);
    } else {
      c = mix(c, RIM, thin * uWarmSel.z * smoothstep(0.2, 0.5, u));
    }
    // fuel just off the scalp is darker, so the roots merge into the navy head
    c *= uGlow.z * (1.0 - uGlow.y * (1.0 - smoothstep(0.0, uIris.z, age)));
    c *= 1.0 - uLit.y * (1.0 - lit);
    float bright = smoothstep(0.45, 0.85, u);
    // opacity contrast: fuel under the knee turns clear faster than linearly, so a tongue ends
    // in a defined (still soft) edge instead of a long haze
    float dOp = d * mix(1.0, smoothstep(uDensity.x * (1.0 - uDensity.z), uDensity.x, d), uDensity.y);
    float sigma = uShade.x * dOp * wall;
    float a = 1.0 - exp(-sigma * seg);
    if (uMap.x > 0.0) {
      // the warm share (not the mean phase: averaging tongues would tint every ray lilac)
      float wsel = smoothstep(uWarmSel.x, uWarmSel.y, phase + uIris.x * nz.z);
      float wgt = d * wall * seg * T;
      gm += vec4(d * wall * seg, wgt * age, wgt * wsel, wgt * p.y);
      gw += wgt;
    }
    acc += T * (c * a + c * (bright * uGlow.x * dOp * wall * seg));
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
  if (uDebug == 4) {
    float v = 1.0 - exp(-dsum * uShade.x * 0.5);
    fragColor = vec4(vec3(asum / max(dsum, 1e-5)) * v, 1.0);
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
  if (uMap.x > 0.0) {
    vec4 gNear = near ? gm : (tNear < tb ? gmNear : gm);
    float wNear = near ? gw : (tNear < tb ? gwNear : gw);
    fragFar = mix(fragFar, mapColour(gm, gw, 1.0 - T, nz, bustFar), uMap.x);
    fragColor = mix(fragColor, mapColour(gNear, wNear, fragColor.a, nz, bustNear), uMap.x);
  }
}
