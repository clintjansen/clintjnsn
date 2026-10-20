// JNSN — the whole page is this one fragment shader.
//
// Coordinate conventions
//   suv : screen uv, y DOWN (0,0 top-left)
//   iuv : image uv,  y DOWN, matches the prepared textures (flipY = false)
//   p   : aspect-corrected image coordinates (x in [0, aspect], y in [0, 1]) — isotropic noise space
//
// Layers (back to front)
//   1. procedural magma: flat red -> organic spread (loader) -> red with flowing contour lines
//   2. the artwork colour base (person, fox, pale area) with static procedural contour lines
//   3. fox glow, procedural hair flames (pointer-aware), character lighting (rim, shine, light band)
//   4. vignette + a whisper of grain

// (three.js prepends #version 300 es, precision and the gl_FragColor/texture2D shims)

uniform sampler2D uBase;     // RGB colour base, lines removed, card inpainted
uniform sampler2D uDetail;   // RGB original colours, card inpainted (sharp fox, shine streaks)
uniform sampler2D uMask;     // R person, G blue (fox + hair), B magma; pale = 1 - R - G - B
uniform sampler2D uFields;   // R figure field (wide), G person soft (saturated), B blue soft
uniform sampler2D uExtra;    // R hair region, G shine, B baked lines (0.5 = flat)
uniform sampler2D uNoise;    // tiling 4-channel noise (see src/noise.js)

uniform vec2  uResolution;   // render target size (px)
uniform float uTime;         // seconds (only advances while rendering)
uniform vec4  uCover;        // iuv = suv * uCover.xy + uCover.zw
uniform float uAspect;       // image width / height
uniform float uLineFreq;     // contour-line periods per image height
uniform float uCoverScale;   // image px -> screen px factor (for pixel-sized effects)

uniform float uSpread;       // loader magma radius in aspect units (0 = none, big = everywhere)
uniform float uReveal;       // artwork fade-in 0..1
uniform float uWaveT;        // seconds since the reveal wave started (large = no wave)

uniform float uTurn;         // head glance 0..1
uniform float uBreath;       // -1..1
uniform vec2  uBob;          // image-uv offset of the character
uniform float uLightAngle;   // radians, wandering light direction
uniform float uFlare;        // 0..1 slow random flare of the hot light
uniform vec2  uCrown;        // flame origin (image uv)
uniform float uHairSplit;    // image u where the hair ends and the fox begins
uniform vec4  uCardRect;     // glass card in image uv (x0, y0, x1, y1): no line/edge effects under it
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
uniform float uBakedMix;     // baked (original) line texture on the character, 0..1
uniform float uFlameAmount;  // procedural flames, 0..1+
uniform float uGrain;        // 0..0.1
uniform float uDebug;        // 0 off, 1 flame field, 2 masks, 3 lines only

// --------------------------------------------------------------------------- noise
// fbm from a tiling noise texture (src/noise.js): each channel holds 2 octaves of periodic
// gradient noise in [0,1], 8 cells per texture, so p / 8 keeps one cell = one unit of p.

