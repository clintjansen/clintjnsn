// advect-velocity.frag.glsl — semi-Lagrangian (RK2) self-advection of the velocity, plus
// every force: buoyancy, the wind that blows the plume back, damping, the scalp's push and
// the pointer. Solid cells (inside an obstacle ellipsoid) take the velocity of the obstacle's
// rigid motion at that point (it turns, so the side of the skull sweeps the air with it) and
// are flagged in .w, which every later pass reads.

uniform sampler2D uVel;
uniform sampler2D uScal;
uniform float uDt;
uniform mat4 uObs[6];        // world -> unit sphere of each obstacle
uniform mat4 uObsMotion[6];  // world position -> velocity of the obstacle point there
uniform int uObsCount;
uniform float uBuoyancy;
uniform vec3 uWindDir;
uniform vec2 uWind;          // x: push per unit of fuel, y: ambient share (pushes clear air too)
uniform vec2 uWindAge;       // x share of the wind on fresh fuel, y age (s) at which it gets all of it
uniform float uDamping;
uniform vec4 uTurb;          // x strength (world units/s^2), y scale (noise cells per world unit), z drift, w flames-only share
uniform vec4 uEmitVel;       // x speed, y outward, z up, w back (weights of the direction)
uniform vec3 uEmitVel2;      // x rate (1/s), y depth share of the outward push, z share of the scalp's own motion
uniform float uIntensity;
uniform vec4 uPointer;       // xy world position, zw world velocity
uniform vec3 uPointerParams; // x radius, y strength, z rate (0 = inactive)

layout(location = 0) out vec4 fragColor;

void main() {
  ivec3 c = fragCell();
  if (c.z >= NZ) { fragColor = vec4(0.0); return; }
  vec3 w = cellCentre(c);

  for (int i = 0; i < 6; i++) {
    if (i >= uObsCount) break;
    vec3 q = (uObs[i] * vec4(w, 1.0)).xyz;
    if (dot(q, q) < 1.0) {
      vec3 vo = (uObsMotion[i] * vec4(w, 1.0)).xyz;
      float so = length(vo);
      if (!(so < 3.0)) vo = so > 0.0 && so < 1e6 ? vo * (3.0 / so) : vec3(0.0);
      fragColor = vec4(vo, 1.0);
      return;
    }
  }

  vec3 g = vec3(c) + 0.5;
  vec3 v0 = fetchCell(uVel, c).xyz;
  vec3 vm = sampleGrid(uVel, g - 0.5 * uDt * v0 / uCell).xyz;
  vec3 v = sampleGrid(uVel, g - uDt * vm / uCell).xyz;

  vec4 sc = fetchCell(uScal, c);
  float d = max(sc.r, 0.0);
  // the wind takes the flames once they have risen: fresh fuel at the scalp climbs first
  float age = sc.g / max(sc.r, 1e-4);
  float gust = mix(uWindAge.x, 1.0, smoothstep(0.0, uWindAge.y, age));
  v += uDt * (uBuoyancy * d * vec3(0.0, 1.0, 0.0) + uWind.x * (d * gust + uWind.y) * uWindDir);
  // Calm large-scale wandering: a slowly drifting noise force (the projection keeps only its
  // divergence-free part), mostly on the flames. Gives lobes and curls instead of a straight sheet.
  float flame = mix(1.0, smoothstep(0.0, 0.15, d), uTurb.w);
  if (uTurb.x > 0.0 && flame > 0.0) {
    vec2 tuv = (w.xy + vec2(0.37, 0.61) * w.z) * uTurb.y;
    float tt = uTime * uTurb.z;
    vec3 n1 = textureLod(uNoise, (tuv + vec2(tt, -0.5 * tt)) * 0.125, 0.0).rgb - 0.5;
    vec3 n2 = textureLod(uNoise, (tuv * 0.47 + vec2(-0.6 * tt, 0.8 * tt) + 5.3) * 0.125, 0.0).gba - 0.5;
    vec3 f = 2.0 * (n1 + 1.3 * n2);
    f.y *= f.y < 0.0 ? 0.5 : 1.0;   // it bends the licks, it does not push the fire down
    v += uDt * uTurb.x * f * flame;
  }
  v *= exp(-uDamping * uDt);

  vec3 n;
  float tone;
  float capPos;
  float e = emitter(w, n, tone, capPos) * uIntensity;
  if (e > 0.0) {
    // combed: up and back along the scalp (tangential), plus a little outward lift. The outward
    // part loses most of its depth (Z) component: on the side of the skull that faces the viewer
    // the flames climb over the head instead of leaving it towards the camera.
    vec3 comb = vec3(-uEmitVel.w, uEmitVel.z, 0.0);
    vec3 nOut = vec3(n.xy, n.z * uEmitVel2.y);
    vec3 dir = normalize(nOut * uEmitVel.y + (comb - n * dot(comb, n)) + 1e-4 * n);
    // relative to the scalp: when the head turns, the air it releases moves with it
    vec3 target = dir * uEmitVel.x + scalpVelocity(w) * uEmitVel2.z;
    v = mix(v, target, e * (1.0 - exp(-uEmitVel2.x * uDt)));
  }

  // Pointer: the cursor only moves the air. Push along its motion (never brake the flow),
  // Gaussian in XY, through the whole depth.
  if (uPointerParams.z > 0.0) {
    vec2 dp = w.xy - uPointer.xy;
    float gp = exp(-dot(dp, dp) / (uPointerParams.x * uPointerParams.x));
    float sp = length(uPointer.zw);
    if (sp > 1e-4 && gp > 1e-3) {
      vec3 pd = vec3(uPointer.zw / sp, 0.0);
      float along = dot(v, pd);
      float target = sp * uPointerParams.y;
      if (along < target) v += pd * (target - along) * gp * (1.0 - exp(-uPointerParams.z * uDt));
    }
  }

  // Never let a NaN, an Inf or a runaway value into the state: a half-float target would keep
  // it forever and every later pass would spread it (|v| < 50 world units/s is never legit).
  if (!(dot(v, v) < 2500.0)) v = vec3(0.0);
  fragColor = vec4(v, 0.0);
}
