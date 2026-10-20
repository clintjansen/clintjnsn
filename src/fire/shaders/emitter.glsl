// emitter.glsl — the scalp: a thin shell just outside the cranium, limited to a cap around
// uCapDir (top and back of the head). Shared by the velocity and the scalar pass so the
// tongues that get heat are the ones that get pushed.

uniform mat4 uScalp;         // world -> cranium unit-sphere space
uniform vec3 uCapDir;        // cap axis, in that unit-sphere space
uniform float uCapCos;       // cap half-angle (cosine)
uniform float uShell;        // shell thickness, in unit-sphere units
uniform float uEmitOn;       // 0 when the frame has no scalp
uniform sampler2D uNoise;
uniform float uTime;
uniform vec4 uTongue;        // x scale (tongues across the cap), y drift speed, z lo, w hi
uniform float uTongueFloor;  // emission between tongues (0 = fully separate licks)
uniform vec4 uHairline;      // x noise pull-in of the cap edge (cosine units), y its scale, z edge softness (cosine units), w side share

// Weight 0..1 of the emitter at world position w. nWorld: outward scalp normal (world),
// tone: a slow per-tongue value used as the hue phase of the fuel it releases,
// capPos: 0 at the edge of the cap (the hairline) .. 1 at its centre (the crown).
float emitter(vec3 w, out vec3 nWorld, out float tone, out float capPos) {
  nWorld = vec3(0.0, 1.0, 0.0);
  tone = 0.5;
  capPos = 0.0;
  if (uEmitOn < 0.5) return 0.0;
  vec3 q = (uScalp * vec4(w, 1.0)).xyz;
  float r = length(q);
  if (r <= 1.0 || r >= 1.0 + uShell) return 0.0;
  vec3 dir = q / r;
  float c = dot(dir, uCapDir);
  if (c <= uCapCos) return 0.0;
  capPos = clamp((c - uCapCos) / (1.0 - uCapCos), 0.0, 1.0);
  nWorld = normalize(transpose(mat3(uScalp)) * dir);

  // Tongues: noise on the cap, in head space so they ride with the head, drifting slowly.
  // (any cap axis: crossing with Z alone would give a zero vector, then NaN, for an axis along Z)
  vec3 e1 = normalize(cross(uCapDir, abs(uCapDir.z) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0)));
  vec3 e2 = cross(e1, uCapDir);
  vec2 uv = vec2(dot(dir, e1), dot(dir, e2)) * uTongue.x;
  float t = uTime * uTongue.y;
  float n1 = textureLod(uNoise, (uv + vec2(t * 0.9, -t * 0.6)) * 0.125, 0.0).r;
  float n2 = textureLod(uNoise, (uv * 1.9 + vec2(-t * 1.3, t * 0.7) + 3.7) * 0.125, 0.0).g;
  float n = n1 * 0.7 + n2 * 0.3;
  // the noise sits around 0.5; stretch it so the tongues spread over the whole warm band
  tone = clamp((textureLod(uNoise, (uv * 0.45 + vec2(t * 0.35, 1.3)) * 0.125, 0.0).b - 0.5) * 2.6 + 0.5, 0.0, 1.0);
  float tongues = mix(uTongueFloor, 1.0, smoothstep(uTongue.z, uTongue.w, n));

  // An irregular, soft hairline. The cap boundary is a plane, which the side view shows as a
  // straight diagonal across the head; a slow noise around the cap pulls the edge inwards (it
  // never pushes it past the scalp the integrator defined) and the edge fades over uHairline.z.
  float hn = textureLod(uNoise, (vec2(dot(dir, e1), dot(dir, e2)) * uHairline.y + vec2(11.3, 4.1)) * 0.125, 0.0).a;
  float cEdge = c - uHairline.x * clamp((hn - 0.5) * 2.5 + 0.5, 0.0, 1.0);
  float capW = smoothstep(uCapCos, uCapCos + uHairline.z, cEdge);
  // less on the sides of the skull (|dir.z|: towards / away from the viewer in head space), so
  // the flames gather along the crown and the back and frame the dark head
  capW *= 1.0 - uHairline.w * dir.z * dir.z;
  float shellW = 1.0 - smoothstep(0.4, 1.0, (r - 1.0) / uShell);
  return tongues * capW * shellW;
}
