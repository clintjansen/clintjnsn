// JNSN — the whole page is this one fragment shader.
//
// Coordinate conventions
//   suv : screen uv, y DOWN (0,0 top-left)
//   iuv : image uv,  y DOWN, matches the prepared plates (flipY = false)
//   p   : aspect-corrected image coordinates (x in [0, aspect], y in [0, 1]) — isotropic
//   bust space: p relative to the neck pivot, z towards the viewer (orthographic camera)
//
// Layers (back to front)
//   1. procedural magma: flat red -> organic spread (loader) -> red with flowing contour lines
//   2. the background plates (fox, pale area) with static contour lines
//   3. THE BUST: a ray-marched signed-distance model, shaded in the art's navy with contour
//      lines that follow the form, lit by the magma and the fox; it turns, nods, breathes
//   4. volumetric flame hair on the crown, blown back, bending away from the pointer
//   5. the fox's eyes, vignette, grain

// (three.js prepends #version 300 es, precision and the gl_FragColor/texture2D shims)

uniform sampler2D uBase;     // RGB background plate, lines removed, character + card inpainted
uniform sampler2D uDetail;   // RGB background plate, unblurred (sharp fox)
uniform sampler2D uMask;     // R reference silhouette (unused in the look), G fox, B magma; pale = rest
uniform sampler2D uFields;   // R figure field (wide), G unused, B fox soft
uniform sampler2D uExtra;    // R unused, G unused, B baked lines (0.5 = flat)
uniform sampler2D uNoise;    // tiling 4-channel noise (see src/noise.js)

uniform vec2  uResolution;   // render target size (px)
uniform float uTime;         // seconds (only advances while rendering)
uniform vec4  uCover;        // iuv = suv * uCover.xy + uCover.zw
uniform float uAspect;       // image width / height
uniform float uLineFreq;     // contour-line periods per image height
uniform float uCoverScale;   // image px -> screen px factor

uniform float uSpread;       // loader magma radius in aspect units (0 = none, big = everywhere)
uniform float uReveal;       // artwork fade-in 0..1
uniform float uWaveT;        // seconds since the reveal wave started (large = no wave)

uniform float uTurn;         // head glance 0..1 (brightens the face a little)
uniform vec2  uHeadRig;      // bust head yaw, pitch (radians): glance spring + idle sway
uniform vec4  uFoxRig;       // fox head yaw, pitch (radians), sniff envelope 0..1, retreat 0..1
uniform float uBreath;       // -1..1
uniform vec2  uBob;          // image-uv offset of the bust
uniform float uLightAngle;   // radians, wandering key light
uniform float uFlare;        // 0..1 slow random flare of the hot light
uniform vec2  uCrown;        // (unused: the crown is part of the model)
uniform vec4  uCardRect;     // glass card in image uv (x0, y0, x1, y1)
uniform float uHairSplit;    // (unused)
uniform vec4  uTrail[8];     // pointer trail: u, v, age (s), strength
uniform vec2  uPointer;      // current pointer (image uv)
uniform vec2  uPointerVel;   // image uv / s
uniform float uPointerOn;    // 1 while a pointer is over the page
uniform vec4  uFoxLook;      // gaze direction (image uv), attention 0..1, upset 0..1
uniform float uFoxPhase;     // fox glow pulse phase

// Art-direction knobs (set from JS so they can be tuned live)
uniform float uFlowSpeed;    // magma line drift, periods per second
uniform float uWarpSpeed;    // magma domain warp evolution
uniform float uLineWidth;    // 0..0.5 fraction of a period that is dark
uniform float uBakedMix;     // (unused)
uniform float uFlameAmount;  // hair flames, 0..1+
uniform float uGrain;        // 0..0.1
uniform float uDebug;        // 0 off, 1 bust only (flat light), 2 masks, 3 lines only, 4 hair density
uniform int   uMarchSteps;   // ray-march step cap (uniform, so the compiler keeps real loops)
uniform int   uHairSteps;    // volumetric hair samples

// --------------------------------------------------------------------------- noise