float hash1(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

const mat2 ROT = mat2(0.80, 0.60, -0.60, 0.80);

// one 2-octave noise channel in [-1, 1]
float ntex(vec2 p, vec4 sel) {
  return dot(texture2D(uNoise, p * 0.125), sel) * 2.0 - 1.0;
}

// fbm in ~[0, 1]: two fetches = four octaves
float fbm3(vec2 p) {
  float v = ntex(p, vec4(1.0, 0.0, 0.0, 0.0)) * 0.62 + ntex(ROT * p * 4.1 + 7.3, vec4(0.0, 1.0, 0.0, 0.0)) * 0.16;
  return v * 0.62 + 0.5;
}
// fbm in ~[0, 1]: three fetches = six octaves (a little more detail, still well sampled)
float fbm4(vec2 p) {
  float v = ntex(p, vec4(1.0, 0.0, 0.0, 0.0)) * 0.62
          + ntex(ROT * p * 2.3 + 5.1, vec4(0.0, 0.0, 1.0, 0.0)) * 0.24
          + ntex(ROT * ROT * p * 4.1 + 7.3, vec4(0.0, 0.0, 0.0, 1.0)) * 0.11;
  return v * 0.6 + 0.5;
}

// --------------------------------------------------------------------------- contour lines

// Phase field whose integer levels are the dark lines. `flow` = 0 static, 1 magma.
// All time dependence inside the warp is bounded (noise of time), so static and flowing
// regions never shear apart; the only unbounded term is the uniform drift in the magma.
float linePhase(vec2 p, float figure, float flow, float t) {
  vec2 q = p * 2.4;
  vec2 w = vec2(fbm3(q + vec2(0.0, t * uWarpSpeed * flow)),
                fbm3(q + vec2(5.2, 1.3) + vec2(-t * uWarpSpeed * 0.7 * flow, t * uWarpSpeed * 0.3 * flow)));
  vec2 pw = p + (w - 0.5) * 0.32;
  float n = fbm4(pw * 3.6 + vec2(t * 0.013 * flow, 0.0));
  float phi = (pw.x * 0.62 + pw.y * 0.78) * uLineFreq      // base stripe direction
            + (n - 0.5) * 7.5                               // organic wiggle
            + figure * 13.0                                 // lines wrap around the figure
            + t * uFlowSpeed * flow;                        // slow drift (magma only)
  return phi;
}

// Anti-aliased dark line coverage 0..1 for a phase field; `aa` is the derivative-based
// softness, computed once in uniform control flow (fwidth may not be used inside branches).
float lineCoverage(float phi, float width, float aa) {
  float d = abs(fract(phi) - 0.5) * 2.0;          // 0 on the line centre, 1 mid-gap
  float w = width * 2.0;
  return 1.0 - smoothstep(w - aa, w + aa, d);
}

// --------------------------------------------------------------------------- helpers

float ellipseFalloff(vec2 p, vec2 c, vec2 r, float inner) {
  vec2 d = (p - c) / r;
  return 1.0 - smoothstep(inner, 1.0, length(d));
}

// A slanted glint: the fox's eye. Narrower and brighter the sharper it looks.
float foxEye(vec2 uv, vec2 c, vec2 gaze, float sharp) {
  vec2 d = uv - c - gaze * 0.0045 * sharp;       // the glint slides towards the hand
  d.x *= uAspect;
  float ca = cos(-0.55), sa = sin(-0.55);
  d = vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y);
  float w = mix(0.030, 0.038, sharp);
  float h = mix(0.0075, 0.0032, sharp);
  float qx = d.x / w, qy = d.y / h;
  return exp(-(qx * qx + qy * qy) * 2.0);
}

