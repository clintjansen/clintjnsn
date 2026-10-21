// advect-scalars.frag.glsl — the fire's scalars, advected by the projected velocity (RK2).
// Layout (rgb premultiplied by the fuel so trilinear mixing is mass weighted):
//   r = fuel / heat d       (0..~1; drives buoyancy, opacity and colour)
//   g = d * age             (seconds since the fuel left the scalp)
//   b = d * phase           (tongue phase: picks the warm or cool hue family, set at emission)
//   a = light               (0..1, NOT premultiplied: how much of the light from uLight reaches
//                            the cell through the fuel in front of it; 1 where there is no fuel.
//                            Recomputed every step from the fuel being advected in.)
//
// Fuel in the scalp shell rides with the scalp (uAttach): when the head turns, the flames at
// their roots go with it instead of being left behind in the air.
//
// Sharper transport (uSharp > 0, two passes): MacCormack. The same shader compiled with
// ADVECT_PRE only advects (semi-Lagrangian, no sources) into uPre; this pass then traces that
// result back to the departure point, adds half the round-trip error to the fuel and clamps it
// to the cells the first trace read (no new extrema). The fuel keeps its edges for seconds
// instead of melting into a haze; age and phase keep the plain advected ratios.

uniform sampler2D uVel;
uniform sampler2D uScal;
uniform float uDt;
uniform vec2 uDecay;         // x base decay (1/s), y extra decay per second of age (1/s^2)
uniform vec2 uEmit;          // x target fuel at the scalp, y rate (1/s)
uniform float uIntensity;
uniform float uHeadStart;    // age (s) given to fuel released at the crown
uniform vec3 uWallFade;      // x width at the X/Y walls (cells), y strength (1/s), z width at the Z walls (cells, 0 = none)
uniform float uAttach;       // 0..1: how much the fuel in the scalp shell moves with the scalp
uniform vec4 uLight;         // xyz: one light-march step (grid cells, towards the light), w: extinction per unit fuel per step (0 = off)
uniform sampler2D uPre;      // MacCormack: the plain advected scalars (ADVECT_PRE pass)
uniform float uSharp;        // MacCormack correction strength (0..1)
uniform float uSolidFill;    // share of its neighbours' fuel a solid cell takes each step (0 = empty)

layout(location = 0) out vec4 fragColor;

#define LIGHT_STEPS 6

void main() {
  ivec3 c = fragCell();
  if (c.z >= NZ) { fragColor = vec4(0.0); return; }
  vec4 vc = fetchCell(uVel, c);
  if (vc.w > 0.5) {
#ifndef ADVECT_PRE
    // Solid cells take a share of their neighbours' fuel (last step, solid ones included, so it
    // seeps a few cells in and fades). The flames then end at the avatar's real skin (the render
    // stops at its depth) instead of at the voxel staircase of the ellipsoid, and the fuel hugging
    // the head is not eaten by interpolation with empty solid cells.
    if (uSolidFill > 0.0) {
      vec4 sum = texelFetch(uScal, texelXmC(c), 0) + texelFetch(uScal, texelXpC(c), 0)
               + texelFetch(uScal, texelYmC(c), 0) + texelFetch(uScal, texelYpC(c), 0)
               + texelFetch(uScal, texelZmC(c), 0) + texelFetch(uScal, texelZpC(c), 0);
      vec3 f = max(sum.rgb, vec3(0.0)) * (uSolidFill / 6.0);
      float light = clamp(sum.a / 6.0, 0.0, 1.0);   // and the light of the fuel around it
      fragColor = f.r + f.g + f.b + light < 1e4 ? vec4(f, light) : vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
#endif
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);   // solid: no fuel, neutral light
    return;
  }

  vec3 wc = cellCentre(c);
  vec3 n;
  float tone;
  float capPos;
  float e = emitter(wc, n, tone, capPos) * uIntensity;   // also sets gShellW

  vec3 g = vec3(c) + 0.5;
  vec3 v0 = vc.xyz;
  float ride = gShellW * uAttach;
  vec3 vScalp = ride > 0.0 ? scalpVelocity(wc) : vec3(0.0);
  v0 = mix(v0, vScalp, ride);
  vec3 vm = sampleGrid(uVel, g - 0.5 * uDt * v0 / uCell).xyz;
  vm = mix(vm, vScalp, ride);
  vec3 gb = g - uDt * vm / uCell;
#ifdef ADVECT_PRE
  fragColor = vec4(max(sampleGrid(uScal, gb).rgb, vec3(0.0)), 0.0);
#else
  vec4 s;
  if (uSharp > 0.0) {
    s = texelFetch(uPre, gP, 0);
    if (s.r > 1e-3) {
      float back = sampleGrid(uPre, g + uDt * vm / uCell).r;
      float r = s.r + 0.5 * uSharp * (texelFetch(uScal, gP, 0).r - back);
      // limiter: inside the range of the 8 cells the forward trace interpolated
      ivec3 b0 = ivec3(floor(gb - 0.5));
      float lo = 1e4;
      float hi = 0.0;
      for (int k = 0; k < 8; k++) {
        float f = fetchClamped(uScal, b0 + ivec3(k & 1, (k >> 1) & 1, k >> 2)).r;
        lo = min(lo, f);
        hi = max(hi, f);
      }
      r = clamp(r, max(lo, 0.0), hi);
      s.rgb *= r / s.r;
    }
    s = max(s, vec4(0.0));
  } else {
    s = max(sampleGrid(uScal, gb), vec4(0.0));
  }

  float age = min(s.g / max(s.r, 1e-4), 20.0);
  s.rgb *= exp(-(uDecay.x + uDecay.y * age) * uDt);
  s.g += s.r * uDt;

  if (e > 0.0) {
    float add = max(uEmit.x * e - s.r, 0.0) * (1.0 - exp(-uEmit.y * uDt));
    s.r += add;
    // fresh fuel starts at age 0 at the hairline and with a head start towards the crown,
    // so the roots are dark and the crown already glows
    s.g += add * uHeadStart * capPos;
    s.b += add * tone;
  }

  // Fade towards the walls so the box never shows. The Z walls face the (orthographic) camera
  // and never show as an edge, so they get their own, normally much thinner, fade: the flames
  // in front of a head turned towards the viewer live right against the front wall.
  vec3 dw = min(g, GRIDF - g);
  float fade = smoothstep(0.5, uWallFade.x, min(dw.x, dw.y));
  if (uWallFade.z > 0.0) fade *= smoothstep(0.5, 0.5 + uWallFade.z, dw.z);
  s.rgb *= mix(1.0, fade, min(uWallFade.y * uDt, 1.0));

  // Light: march a few steps towards the light through the fuel being advected in (the old
  // field around the departure point), Beer-Lambert. Lit crests and dark folds are what give
  // each tongue its shape in the render.
  float light = 1.0;
  if (uLight.w > 0.0 && s.r > 2e-3) {
    float tau = 0.0;
    for (int i = 1; i <= LIGHT_STEPS; i++) tau += sampleGrid(uScal, gb + uLight.xyz * float(i)).r;
    light = exp(-uLight.w * max(tau, 0.0));
  }

  if (!(s.r + s.g + s.b < 1e4)) s = vec4(0.0);   // NaN / Inf guard (see advect-velocity)
  fragColor = vec4(s.rgb, light);
#endif
}
