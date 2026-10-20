// gradient.frag.glsl — v -= grad(p): the velocity becomes (nearly) divergence free.

uniform sampler2D uVel;
uniform sampler2D uP;

layout(location = 0) out vec4 fragColor;

float nbP(ivec3 c, ivec2 t, float pc) {
  int k = wallKind(c);
  if (k == 1) return 0.0;
  if (k == 2) return pc;
  vec4 s = texelFetch(uP, t, 0);
  return isSolidP(s) ? pc : s.r;
}

void main() {
  ivec3 c = fragCell();
  if (c.z >= NZ) { fragColor = vec4(0.0); return; }
  vec4 vc = texelFetch(uVel, gP, 0);
  if (vc.w > 0.5) { fragColor = vc; return; }
  float pc = texelFetch(uP, gP, 0).r;
  vec3 grad = 0.5 * vec3(
    (nbP(c + ivec3(1, 0, 0), texelXp(), pc) - nbP(c + ivec3(-1, 0, 0), texelXm(), pc)) / uCell.x,
    (nbP(c + ivec3(0, 1, 0), texelYp(), pc) - nbP(c + ivec3(0, -1, 0), texelYm(), pc)) / uCell.y,
    (nbP(c + ivec3(0, 0, 1), texelZp(), pc) - nbP(c + ivec3(0, 0, -1), texelZm(), pc)) / uCell.z);
  fragColor = vec4(vc.xyz - grad, 0.0);
}