vec2 pointerPush(vec2 p) {
  // Summed repulsion from the recent pointer trail: flames lean away from the hand.
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
  // The live pointer carries its velocity as a gust.
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

  // -- fields drive the warp (sampled unwarped)
  vec3 fld = texture2D(uFields, iuv).rgb;
  float figure = fld.r;
  float personSoft = fld.g;
  float blueSoft = fld.b;
  vec3 xtr0 = texture2D(uExtra, iuv).rgb;
  // burning fades out well before the split so the still fox never shows a seam
  float hairSoft = smoothstep(0.0, 1.0, xtr0.r * 1.15) * (1.0 - smoothstep(uHairSplit - 0.14, uHairSplit + 0.01, iuv.x));

  vec2 p = vec2(iuv.x * uAspect, iuv.y);
  vec2 push = pointerPush(p);

  // -- character motion: breathe, bob, glance — all as a smooth displacement field
  vec2 disp = uBob * personSoft;
  disp.y += -0.0032 * uBreath * smoothstep(0.55, 0.95, iuv.y) * personSoft;
  vec2 headC = vec2(0.50, 0.56);
  float headW = ellipseFalloff(iuv, headC, vec2(0.30, 0.42), 0.5) * personSoft;
  // sampling further out pulls the silhouette inwards: the nose recedes, the head narrows
  disp.x += uTurn * headW * 0.024 * clamp((iuv.x - headC.x) / 0.18, -1.0, 1.0);
  disp.y += uTurn * headW * 0.004;
  // reveal wave: a single soft ripple leaving the centre of the screen
  vec2 sc = vec2(0.5, 0.5) * uCover.xy + uCover.zw;
  vec2 pc = vec2(sc.x * uAspect, sc.y);
  float rr = length(p - pc);
  float waveEnv = exp(-uWaveT * 1.1) * smoothstep(0.0, 0.3, uWaveT);
  disp += normalize(p - pc + 1e-5) * sin(rr * 26.0 - uWaveT * 7.0) * 0.006 * waveEnv;
  // the whole hair ripples like a slow fire: a drifting low-frequency warp of the baked blue
  if (hairSoft > 0.01) {
    vec2 hairFlow = vec2(fbm3(p * 3.0 + vec2(-t * 0.12, -t * 0.22)) - 0.5,
                         fbm3(p * 3.0 + vec2(4.0, 2.0) + vec2(-t * 0.10, -t * 0.26)) - 0.5);
    disp += hairFlow * 0.024 * hairSoft;
  }
  // hair bends with the pointer
  disp -= push * hairSoft * 0.28;

  vec2 wuv = iuv + disp;
  vec2 pw = vec2(wuv.x * uAspect, wuv.y);

  // -- samples at the warped position
  vec3 base = texture2D(uBase, wuv).rgb;
  vec3 detail = texture2D(uDetail, wuv).rgb;
  vec3 msk = texture2D(uMask, wuv).rgb;
  float person = msk.r, blue = msk.g, magma = msk.b;
  float pale = clamp(1.0 - person - blue - magma, 0.0, 1.0);
  vec3 xtr = texture2D(uExtra, wuv).rgb;
  float hair = xtr.r, shine = xtr.g, baked = (xtr.b - 0.5) * 2.0;

  // -- contour lines: a flowing field for the magma, a static one for the artwork
  float lw = uLineWidth * (0.85 + 0.3 * fbm3(pw * 1.7 + 3.1));
  float phiStat = linePhase(pw + vec2(uTurn * headW * 0.025, 0.0), figure, 0.0, 0.0);
  float aa = fwidth(phiStat) * 2.2;               // both fields share scale: one derivative
  float lineStat = lineCoverage(phiStat, lw, aa);
  // the flowing field only shows through where magma is (or until the reveal is done)
  float lineFlow = 0.0;
  if (magma > 0.001 || uReveal < 0.999) {
    lineFlow = lineCoverage(linePhase(pw, figure, 1.0, t), lw, aa);
  }

  // -- 1. magma everywhere (what the loader reveals)
  float heat = fbm3(pw * 1.3 + vec2(t * 0.025, -t * 0.04));
  float heat2 = fbm3(pw * 0.6 + vec2(-t * 0.012, t * 0.02) + 7.0);
  vec3 redFlat = vec3(0.847, 0.216, 0.114);
  vec3 redBase = mix(vec3(0.886, 0.227, 0.125), vec3(0.96, 0.42, 0.16), smoothstep(0.45, 0.9, heat) * 0.55);
  redBase = mix(redBase, vec3(0.70, 0.13, 0.08), smoothstep(0.55, 0.9, heat2) * 0.35);
  // after the reveal the magma takes the artwork's own red gradients
  vec3 magmaCol = mix(redBase, base * (0.92 + 0.16 * smoothstep(0.45, 0.9, heat)), uReveal * (1.0 - pale) * (1.0 - blue));
  magmaCol = mix(magmaCol, magmaCol * 0.42, lineFlow * 0.62);

  // loader: organic spread from the screen centre, with a bright lava lip at the front
  vec3 col = magmaCol;
  if (uSpread < 2.5) {
    float edgeN = (fbm3(p * 1.7 + vec2(0.0, -t * 0.06)) - 0.5) * 1.6 + (fbm3(p * 5.0 + vec2(t * 0.1, 0.0) + 9.0) - 0.5) * 0.45;
    float dist = rr + edgeN * (0.08 + 0.30 * uSpread);
    float inside = 1.0 - smoothstep(uSpread - 0.015, uSpread + 0.015, dist);
    float lip = (1.0 - smoothstep(0.0, 0.05, abs(dist - uSpread))) * step(0.001, uSpread);
    col = mix(redFlat, magmaCol, inside);
    col += vec3(0.95, 0.45, 0.12) * lip * 0.35;
  }

  // -- 2. the artwork
  vec3 art = base;
  // the fox keeps its sharp original detail; the shine streaks too
  art = mix(art, detail, blue * 0.85);
  art = mix(art, detail, shine * 0.9);
  // nothing textured under the glass card: its inpainted membrane has artificial region edges
  vec2 cardIn = smoothstep(uCardRect.xy - 0.01, uCardRect.xy + 0.01, wuv) * (1.0 - smoothstep(uCardRect.zw - 0.01, uCardRect.zw + 0.01, wuv));
  float underCard = cardIn.x * cardIn.y;
  // static contour lines per region
  float lineStrength = (person * 0.34 + pale * 0.11) * (1.0 - underCard);
  float lineV = lineStat;
  lineV = mix(lineV, clamp(lineV + max(-baked, 0.0) * 1.5, 0.0, 1.0), uBakedMix * person);
  art = mix(art, art * mix(0.35, 0.6, pale), lineV * lineStrength);

  // -- 3. fox glow (sharp, focused) — a slow breath of light and a shimmering rim
  float foxAttention = uFoxLook.z;
  float foxUpset = uFoxLook.w;
  float foxPulse = 0.5 + 0.5 * sin(uFoxPhase + 1.0);
  art *= 1.0 + blueSoft * blue * (0.06 + 0.10 * foxPulse + 0.08 * foxUpset);
  // a faint flush of red around the face when the hand gets too close
  vec2 faceD = (wuv - vec2(0.64, 0.15)) * vec2(uAspect, 1.0);
  float faceNear = exp(-dot(faceD, faceD) * 14.0);
  art += vec3(0.42, 0.04, 0.16) * blue * (1.0 - hairSoft) * foxUpset * faceNear * 0.2 * (0.6 + 0.4 * foxPulse);
  float foxEdge = clamp(length(vec2(dFdx(blue), dFdy(blue))) * 2.5, 0.0, 1.0) * (1.0 - hairSoft) * (1.0 - personSoft) * (1.0 - underCard);
  if (foxEdge > 0.002) {
    float shimmer = fbm3(pw * 9.0 + vec2(t * 0.35, -t * 0.5));
    art += vec3(0.35, 0.75, 1.0) * foxEdge * (0.35 + 0.65 * shimmer) * (0.4 + 0.6 * foxUpset);
  }
  // the eyes: barely-there glints that sharpen and snap to the hand when the fox is watching
  float sharp = max(foxAttention, foxUpset);
  float eyes = foxEye(wuv, vec2(0.612, 0.168), uFoxLook.xy, sharp) + foxEye(wuv, vec2(0.668, 0.128), uFoxLook.xy, sharp);
  vec3 eyeCol = mix(vec3(0.55, 0.92, 1.0), vec3(1.0, 0.30, 0.42), foxUpset * 0.8);
  art += eyeCol * eyes * (0.18 + 0.82 * sharp) * uReveal * (1.0 - underCard);

  // -- character lighting
  vec2 L = vec2(cos(uLightAngle), sin(uLightAngle));
  // thin bright edge from the mask, soft glow band from the wide person field
  vec2 g = vec2(dFdx(person), dFdy(person));
  float gl = length(g);
  float rimThin = gl > 1e-5 ? max(0.0, dot(-g / gl, L)) * clamp(gl * 2.0, 0.0, 1.0) : 0.0;
  vec2 g2 = vec2(dFdx(personSoft), dFdy(personSoft));
  float gl2 = length(g2);
  float rimBand = personSoft * (1.0 - personSoft) * 4.0;
  float rimSoft = gl2 > 1e-6 ? max(0.0, dot(-g2 / gl2, L)) * rimBand : 0.0;
  float heatNear = smoothstep(0.35, 0.9, heat);
  vec3 hot = vec3(1.0, 0.55, 0.18);
  float rimLight = (0.35 + 0.65 * uFlare) * (0.45 + 0.55 * heatNear) * (1.0 - underCard);
  art += hot * rimThin * rimLight * 0.9;
  art += hot * rimSoft * rimLight * 0.45 * (person * 0.6 + 0.4);
  // soft inner warmth where the magma is hot next to him
  float innerGlow = personSoft * (1.0 - person) * heatNear * 0.18 * uFlare;
  art += hot * innerGlow;
  // shine streaks flicker with the hot surroundings
  float flick = 0.75 + 0.35 * sin(t * 1.9 + heat * 6.0) * uFlare + 0.3 * heatNear;
  art += detail * shine * (flick - 0.6) * 0.8;
  // a slow band of light travelling over the face, brighter at the front during a glance
  float bandPos = 0.35 + 0.45 * (0.5 + 0.5 * sin(t * 0.21 + 0.8)) + uTurn * 0.15;
  float bd = (dot(pw, vec2(0.7, 0.71)) - bandPos * (uAspect * 0.7 + 0.71)) / 0.07;
  float band = exp(-bd * bd);  // never pow() with a negative base: spec-undefined
  art += vec3(0.30, 0.38, 0.95) * band * person * (0.10 + 0.08 * uTurn);
  art += vec3(0.22, 0.28, 0.75) * headW * person * uTurn * 0.10;

  // -- procedural hair flames (blown back: up and to the left)
  vec2 crown = vec2(uCrown.x * uAspect, uCrown.y);
  vec2 fp = pw - crown - push * 1.6;
  vec2 up = normalize(vec2(-0.85, -0.85));
  vec2 side = vec2(up.y, -up.x);
  float along = dot(fp, up);
  float halfWidth = 0.14 + 0.55 * max(along, 0.0);
  float lateral0 = dot(fp, side) / halfWidth;
  // Envelope: the whole hair region burns, plus tongues licking out from the crown.
  float crownEnv = smoothstep(-0.10, 0.05, along) * exp(-max(along, 0.0) * 2.2) * exp(-lateral0 * lateral0);
  float env = max(hairSoft, crownEnv * 0.8);
  float flame = 0.0, core = 0.0, fn0 = 0.5;
  if (env > 0.01 && uFlameAmount * uReveal > 0.001) {
    float sway = (fbm3(vec2(along * 1.5, t * 0.09) + 3.0) - 0.5) * 0.35 * max(along, 0.0);
    float across = dot(fp, side) + sway;
    // Flame field: noise scrolling away from the crown (up and back); tongues form where
    // the noise peaks, thinning slightly with distance from the crown.
    vec2 fuv = vec2(across * 5.5, along * 3.6 - t * 0.38);
    vec2 fw = vec2(fbm3(fuv * 0.55 + vec2(0.0, -t * 0.06)), fbm3(fuv * 0.55 + vec2(4.1, 2.2) + vec2(t * 0.04, 0.0)));
    float fn = fbm4(fuv + (fw - 0.5) * 1.4) + 0.25 * fbm3(fuv * 2.3 + vec2(0.0, -t * 0.3));
    fn0 = fn;
    float f = (fn - 0.5) * 3.2 + 0.36 * env - 0.12 - max(along, 0.0) * 0.3;
    f *= smoothstep(-0.10, 0.05, along);
    flame = smoothstep(0.0, 0.3, f) * env * uFlameAmount * uReveal;
    core = smoothstep(0.42, 0.95, f) * env * uFlameAmount * uReveal;
  }
  vec3 flameCol = mix(vec3(0.10, 0.22, 0.98), vec3(0.42, 0.82, 1.0), core);
  float fringe = smoothstep(0.0, 0.3, flame) * (1.0 - smoothstep(0.3, 0.7, flame));
  float warm = 0.5 + 0.5 * sin(along * 24.0 - t * 0.7 + fn0 * 6.0);
  flameCol = mix(flameCol, vec3(1.0, 0.38, 0.55), fringe * 0.6);
  flameCol = mix(flameCol, vec3(1.0, 0.80, 0.25), fringe * warm * 0.45);
  art = mix(art, flameCol, clamp(flame, 0.0, 1.0) * 0.85);
  art += flameCol * core * 0.22;

  // -- composite the artwork over the magma
  float artMask = (1.0 - magma) * uReveal;
  col = mix(col, art, artMask);
  // a touch of the magma's heat reflects on the pale area's edge
  col += vec3(0.12, 0.04, 0.0) * pale * heatNear * figure * uReveal * 0.5;

  // -- 4. finishing
  float vig = 1.0 - 0.16 * smoothstep(0.45, 1.35, length((suv - 0.5) * vec2(1.25, 1.0)) * 1.55);
  col *= vig;
  col += (hash1(gl_FragCoord.xy + fract(t) * 17.0) - 0.5) * uGrain;

  if (uDebug > 0.5) {
    if (uDebug < 1.5) col = vec3(flame, core, hairSoft * 0.5);
    else if (uDebug < 2.5) col = vec3(person, blue, magma);
    else col = vec3(1.0 - lineFlow * magma - lineStat * (1.0 - magma));
  }
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
