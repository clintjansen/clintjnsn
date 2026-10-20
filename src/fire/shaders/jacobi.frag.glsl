// jacobi.frag.glsl — one Jacobi iteration of lap(p) = div(v) on the anisotropic grid.
// in/out layout (RG16F): (p, div | SOLID_MARK).

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
  vec4 s = texelFetch(uP, gP, 0);
  if (isSolidP(s)) {
#ifdef COARSE
    // carry the mean pressure of the fluid neighbours, so the prolongation (trilinear) is
    // smooth along obstacles instead of being pulled to 0 there
    float sum = 0.0;
    float n = 0.0;
    for (int i = 0; i < 6; i++) {
      ivec3 o = i == 0 ? ivec3(-1, 0, 0) : i == 1 ? ivec3(1, 0, 0) : i == 2 ? ivec3(0, -1, 0)
              : i == 3 ? ivec3(0, 1, 0) : i == 4 ? ivec3(0, 0, -1) : ivec3(0, 0, 1);
      if (wallKind(c + o) != 0) continue;
      vec4 t = fetchCell(uP, c + o);
      if (!isSolidP(t)) { sum += t.r; n += 1.0; }
    }
    fragColor = vec4(n > 0.0 ? sum / n : s.r, SOLID_MARK, 0.0, 0.0);
#else
    fragColor = s;
#endif
    return;
  }
  float pc = s.r;
  vec3 ih2 = 1.0 / (uCell * uCell);
  float sx = nbP(c + ivec3(-1, 0, 0), texelXm(), pc) + nbP(c + ivec3(1, 0, 0), texelXp(), pc);
  float sy = nbP(c + ivec3(0, -1, 0), texelYm(), pc) + nbP(c + ivec3(0, 1, 0), texelYp(), pc);
  float sz = nbP(c + ivec3(0, 0, -1), texelZm(), pc) + nbP(c + ivec3(0, 0, 1), texelZp(), pc);
  float p = (sx * ih2.x + sy * ih2.y + sz * ih2.z - s.g) / (2.0 * (ih2.x + ih2.y + ih2.z));
  fragColor = vec4(p, s.g, 0.0, 0.0);
}