float hash1(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

const mat2 ROT = mat2(0.80, 0.60, -0.60, 0.80);

float ntex(vec2 p, vec4 sel) {
  return dot(texture2D(uNoise, p * 0.125), sel) * 2.0 - 1.0;
}
float fbm3(vec2 p) {
  float v = ntex(p, vec4(1.0, 0.0, 0.0, 0.0)) * 0.62 + ntex(ROT * p * 4.1 + 7.3, vec4(0.0, 1.0, 0.0, 0.0)) * 0.16;
  return v * 0.62 + 0.5;
}
float fbm4(vec2 p) {
  float v = ntex(p, vec4(1.0, 0.0, 0.0, 0.0)) * 0.62
          + ntex(ROT * p * 2.3 + 5.1, vec4(0.0, 0.0, 1.0, 0.0)) * 0.24
          + ntex(ROT * ROT * p * 4.1 + 7.3, vec4(0.0, 0.0, 0.0, 1.0)) * 0.11;
  return v * 0.6 + 0.5;
}
// cheap 3D-ish noise: two 2D slices blended by z (good enough for flames and surface grain)
float noise3(vec3 q) {
  float zf = fract(q.z * 0.7);
  float a = fbm3(q.xy + vec2(floor(q.z * 0.7) * 3.17, 0.0));
  float b = fbm3(q.xy + vec2((floor(q.z * 0.7) + 1.0) * 3.17, 0.0));
  return mix(a, b, zf * zf * (3.0 - 2.0 * zf));
}

// --------------------------------------------------------------------------- contour lines

float linePhase(vec2 p, float figure, float flow, float t) {
  vec2 q = p * 2.4;
  vec2 w = vec2(fbm3(q + vec2(0.0, t * uWarpSpeed * flow)),
                fbm3(q + vec2(5.2, 1.3) + vec2(-t * uWarpSpeed * 0.7 * flow, t * uWarpSpeed * 0.3 * flow)));
  vec2 pw = p + (w - 0.5) * 0.32;
  float n = fbm4(pw * 3.6 + vec2(t * 0.013 * flow, 0.0));
  return (pw.x * 0.62 + pw.y * 0.78) * uLineFreq + (n - 0.5) * 7.5 + figure * 13.0 + t * uFlowSpeed * flow;
}
float lineCoverage(float phi, float width, float aa) {
  float d = abs(fract(phi) - 0.5) * 2.0;
  float w = width * 2.0;
  return 1.0 - smoothstep(w - aa, w + aa, d);
}

// --------------------------------------------------------------------------- SDF toolbox

float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-5);
}
float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
// signed distance to an axis-aligned ellipse (good enough as a cheap 2D bound)
float sdEllipse2(vec2 p, vec2 c, vec2 r) {
  vec2 q = (p - c) / r;
  float k0 = length(q);
  float k1 = length(q / r);
  return k0 * (k0 - 1.0) / max(k1, 1e-5);
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float smax(float a, float b, float k) { return -smin(-a, -b, k); }

// The bust, in object space: origin at the base of the neck, y DOWN, x = facing direction,
// z towards the viewer. Units: image height. Stylised, smooth, slightly angular.
float sdBust(vec3 q, float breath) {
  // cranium: a tall, slightly backwards-leaning skull
  float d = sdEllipsoid(q - vec3(-0.06, -0.47, 0.0), vec3(0.235, 0.245, 0.215));
  d = smin(d, sdEllipsoid(q - vec3(-0.12, -0.57, 0.0), vec3(0.17, 0.14, 0.17)), 0.09);
  // face mass (cheeks) and jaw: ellipsoids, not boxes, so the profile stays organic
  d = smin(d, sdEllipsoid(q - vec3(0.07, -0.29, 0.0), vec3(0.16, 0.19, 0.14)), 0.09);
  d = smin(d, sdEllipsoid(q - vec3(0.11, -0.15, 0.0), vec3(0.15, 0.085, 0.11)), 0.07);
  // chin
  d = smin(d, sdEllipsoid(q - vec3(0.175, -0.11, 0.0), vec3(0.06, 0.045, 0.065)), 0.045);
  // brow / forehead
  d = smin(d, sdEllipsoid(q - vec3(0.15, -0.41, 0.0), vec3(0.08, 0.06, 0.12)), 0.06);
  // nose: bridge + tip
  d = smin(d, sdCapsule(q, vec3(0.19, -0.34, 0.0), vec3(0.255, -0.225, 0.0), 0.028), 0.03);
  d = smin(d, sdEllipsoid(q - vec3(0.25, -0.215, 0.0), vec3(0.048, 0.034, 0.032)), 0.035);
  // lips
  d = smin(d, sdEllipsoid(q - vec3(0.22, -0.15, 0.0), vec3(0.026, 0.016, 0.04)), 0.03);
  // ear, proud of the side facing the viewer
  d = smin(d, sdEllipsoid(q - vec3(-0.05, -0.31, 0.19), vec3(0.04, 0.062, 0.028)), 0.045);
  // eye socket: a shallow dish under the brow (the glass card hides the eye itself)
  d = smax(d, -(length(q - vec3(0.215, -0.355, 0.165)) - 0.085), 0.03);
  // neck
  d = smin(d, sdCapsule(q, vec3(-0.02, -0.16, 0.0), vec3(-0.06, 0.10, 0.0), 0.09), 0.08);
  // shoulders / chest: rise a little with the breath
  d = smin(d, sdRoundBox(q - vec3(-0.14, 0.24 - 0.012 * breath, 0.0), vec3(0.44, 0.13, 0.17), 0.09), 0.10);
  return d;
}

vec3 bustNormal(vec3 q, float breath) {
  const vec2 e = vec2(0.0015, -0.0015);
  return normalize(e.xyy * sdBust(q + e.xyy, breath) + e.yyx * sdBust(q + e.yyx, breath)
                 + e.yxy * sdBust(q + e.yxy, breath) + e.xxx * sdBust(q + e.xxx, breath));
}

mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }

