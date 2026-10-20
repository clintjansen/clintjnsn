// JNSN — the whole page is this one fragment shader.
//
// Coordinate conventions
//   suv : screen uv, y DOWN (0,0 top-left)
//   iuv : image uv,  y DOWN, matches the prepared plates (flipY = false)
//   p   : aspect-corrected image coordinates (x in [0, aspect], y in [0, 1]) — isotropic
//   bust space: p relative to the neck pivot, z towards the viewer (orthographic camera)
//
// Layers (back to front) — this shader is the BACKDROP only:
//   1. procedural magma: flat red -> organic spread (loader) -> red with flowing contour lines
//   2. the background plates (pale area) with static contour lines; the fox (parked: uFoxOn)
//   3. vignette, grain
// The avatar (skinned 3D mesh, src/avatar/) and its fire (3D fluid sim, src/fire/) are drawn
// over this by scene.js with the same orthographic camera.

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
uniform sampler2D uFigure;   // soft field around the avatar's outline (lava lines wrap around it)
uniform float uFoxOn;        // 1 = draw the fox spirit (parked while the avatar is rebuilt)
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


void main() {
  vec2 suv = gl_FragCoord.xy / uResolution;
  suv.y = 1.0 - suv.y;
  vec2 iuv = suv * uCover.xy + uCover.zw;
  float t = uTime;
  vec2 p = vec2(iuv.x * uAspect, iuv.y);

  vec3 fld = texture2D(uFields, iuv).rgb;
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
  // lines in the background wrap around the avatar's outline
  float figure = texture2D(uFigure, iuv).r;

  // ---------------------------------------------------------------- contour lines (background)
  float lw = uLineWidth * (0.85 + 0.3 * fbm3(pw * 1.7 + 3.1));
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
  art = mix(art, art * 0.6, lineStat * pale * 0.11);

  // ---- the fox spirit (parked while the avatar is rebuilt; uFoxOn = 1 brings it back). It is
  // composited over the finished backdrop below: the plates mark its area as lava now.
  vec3 foxC = vec3(0.0);
  float foxCovOut = 0.0;
  vec3 foxGlow = vec3(0.0);
  if (uFoxOn > 0.5) {
    float foxAttention = uFoxLook.z;
    float foxUpset = uFoxLook.w;
    float foxPulse = 0.5 + 0.5 * sin(uFoxPhase + 1.0);
    const vec2 FOX_PIVOT = vec2(0.67, 0.30);
    vec2 foxUv = iuv - FOX_PIVOT;
    const float FOX_SCALE = 0.55;
    vec3 fro = vec3(foxUv.x * uAspect / FOX_SCALE, foxUv.y / FOX_SCALE, 1.0);
    float fhit = 0.0, fdMin = 1e3;
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
        if (d < 0.0012) { fhit = 1.0; fq = qq; fhq = hq; break; }
        tt += d * 0.92;
        if (tt > 1.65) break;
      }
    }
    if (fhit > 0.5 || fbound < 0.02) fdMin *= FOX_SCALE;
    float foxCov = fhit > 0.5 ? 1.0 : 1.0 - smoothstep(0.0, 1.6 / uResolution.y, fdMin);
    float sharp = max(foxAttention, foxUpset);
    if (foxCov > 0.001) {
      vec3 n = foxNormal(fq, uFoxRig);
      float fres = pow(1.0 - max(n.z, 0.0), 2.2);
      float kd = max(dot(n, normalize(vec3(-0.5, -0.8, 0.6))), 0.0);
      vec3 c = vec3(0.07, 0.14, 0.78) * (0.35 + 0.65 * kd);
      c += vec3(0.25, 0.65, 1.0) * fres * (0.9 + 0.5 * foxPulse);
      c += vec3(0.55, 0.95, 1.0) * pow(fres, 4.0) * 1.2;
      c = mix(c, vec3(0.9, 0.25, 0.45), foxUpset * fres * 0.6);
      vec2 eL = (fhq.xy - vec2(-0.105, -0.095)) * vec2(1.0, 2.6);
      float eyeS = exp(-dot(eL, eL) * 520.0) * step(0.028, abs(fhq.z));
      c += mix(vec3(0.6, 0.95, 1.0), vec3(1.0, 0.3, 0.42), foxUpset * 0.8) * eyeS * (0.5 + 1.4 * sharp);
      c = mix(c, vec3(0.02, 0.03, 0.12), smoothstep(0.03, 0.02, length(fhq - vec3(-0.225, -0.008, 0.0))));
      foxC = c;
      foxCovOut = foxCov;
    }
    foxGlow = vec3(0.3, 0.7, 1.0) * exp(-max(fdMin, 0.0) * 18.0) * (1.0 - foxCov) * 0.45 * (0.7 + 0.3 * foxPulse);
  }

  // ---------------------------------------------------------------- composite
  float artMask = (1.0 - magma) * uReveal;
  col = mix(col, art, artMask);
  col = mix(col, foxC, foxCovOut * uReveal) + foxGlow * uReveal;
  col += vec3(0.12, 0.04, 0.0) * pale * smoothstep(0.35, 0.9, heat) * figure * uReveal * 0.5;

  // ---------------------------------------------------------------- finishing
  float vig = 1.0 - 0.16 * smoothstep(0.45, 1.35, length((suv - 0.5) * vec2(1.25, 1.0)) * 1.55);
  col *= vig;
  col += (hash1(gl_FragCoord.xy + fract(t) * 17.0) - 0.5) * uGrain;

  if (uDebug > 1.5 && uDebug < 2.5) col = vec3(figure, blue, magma);
  else if (uDebug > 2.5 && uDebug < 3.5) col = vec3(1.0 - lineFlow * magma - lineStat * (1.0 - magma));
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
