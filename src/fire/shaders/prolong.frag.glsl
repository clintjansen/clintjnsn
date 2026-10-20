// prolong.frag.glsl — compiled on the FINE grid (CNX.. = coarse sizes). The fine solve starts
// from the coarse pressure, trilinearly interpolated (solid coarse cells hold the mean of their
// fluid neighbours, so the interpolation is smooth along the head).
// in: fine (p0, div | SOLID_MARK), coarse (p, ..); out: fine (p, div | SOLID_MARK).

uniform sampler2D uFineP;
uniform sampler2D uCoarseP;

layout(location = 0) out vec4 fragColor;

const vec3 CGRIDF = vec3(float(CNX), float(CNY), float(CNZ));
const vec2 CATLAS = vec2(float(CNX * CTX), float(CNY * CTY));

float sampleCoarse(vec3 g) {
  g = vec3(clamp(g.xy, vec2(0.502), CGRIDF.xy - 0.502), clamp(g.z, 0.5, CGRIDF.z - 0.5));   // see sampleGrid
  float zc = g.z - 0.5;
  float z0 = floor(zc);
  int k0 = int(z0);
  int k1 = min(k0 + 1, CNZ - 1);
  vec2 o0 = vec2(float((k0 % CTX) * CNX), float((k0 / CTX) * CNY));
  vec2 o1 = vec2(float((k1 % CTX) * CNX), float((k1 / CTX) * CNY));
  float a = textureLod(uCoarseP, (o0 + g.xy) / CATLAS, 0.0).r;
  float b = textureLod(uCoarseP, (o1 + g.xy) / CATLAS, 0.0).r;
  return mix(a, b, zc - z0);
}

void main() {
  ivec3 c = fragCell();
  if (c.z >= NZ) { fragColor = vec4(0.0); return; }
  vec4 s = fetchCell(uFineP, c);
  if (isSolidP(s)) { fragColor = s; return; }
  fragColor = vec4(sampleCoarse((vec3(c) + 0.5) * 0.5), s.g, 0.0, 0.0);
}