// --------------------------------------------------------------------------- the fox

const vec3 FOX_HEAD_PIVOT = vec3(-0.14, -0.30, 0.0);

// Fox object space: origin at the chest, facing -x (towards the character), y DOWN,
// z towards the viewer. Returns distance; `headQ` receives the point in head space.
float sdFox(vec3 q, vec4 rig, out vec3 headQ) {
  // haunches at the bottom right, chest rising to the upper left
  float d = sdEllipsoid(q - vec3(0.13, 0.10, 0.0), vec3(0.17, 0.14, 0.13));
  d = smin(d, sdCapsule(q, vec3(0.07, 0.08, 0.0), vec3(-0.10, -0.19, 0.0), 0.105), 0.06);
  d = smin(d, sdEllipsoid(q - vec3(-0.11, -0.19, 0.0), vec3(0.12, 0.125, 0.105)), 0.06);
  // front legs
  d = smin(d, sdCapsule(q, vec3(-0.13, -0.08, 0.05), vec3(-0.17, 0.20, 0.05), 0.034), 0.03);
  d = smin(d, sdCapsule(q, vec3(-0.11, -0.08, -0.055), vec3(-0.15, 0.20, -0.055), 0.034), 0.03);
  // tail: around the front, bushy tip
  d = smin(d, sdCapsule(q, vec3(0.22, 0.17, 0.02), vec3(0.02, 0.26, 0.05), 0.065), 0.05);
  d = smin(d, sdCapsule(q, vec3(0.02, 0.26, 0.05), vec3(-0.20, 0.22, 0.07), 0.058), 0.05);
  d = smin(d, sdEllipsoid(q - vec3(-0.25, 0.19, 0.08), vec3(0.085, 0.06, 0.06)), 0.045);
  // head space: yaw (about y), pitch (about z), sniff = a push along the snout
  vec3 h = q - FOX_HEAD_PIVOT;
  h = rotZ(-rig.y) * rotY(-rig.x) * h;
  h.x += 0.022 * rig.z * (0.5 + 0.5 * sin(uTime * 19.0)) - 0.03 * rig.w;   // sniff nudges, retreat pulls back
  headQ = h;
  float hd = sdEllipsoid(h - vec3(-0.05, -0.07, 0.0), vec3(0.085, 0.078, 0.074));
  // snout: tapering to the nose
  hd = smin(hd, sdCapsule(h, vec3(-0.08, -0.045, 0.0), vec3(-0.20, -0.015, 0.0), 0.04), 0.03);
  hd = smin(hd, length(h - vec3(-0.225, -0.008, 0.0)) - 0.024, 0.02);
  // ears: tall leaves, slightly back, splayed to each side
  vec3 e1 = rotZ(0.25) * (h - vec3(-0.015, -0.17, 0.05));
  vec3 e2 = rotZ(0.25) * (h - vec3(-0.015, -0.17, -0.05));
  hd = smin(hd, sdEllipsoid(e1, vec3(0.03, 0.082, 0.016)), 0.02);
  hd = smin(hd, sdEllipsoid(e2, vec3(0.03, 0.082, 0.016)), 0.02);
  // cheek ruff
  hd = smin(hd, sdEllipsoid(h - vec3(0.0, -0.035, 0.0), vec3(0.085, 0.07, 0.085)), 0.04);
  return smin(d, hd, 0.045);
}

