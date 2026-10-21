// composite.frag.glsl — upsamples the fire target over the frame (premultiplied alpha:
// ONE, ONE_MINUS_SRC_ALPHA). Exposure and a soft shoulder that rolls hot cores to white
// instead of clipping each channel; a whisper of ordered dither against banding.

precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uFire;      // fire up to the nearest bust depth of each low-res texel
uniform sampler2D uFireFar;   // ... up to the farthest (= no occlusion where the texel has background)
uniform sampler2D uDepth;     // the bust's depth (same camera, any resolution: indexed by uv)
uniform float uHasDepth;
uniform vec2 uDepthSize;
uniform float uExposure;
uniform float uShoulder;
uniform float uSpill;         // how much energy above the knee bleeds into white (0 keeps saturated hues)
uniform int uRaw;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

// Depth-aware (joint bilateral) upsampling. A pixel on the bust takes the "near" fire of the
// neighbouring low-res texels, a background pixel the "far" fire, and a neighbour only counts
// when the bust-depth texel of it closest to this pixel is of the same kind (bust or
// background). Plain bilinear here would mix 25% of fire from behind the head into the head's
// edge pixels (a bright ring) and 25% of clipped fire into the background beside it (a dark
// ring); per-texel nearest picks were 2 px blocky along the silhouette.
ivec2 gDp;        // this pixel's depth texel
bool gOnBust;
vec2 gRatio;      // depth texels per fire texel
ivec2 gDsz;

// Is the depth texel of fire texel t closest to this pixel the same kind as this pixel?
// (t covers the depth texels the march looked at: at most 2 x 2, see march.frag.glsl.)
bool sameKind(ivec2 t) {
  ivec2 lo = ivec2(floor(vec2(t) * gRatio));
  ivec2 hi = min(max(lo, ivec2(ceil(vec2(t + 1) * gRatio)) - 1), lo + 1);
  ivec2 r = clamp(clamp(gDp, lo, hi), ivec2(0), gDsz - 1);
  if (r == gDp) return true;
  return (texelFetch(uDepth, r, 0).r < 1.0) == gOnBust;
}

vec4 fireAt() {
  vec4 far = texture(uFireFar, vUv);
  if (uHasDepth < 0.5) return far;                                 // no depth: near == far
  if (far.a + dot(far.rgb, vec3(1.0)) < 1e-4) return vec4(0.0);    // far >= near, per texel
  ivec2 fsz = textureSize(uFireFar, 0);
  vec2 fs = vec2(fsz);
  gDsz = ivec2(uDepthSize);
  gRatio = uDepthSize / fs;
  gDp = clamp(ivec2(vUv * uDepthSize), ivec2(0), gDsz - 1);
  gOnBust = texelFetch(uDepth, gDp, 0).r < 1.0;
  vec2 tc = vUv * fs - 0.5;
  vec2 fl = floor(tc);
  vec2 f = tc - fl;
  ivec2 t0 = ivec2(fl);
  ivec2 t00 = clamp(t0, ivec2(0), fsz - 1);
  ivec2 t11 = clamp(t0 + 1, ivec2(0), fsz - 1);
  ivec2 t10 = ivec2(t11.x, t00.y);
  ivec2 t01 = ivec2(t00.x, t11.y);
  bool k00 = sameKind(t00);
  bool k10 = sameKind(t10);
  bool k01 = sameKind(t01);
  bool k11 = sameKind(t11);
  // the usual case (away from the silhouette): plain hardware bilinear
  if (k00 && k10 && k01 && k11) return gOnBust ? texture(uFire, vUv) : far;
  vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y)
         * vec4(k00 ? 1.0 : 0.0, k10 ? 1.0 : 0.0, k01 ? 1.0 : 0.0, k11 ? 1.0 : 0.0);
  float wsum = w.x + w.y + w.z + w.w;
  if (wsum < 1e-4) {
    ivec2 own = clamp(ivec2(vUv * fs), ivec2(0), fsz - 1);
    return gOnBust ? texelFetch(uFire, own, 0) : texelFetch(uFireFar, own, 0);
  }
  vec4 sum = gOnBust
    ? w.x * texelFetch(uFire, t00, 0) + w.y * texelFetch(uFire, t10, 0) + w.z * texelFetch(uFire, t01, 0) + w.w * texelFetch(uFire, t11, 0)
    : w.x * texelFetch(uFireFar, t00, 0) + w.y * texelFetch(uFireFar, t10, 0) + w.z * texelFetch(uFireFar, t01, 0) + w.w * texelFetch(uFireFar, t11, 0);
  return sum / wsum;
}

vec3 shoulder(vec3 x, float k) {
  vec3 over = max(x - k, 0.0);
  vec3 y = min(x, vec3(k)) + (1.0 - k) * (1.0 - exp(-over / (1.0 - k)));
  // energy above the knee bleeds into the other channels: hot blue turns white, not flat
  float spill = max(max(over.r, over.g), over.b);
  return y + (1.0 - y) * (1.0 - exp(-spill * uSpill));
}

void main() {
  vec4 c = fireAt();
  if (uRaw == 1) { fragColor = c; return; }
  if (c.a + dot(c.rgb, vec3(1.0)) < 1e-4) discard;
  vec3 rgb = shoulder(max(c.rgb * uExposure, 0.0), uShoulder);
  float a = clamp(c.a, 0.0, 1.0);
  vec2 p = gl_FragCoord.xy;
  float dither = (fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))) - 0.5) / 255.0;
  fragColor = vec4(rgb + dither * a, a);
}
