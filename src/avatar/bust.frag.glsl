// The avatar's skin, in the painting's language (see tools/reference2.webp, face and neck):
//   - near-black navy covered in short, combed, slightly raised strokes, in patches that run
//     in different directions (like brushed fur / fingerprint ridges)
//   - a smooth, glossy ultramarine zone behind the neck where the lava throws hot glints
//   - lit from above by his own fire (blue, cyan-white where it burns close), rimmed by the lava
//
// World space: units = backdrop image heights, X right, Y up, Z towards the viewer.
// vObj is the REST-pose position: the strokes stay on the skin when he moves.

uniform sampler2D uNoise;     // tiling 4-channel noise (src/noise.js)
uniform float uTime;
uniform float uLineFreq;      // the backdrop's contour-line frequency (kept for reference)
uniform float uLineWidth;
uniform vec3  uKeyDir;        // wandering key light (world, normalised)
uniform float uFlare;         // 0..1 slow flicker of the hot light
uniform float uReveal;        // 0..1 teleport-in dissolve
uniform float uDebug;         // 1 = plain lambert (shape check)

varying vec3 vObj;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vObjN;

// The fire module's GLSL (float fireHeatAt(vec3)) is inserted at the next line when present.
// FIRE_SAMPLING

const mat2 ROT = mat2(0.80, 0.60, -0.60, 0.80);
float ntex(vec2 p, vec4 sel) { return dot(texture2D(uNoise, p * 0.125), sel) * 2.0 - 1.0; }
float fbm(vec2 p) {
  return (ntex(p, vec4(1.0, 0.0, 0.0, 0.0)) * 0.62 + ntex(ROT * p * 2.3 + 5.1, vec4(0.0, 0.0, 1.0, 0.0)) * 0.26) * 0.6 + 0.5;
}
float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }

// One layer of combed strokes running along `ang`. Returns (ridge 0..1, flank -1..1).
vec2 strokes(vec2 q, float ang, float seed) {
  const float SP = 150.0;                       // strokes per world unit (~ the painting's spacing)
  vec2 d = vec2(cos(ang), sin(ang));
  vec2 nn = vec2(-d.y, d.x);
  float ph = dot(q, nn) * SP + (fbm(q * 5.0 + seed) - 0.5) * 3.2;
  float lane = floor(ph);
  float f = fract(ph);
  float along = dot(q, d) * SP * 0.15 + hash1(lane + seed * 13.0) * 9.0;
  float da = fract(along);
  float dash = smoothstep(0.08, 0.30, da) * (1.0 - smoothstep(0.62, 0.86, da));
  float prof = sin(f * 3.14159);                // a rounded ridge across the stroke
  return vec2(prof * prof * dash, cos(f * 3.14159) * dash);
}

void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  const vec3 V = vec3(0.0, 0.0, 1.0);
  float t = uTime;

  // ---- teleport-in: a noisy dissolve front with a bright cyan edge
  float dn = fbm(vObj.xy * 5.0 + vObj.z * 3.0);
  float front = uReveal * 1.25 - 0.1;
  if (dn > front) discard;
  float edge = 1.0 - smoothstep(0.0, 0.06, front - dn);

  // ---- where the skin is combed and where it is smooth and glossy (behind the neck)
  vec2 q = vObj.xy;
  float smoothZone = smoothstep(0.10, -0.14, vObj.x - 0.54 + (vObj.y - 0.25) * 0.35) * smoothstep(0.10, -0.10, vObj.y - 0.40);
  float facing = smoothstep(0.25, 0.60, abs(normalize(vObjN).z));
  float strokeAmt = (1.0 - smoothZone) * facing * (0.70 + 0.30 * fbm(q * 2.0 + 9.0));

  // two stroke directions, mixed in patches (the painting's crossing combs)
  float patchN = fbm(q * 3.2 + 4.0);
  vec2 sA = strokes(q, 1.15 + (fbm(q * 1.6) - 0.5) * 0.9, 1.0);   // steep diagonal
  vec2 sB = strokes(q, 2.15 + (fbm(q * 1.6 + 3.0) - 0.5) * 0.9, 7.0);   // the other way
  float mixB = smoothstep(0.42, 0.62, patchN);
  vec2 s = mix(sA, sB, mixB) * strokeAmt;
  // fade the strokes before they alias (pixel footprint of one stroke spacing)
  float fw = length(fwidth(q)) * 150.0;
  s *= 1.0 - smoothstep(0.35, 0.8, fw);

  // ---- the fire's light: from above, its strength sampled from the live simulation
  float heat;
#ifdef HAS_FIRE
  heat = clamp(fireHeatAt(vWorld + n * 0.035) * 1.4 + fireHeatAt(vWorld + vec3(0.0, 0.10, 0.0)) * 0.6, 0.0, 1.5);
#else
  heat = smoothstep(0.55, 0.98, vWorld.y) * 0.9;