float sdFoxOnly(vec3 q, vec4 rig) { vec3 hq; return sdFox(q, rig, hq); }

vec3 foxNormal(vec3 q, vec4 rig) {
  const vec2 e = vec2(0.0015, -0.0015);
  return normalize(e.xyy * sdFoxOnly(q + e.xyy, rig) + e.yyx * sdFoxOnly(q + e.yyx, rig)
                 + e.yxy * sdFoxOnly(q + e.yxy, rig) + e.xxx * sdFoxOnly(q + e.xxx, rig));
}

// --------------------------------------------------------------------------- helpers

float foxEye(vec2 uv, vec2 c, vec2 gaze, float sharp) {
  vec2 d = uv - c - gaze * 0.0045 * sharp;
  d.x *= uAspect;
  float ca = cos(-0.55), sa = sin(-0.55);
  d = vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y);
  float w = mix(0.030, 0.038, sharp);
  float h = mix(0.0075, 0.0032, sharp);
  float qx = d.x / w, qy = d.y / h;
  return exp(-(qx * qx + qy * qy) * 2.0);
}

vec2 pointerPush(vec2 p) {
  vec2 push = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    vec4 tr = uTrail[i];
    if (tr.w <= 0.0) continue;
    vec2 tp = vec2(tr.x * uAspect, tr.y);
    vec2 d = p - tp;
    float r2 = dot(d, d);
    float fall = exp(-r2 * 90.0) * exp(-tr.z * 1.6) * tr.w;
    push += d * inversesqrt(r2 + 1e-4) * fall;
  }
  vec2 cp = vec2(uPointer.x * uAspect, uPointer.y);
  vec2 dc = p - cp;
  float fc = exp(-dot(dc, dc) * 70.0) * uPointerOn;
  push += (dc * inversesqrt(dot(dc, dc) + 1e-4) * 0.6 + vec2(uPointerVel.x * uAspect, uPointerVel.y) * 0.35) * fc;
  return push * 0.04;
}

// --------------------------------------------------------------------------- main

const vec2 PIVOT = vec2(0.50, 0.95);          // base of the neck, image uv
const vec3 CROWN_OBJ = vec3(-0.16, -0.66, 0.0); // where the hair is born, object space

