// advect-scalars.frag.glsl — the fire's scalars, advected by the projected velocity (RK2).
// Layout (all premultiplied by the fuel so trilinear mixing is mass weighted):
//   r = fuel / heat d       (0..~1; drives buoyancy, opacity and colour)
//   g = d * age             (seconds since the fuel left the scalp)
//   b = d * phase           (tongue phase: picks the warm or cool hue family, set at emission)

uniform sampler2D uVel;
uniform sampler2D uScal;
uniform float uDt;
uniform vec2 uDecay;         // x base decay (1/s), y extra decay per second of age (1/s^2)
uniform vec2 uEmit;          // x target fuel at the scalp, y rate (1/s)
uniform float uIntensity;
uniform float uHeadStart;    // age (s) given to fuel released at the crown
uniform vec2 uWallFade;      // x width (cells), y strength (1/s)

layout(location = 0) out vec4 fragColor;

void main() {
  ivec3 c = fragCell();
  if (c.z >= NZ) { fragColor = vec4(0.0); return; }
  vec4 vc = fetchCell(uVel, c);
  if (vc.w > 0.5) { fragColor = vec4(0.0); return; }

  vec3 g = vec3(c) + 0.5;
  vec3 vm = sampleGrid(uVel, g - 0.5 * uDt * vc.xyz / uCell).xyz;
  vec4 s = max(sampleGrid(uScal, g - uDt * vm / uCell), vec4(0.0));

  float age = min(s.g / max(s.r, 1e-4), 20.0);
  s.rgb *= exp(-(uDecay.x + uDecay.y * age) * uDt);
  s.g += s.r * uDt;

  vec3 n;
  float tone;
  float capPos;
  float e = emitter(cellCentre(c), n, tone, capPos) * uIntensity;
  if (e > 0.0) {
    float add = max(uEmit.x * e - s.r, 0.0) * (1.0 - exp(-uEmit.y * uDt));
    s.r += add;
    // fresh fuel starts at age 0 at the hairline and with a head start towards the crown,
    // so the roots are dark and the crown already glows
    s.g += add * uHeadStart * capPos;
    s.b += add * tone;
  }

  // Fade towards every wall so the box never shows.
  vec3 dw = min(g, GRIDF - g);
  float m = min(min(dw.x, dw.y), dw.z);
  float fade = smoothstep(0.5, uWallFade.x, m);
  s.rgb *= mix(1.0, fade, min(uWallFade.y * uDt, 1.0));

  if (!(s.r + s.g + s.b < 1e4)) s = vec4(0.0);   // NaN / Inf guard (see advect-velocity)
  fragColor = vec4(s.rgb, 0.0);
}