#endif
  vec3 Lfire = normalize(vec3(-0.30, 1.0, 0.25));
  float kFire = max(dot(n, Lfire), 0.0);
  float kKey = max(dot(n, uKeyDir), 0.0);
  float fres = pow(1.0 - max(n.z, 0.0), 2.6);

  // ---- albedo: near-black navy; the strokes are raised (dark grooves, a lit flank)
  vec3 deep = vec3(0.028, 0.034, 0.120);
  vec3 navy = vec3(0.060, 0.072, 0.300);
  float topLift = smoothstep(0.40, 0.98, vWorld.y) * (0.35 + 0.65 * kFire);
  vec3 albedo = mix(deep, navy, clamp(topLift + kKey * 0.30, 0.0, 1.0));
  // the glossy zone is a richer ultramarine
  vec3 gloss0 = mix(vec3(0.05, 0.05, 0.30), vec3(0.16, 0.10, 0.70), clamp(0.35 + 0.65 * kFire, 0.0, 1.0));
  gloss0 = mix(gloss0, vec3(0.30, 0.10, 0.62), smoothstep(0.5, 0.9, fbm(q * 2.2 + 3.0)) * 0.45);
  albedo = mix(albedo, gloss0, smoothZone * 0.85);
  albedo *= 1.0 - 0.42 * (1.0 - s.x) * strokeAmt;               // grooves between strokes
  albedo += vec3(0.07, 0.09, 0.34) * max(s.y, 0.0) * 0.55 * (0.5 + 0.5 * kFire + 0.4 * kKey);

  // a dim maroon warmth at the cheek (the lava glowing through)
  float cheek = exp(-dot(vObj.xy - vec2(0.76, 0.41), vObj.xy - vec2(0.76, 0.41)) * 140.0);
  albedo += vec3(0.16, 0.012, 0.07) * cheek * (0.6 + 0.4 * uFlare);

  vec3 c = albedo;
  // blue fire light, hotter = cyan/white
  vec3 fireBlue = vec3(0.16, 0.28, 1.0);
  vec3 fireHot = vec3(0.55, 0.92, 1.0);
  c += mix(fireBlue, fireHot, smoothstep(0.6, 1.2, heat)) * kFire * heat * 0.5 * (0.6 + 0.4 * s.x);
  // where the fire licks the skin, the edge glows: yellow-orange at the hottest, cyan just
  // above it (the painting's iridescent outline around the forehead)
  float lick = smoothstep(0.25, 0.9, heat);
  float rimK = pow(fres, 1.6) * lick;
  c += mix(vec3(0.35, 0.85, 1.0), vec3(1.0, 0.78, 0.22), smoothstep(0.6, 1.1, heat)) * rimK * 1.1;
  // the lava around him: orange rim from the left/below, flickering
  vec3 Lmag = normalize(vec3(-1.0, -0.35, 0.2));
  float lavaN = fbm(vWorld.xy * 3.0 + vec2(t * 0.05, -t * 0.08));
  float rimLava = fres * max(dot(n, Lmag), 0.0);
  vec3 hot = vec3(1.0, 0.42, 0.12);
  c += hot * rimLava * (0.35 + 0.65 * uFlare) * (0.55 + 0.45 * lavaN) * 0.9;
  // glints: the lava reflected in the glossy skin (sharp, hot), and a cool key glint
  vec3 R = reflect(-V, n);
  float gloss = mix(18.0, 60.0, smoothZone);
  float spLava = pow(max(dot(R, normalize(vec3(-0.85, -0.25, 0.45))), 0.0), gloss);
  float glintMod = 0.25 + 0.75 * smoothstep(0.45, 0.85, lavaN);
  c += mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.85, 0.35), smoothZone) * spLava * glintMod * (0.5 + 0.5 * uFlare) * mix(0.6, 1.8, smoothZone);
  c += vec3(0.55, 0.75, 1.0) * pow(max(dot(R, uKeyDir), 0.0), 40.0) * 0.22;
  // two hot streaks on the back of the neck: long, thin, flickering with the lava
  // measured on tools/reference2.webp: streak 1 centred at px (722, 865), running steeply
  // down-left; streak 2 at px (742, 988), running down-right
  vec2 e1 = vObj.xy - vec2(0.5735, 0.2572);
  vec2 e2 = vObj.xy - vec2(0.5907, 0.1516);
  vec2 a1 = mat2(0.42, -0.91, 0.91, 0.42) * e1;     // x along the streak, y across it
  vec2 a2 = mat2(0.88, 0.47, -0.47, 0.88) * e2;
  float st1 = exp(-a1.x * a1.x / 0.0019 - a1.y * a1.y / 0.00018);
  float st2 = exp(-a2.x * a2.x / 0.0056 - a2.y * a2.y / 0.000075);
  float ember = (st1 + st2 * 0.85) * (0.65 + 0.35 * lavaN) * (0.7 + 0.3 * uFlare);
  c = mix(c, vec3(1.0, 0.62, 0.12), clamp(ember, 0.0, 1.0) * 0.9);
  c += vec3(1.0, 0.95, 0.55) * pow(clamp(ember, 0.0, 1.0), 3.0) * 0.6;
  float halo = exp(-a1.x * a1.x / 0.006 - a1.y * a1.y / 0.0012) + exp(-a2.x * a2.x / 0.010 - a2.y * a2.y / 0.0012);
  c += vec3(0.45, 0.20, 1.0) * halo * 0.22;                          // violet glow around them
  // the etched blue line along the profile
  c += vec3(0.10, 0.18, 0.80) * fres * 0.32;
  // teleport edge
  c += vec3(0.45, 0.9, 1.0) * edge * 1.6;

  if (uDebug > 0.5) c = vec3(0.15) + vec3(0.8) * max(dot(n, normalize(vec3(-0.3, 0.6, 0.8))), 0.0);
  gl_FragColor = vec4(c, 1.0);
}