void main() {
  vec2 suv = gl_FragCoord.xy / uResolution;
  suv.y = 1.0 - suv.y;
  vec2 iuv = suv * uCover.xy + uCover.zw;
  float t = uTime;
  vec2 p = vec2(iuv.x * uAspect, iuv.y);
  vec2 push = pointerPush(p);

  vec3 fld = texture2D(uFields, iuv).rgb;
  float figureRef = fld.r;
  float blueSoft = fld.b;

  // reveal wave: a single soft ripple leaving the centre of the screen
  vec2 sc = vec2(0.5, 0.5) * uCover.xy + uCover.zw;
  vec2 pc = vec2(sc.x * uAspect, sc.y);
  float rr = length(p - pc);
  float waveEnv = exp(-uWaveT * 1.1) * smoothstep(0.0, 0.3, uWaveT);
  vec2 disp = normalize(p - pc + 1e-5) * sin(rr * 26.0 - uWaveT * 7.0) * 0.006 * waveEnv;
  vec2 wuv = iuv + disp;
  vec2 pw = vec2(wuv.x * uAspect, wuv.y);

  vec3 base = texture2D(uBase, wuv).rgb;
  vec3 detail = texture2D(uDetail, wuv).rgb;
  vec3 msk = texture2D(uMask, wuv).rgb;
  float blue = msk.g, magma = msk.b;
  float pale = clamp(1.0 - blue - magma, 0.0, 1.0);

  // ---------------------------------------------------------------- the bust (ray march)
  // object space: translate by the bob, rotate by the glance (yaw) and a gentle nod
  vec2 bustUv = iuv - PIVOT - uBob;
  vec3 ro = vec3(bustUv.x * uAspect, bustUv.y, 1.2);
  vec3 rd = vec3(0.0, 0.0, -1.0);
  float yaw = -uHeadRig.x;                                // towards the viewer when positive
  float pitch = uHeadRig.y + 0.02 * uBreath;
  mat3 R = rotZ(pitch) * rotY(yaw);                      // object -> world (nod, then turn)
  mat3 Ri = rotY(-yaw) * rotZ(-pitch);                   // world -> object
  vec3 roO = Ri * ro;
  vec3 rdO = Ri * rd;
  float breath = uBreath;

  float hit = 0.0, tHit = 0.0, dMin = 1e3;
  vec3 qHit = vec3(0.0);
  float bound = sdEllipse2(vec2(bustUv.x * uAspect, bustUv.y), vec2(-0.04, -0.36), vec2(0.46, 0.66));
  dMin = max(bound, 0.0) + 0.01;
  if (bound < 0.02 && uReveal > 0.001) {
    float tt = 0.75;                                      // the model lives in z [-0.45, 0.45]
    for (int i = 0; i < uMarchSteps; i++) {
      vec3 q = roO + rdO * tt;
      float d = sdBust(q, breath);
      dMin = min(dMin, d);
      if (d < 0.0012) { hit = 1.0; tHit = tt; qHit = q; break; }
      tt += d * 0.92;
      if (tt > 1.75) break;
    }
  }
  float pxWorld = 1.0 / (uResolution.y);                 // one pixel in image-height units
  float coverage = hit > 0.5 ? 1.0 : 1.0 - smoothstep(0.0, 1.6 * pxWorld, dMin);
  // lines in the background wrap around the real silhouette (2D distance from the march)
  float figure = max(figureRef * 0.5, exp(-max(dMin, 0.0) * 9.0));

  // ---------------------------------------------------------------- contour lines (background)
  float lw = uLineWidth * (0.85 + 0.3 * fbm3(pw * 1.7 + 3.1));
  // phase gradient is ~uLineFreq per unit of p; one pixel is 1/res.y of a unit
  float aa = uLineFreq * 1.5 / uResolution.y * 2.2;
  float lineStat = 0.0;
  if (pale > 0.001) lineStat = lineCoverage(linePhase(pw, figure, 0.0, 0.0), lw, aa);
  float lineFlow = 0.0;
  if (magma > 0.001 || uReveal < 0.999) lineFlow = lineCoverage(linePhase(pw, figure, 1.0, t), lw, aa);

  // ---------------------------------------------------------------- 1. magma everywhere
  float heat = fbm3(pw * 1.3 + vec2(t * 0.025, -t * 0.04));
  float heat2 = fbm3(pw * 0.6 + vec2(-t * 0.012, t * 0.02) + 7.0);
  vec3 redFlat = vec3(0.847, 0.216, 0.114);
  vec3 redBase = mix(vec3(0.886, 0.227, 0.125), vec3(0.96, 0.42, 0.16), smoothstep(0.45, 0.9, heat) * 0.55);
  redBase = mix(redBase, vec3(0.70, 0.13, 0.08), smoothstep(0.55, 0.9, heat2) * 0.35);
  vec3 magmaCol = mix(redBase, base * (0.92 + 0.16 * smoothstep(0.45, 0.9, heat)), uReveal * (1.0 - pale) * (1.0 - blue));
  magmaCol = mix(magmaCol, magmaCol * 0.42, lineFlow * 0.62);

  vec3 col = magmaCol;
  if (uSpread < 2.5) {
    float edgeN = (fbm3(p * 1.7 + vec2(0.0, -t * 0.06)) - 0.5) * 1.6 + (fbm3(p * 5.0 + vec2(t * 0.1, 0.0) + 9.0) - 0.5) * 0.45;
    float dist = rr + edgeN * (0.08 + 0.30 * uSpread);
    float inside = 1.0 - smoothstep(uSpread - 0.015, uSpread + 0.015, dist);
    float lip = (1.0 - smoothstep(0.0, 0.05, abs(dist - uSpread))) * step(0.001, uSpread);
    col = mix(redFlat, magmaCol, inside);
    col += vec3(0.95, 0.45, 0.12) * lip * 0.35;
  }

  // ---------------------------------------------------------------- 2. background plates
  vec3 art = base;
  art = mix(art, detail, blue * 0.85);
  vec2 cardIn = smoothstep(uCardRect.xy - 0.01, uCardRect.xy + 0.01, wuv) * (1.0 - smoothstep(uCardRect.zw - 0.01, uCardRect.zw + 0.01, wuv));
  float underCard = cardIn.x * cardIn.y;
  art = mix(art, art * 0.6, lineStat * pale * 0.11);

  // fox glow (sharp, focused)
  float foxAttention = uFoxLook.z;
  float foxUpset = uFoxLook.w;
  float foxPulse = 0.5 + 0.5 * sin(uFoxPhase + 1.0);
  art *= 1.0 + blueSoft * blue * (0.06 + 0.10 * foxPulse + 0.08 * foxUpset);
  vec2 faceD = (wuv - vec2(0.64, 0.15)) * vec2(uAspect, 1.0);
  float faceNear = exp(-dot(faceD, faceD) * 14.0);
  art += vec3(0.42, 0.04, 0.16) * blue * foxUpset * faceNear * 0.2 * (0.6 + 0.4 * foxPulse);
  float foxEdge = clamp(length(vec2(dFdx(blue), dFdy(blue))) * 2.5, 0.0, 1.0) * (1.0 - underCard);
  if (foxEdge > 0.002) {
    float shimmer = fbm3(pw * 9.0 + vec2(t * 0.35, -t * 0.5));
    art += vec3(0.35, 0.75, 1.0) * foxEdge * (0.35 + 0.65 * shimmer) * (0.4 + 0.6 * foxUpset);
  }
  // ---- the fox itself: a ray-marched spirit inside the painted aura
  const vec2 FOX_PIVOT = vec2(0.67, 0.30);
  vec2 foxUv = iuv - FOX_PIVOT;
  const float FOX_SCALE = 0.55;
  vec3 fro = vec3(foxUv.x * uAspect / FOX_SCALE, foxUv.y / FOX_SCALE, 1.0);   // scale x/y only; depth stays
  float fhit = 0.0, fdMin = 1e3, ftHit = 0.0;
  vec3 fq = vec3(0.0), fhq = vec3(0.0);
  float fbound = sdEllipse2(vec2(foxUv.x * uAspect, foxUv.y), vec2(-0.03, -0.12) * FOX_SCALE, vec2(0.46, 0.52) * FOX_SCALE);
  fdMin = max(fbound, 0.0) + 0.01;
  if (fbound < 0.02 && uReveal > 0.001) {
    float tt = 0.75;
    for (int i = 0; i < uMarchSteps; i++) {
      vec3 qq = fro + vec3(0.0, 0.0, -1.0) * tt;
      vec3 hq;
      float d = sdFox(qq, uFoxRig, hq);
      fdMin = min(fdMin, d);
      if (d < 0.0012) { fhit = 1.0; ftHit = tt; fq = qq; fhq = hq; break; }
      tt += d * 0.92;
      if (tt > 1.65) break;
    }
  }
  if (fhit > 0.5 || fbound < 0.02) fdMin *= FOX_SCALE;
  float foxCov = fhit > 0.5 ? 1.0 : 1.0 - smoothstep(0.0, 1.6 / uResolution.y, fdMin);
  float sharp = max(foxAttention, foxUpset);
  if (foxCov > 0.001) {
    vec3 n = foxNormal(fq, uFoxRig);
    vec3 V = vec3(0.0, 0.0, 1.0);
    float fres = pow(1.0 - max(dot(n, V), 0.0), 2.2);
    vec3 Lk = normalize(vec3(-0.5, -0.8, 0.6));
    float kd = max(dot(n, Lk), 0.0);
    // a spirit: deep blue body, light pouring through the thin edges, a cyan rim that sharpens
    vec3 c = vec3(0.07, 0.14, 0.78) * (0.35 + 0.65 * kd);
    c += vec3(0.25, 0.65, 1.0) * fres * (0.9 + 0.5 * foxPulse);
    c += vec3(0.55, 0.95, 1.0) * pow(fres, 4.0) * 1.2;
    c = mix(c, vec3(0.9, 0.25, 0.45), foxUpset * fres * 0.6);          // flushes red at the edges
    // eyes: slanted slits on the head, in head space (they turn with it)
    vec2 eL = (fhq.xy - vec2(-0.105, -0.095)) * vec2(1.0, 2.6);
    float eyeS = exp(-dot(eL, eL) * 520.0) * step(0.028, abs(fhq.z));
    vec3 eyeCol = mix(vec3(0.6, 0.95, 1.0), vec3(1.0, 0.3, 0.42), foxUpset * 0.8);
    c += eyeCol * eyeS * (0.5 + 1.4 * sharp);
    // nose
    c = mix(c, vec3(0.02, 0.03, 0.12), smoothstep(0.03, 0.02, length(fhq - vec3(-0.225, -0.008, 0.0))));
    art = mix(art, c, foxCov);
  }
  // aura glow hugging the silhouette
  art += vec3(0.3, 0.7, 1.0) * exp(-max(fdMin, 0.0) * 18.0) * (1.0 - foxCov) * 0.45 * (0.7 + 0.3 * foxPulse);

  // ---------------------------------------------------------------- 3. the bust, shaded
  vec3 bustCol = vec3(0.0);
  if (coverage > 0.001) {
    vec3 q = qHit;
    vec3 nO = bustNormal(q, breath);
    vec3 n = R * nO;                                     // world-space normal (y down, z out)
    vec3 V = vec3(0.0, 0.0, 1.0);
    // lights: wandering key, cool fill from the fox (above right), hot rim from the magma (behind)
    vec3 Lkey = normalize(vec3(cos(uLightAngle) * 0.8, sin(uLightAngle) * 0.6 - 0.3, 0.85));
    vec3 Lfox = normalize(vec3(0.35, -1.0, 0.45));
    vec3 Lmag = normalize(vec3(-1.0, 0.25, -0.15));
    float kd = max(dot(n, Lkey), 0.0);
    float kf = max(dot(n, Lfox), 0.0);
    float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    float rim = fres * (0.5 + 0.5 * max(dot(n, Lmag), 0.0));
    // cheap ambient occlusion from the field itself
    float ao = clamp(0.35 + 1.4 * sdBust(q + nO * 0.09, breath) / 0.09, 0.0, 1.0);
    // the art's navy, with contour lines that follow the form (object space, so they turn with him)
    vec3 navy = vec3(0.075, 0.095, 0.33);
    float grain = noise3(q * 6.0 + 2.0);
    float phiB = (q.x * 0.5 + q.y * 0.9 + nO.z * 0.35) * uLineFreq * 0.8 + (grain - 0.5) * 6.0;
    float aaB = fwidth(phiB) * 2.2;
    float lineB = lineCoverage(phiB, lw * 1.05, aaB);
    vec3 albedo = mix(navy, navy * 0.42, lineB * 0.9);
    vec3 c = albedo * (0.30 + 0.70 * kd) * ao;
    c += vec3(0.25, 0.55, 1.0) * kf * 0.18 * ao;                       // fox fill
    vec3 hot = vec3(1.0, 0.52, 0.16);
    float heatHere = smoothstep(0.3, 0.9, fbm3(q.xy * 1.5 + vec2(t * 0.05, -t * 0.08)));
    c += hot * rim * (0.35 + 0.65 * uFlare) * (0.5 + 0.5 * heatHere) * 0.9;  // magma rim
    // specular: a hard blue-white glint from the key light, an orange one from the magma
    vec3 Hk = normalize(Lkey + V);
    c += vec3(0.6, 0.8, 1.0) * pow(max(dot(n, Hk), 0.0), 48.0) * 0.35;
    vec3 Hm = normalize(normalize(vec3(-0.6, 0.4, 0.7)) + V);
    c += hot * pow(max(dot(n, Hm), 0.0), 24.0) * 0.5 * (0.4 + 0.6 * uFlare);
    // etched edge
    c += vec3(0.3, 0.6, 1.0) * fres * 0.10;
    bustCol = c;
    if (uDebug > 0.5 && uDebug < 1.5) bustCol = vec3(0.2) + vec3(0.8) * kd + vec3(0.0, 0.0, 0.3) * lineB;
  }

  // ---------------------------------------------------------------- 4. volumetric hair
  vec3 hairCol = vec3(0.0);
  float hairA = 0.0;
  // hair bounding box in world (bust) space, generous: above and behind the crown
  bool inHair = bustUv.x * uAspect > -1.15 && bustUv.x * uAspect < 0.30 && bustUv.y > -1.55 && bustUv.y < -0.35;
  if (inHair && uReveal > 0.001 && uFlameAmount > 0.001) {
    vec3 up = normalize(vec3(-0.62, -1.0, 0.0));       // blown back: up and towards -x
    vec3 side = vec3(up.y, -up.x, 0.0);
    float zStart = 0.55, zEnd = -0.45;
    float dz = (zStart - zEnd) / float(uHairSteps);
    vec3 col3 = vec3(0.0);
    float acc = 0.0;
    for (int i = 0; i < uHairSteps; i++) {
      float z = zStart - (float(i) + 0.5) * dz;
      if (hit > 0.5 && z < roO.z + rdO.z * tHit) break;  // behind the head surface
      vec3 w = vec3(ro.xy, z);
      vec3 qo = Ri * w;                                  // object space: the hair turns with him
      vec3 rel = qo - CROWN_OBJ;
      rel.xy -= push * 1.5;
      float along = dot(rel, up);
      float across = dot(rel, side);
      float depth = rel.z;
      float halfW = 0.11 + 0.6 * max(along, 0.0);
      float halfD = 0.20 + 0.35 * max(along, 0.0);
      float env = smoothstep(-0.10, 0.05, along) * exp(-max(along, 0.0) * 1.2)
                * exp(-(across * across) / (halfW * halfW)) * exp(-(depth * depth) / (halfD * halfD));
      if (env < 0.004) continue;
      // tongues: the noise shapes them everywhere, the envelope only scales how many survive
      // tongues: noise stretched along the flow, a solid base at the crown, thinning outwards
      float n = fbm4(vec2(across * 13.0 + depth * 0.8, along * 4.0 - t * 0.75))
              + 0.18 * (fbm3(vec2(across * 26.0, along * 9.0 - t * 1.3) + 3.0) - 0.5);
      float base = smoothstep(0.32, 0.0, max(along, 0.0)) * env;
      float shape = n * (0.7 + 0.5 * env) + 0.22 * base - 0.22 * max(along, 0.0);
      float dens = smoothstep(0.50, 0.62, shape) * env * uFlameAmount;
      float core = smoothstep(0.68, 0.86, shape) * env;
      vec3 fc = mix(vec3(0.06, 0.16, 1.0), vec3(0.7, 0.98, 1.0), core);
      float fringe = smoothstep(0.0, 0.25, dens) * (1.0 - smoothstep(0.25, 0.6, dens));
      fc = mix(fc, vec3(1.0, 0.38, 0.55), fringe * 0.7);
      fc = mix(fc, vec3(1.0, 0.8, 0.25), fringe * (0.5 + 0.5 * sin(along * 22.0 - t * 0.8)) * 0.4);
      float a = dens * dz * 17.0;
      col3 += fc * a * (1.0 - acc);
      acc += a * (1.0 - acc);
    }
    hairCol = col3;
    hairA = clamp(acc, 0.0, 1.0);
  }

  // ---------------------------------------------------------------- composite
  float artMask = (1.0 - magma) * uReveal;
  col = mix(col, art, artMask);
  col = mix(col, bustCol, coverage * uReveal);
  col = col * (1.0 - hairA * 0.9 * uReveal) + hairCol * uReveal * 1.25;
  col += vec3(0.12, 0.04, 0.0) * pale * smoothstep(0.35, 0.9, heat) * figure * uReveal * 0.5;

  // ---------------------------------------------------------------- finishing
  float vig = 1.0 - 0.16 * smoothstep(0.45, 1.35, length((suv - 0.5) * vec2(1.25, 1.0)) * 1.55);
  col *= vig;
  col += (hash1(gl_FragCoord.xy + fract(t) * 17.0) - 0.5) * uGrain;

  if (uDebug > 1.5 && uDebug < 2.5) col = vec3(coverage, blue, magma);
  else if (uDebug > 2.5 && uDebug < 3.5) col = vec3(1.0 - lineFlow * magma - lineStat * (1.0 - magma));
  else if (uDebug > 3.5) col = vec3(hairA);
  else if (uDebug > 0.5 && uDebug < 1.5) col = mix(vec3(0.85), bustCol, coverage);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
