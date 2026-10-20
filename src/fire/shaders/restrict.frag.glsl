// restrict.frag.glsl — compiled on the COARSE grid (NX.. = coarse sizes; FNX.. = fine sizes).
// Each coarse cell takes the mean divergence of its 8 fine children; it is solid when most of
// its children are. Warm start from the previous coarse solution.
// in: fine (p0, div | SOLID_MARK); out: coarse (p, div | SOLID_MARK).

uniform sampler2D uFineP;
uniform sampler2D uPrevC;
uniform float uWarm;

layout(location = 0) out vec4 fragColor;

ivec2 fineTexel(ivec3 c) {
  return ivec2((c.z % FTX) * FNX + c.x, (c.z / FTX) * FNY + c.y);
}

void main() {
  ivec3 C = fragCell();
  if (C.z >= NZ) { fragColor = vec4(0.0); return; }
  float sum = 0.0;
  float fluid = 0.0;
  float solid = 0.0;
  for (int i = 0; i < 8; i++) {
    ivec3 f = 2 * C + ivec3(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    if (f.x >= FNX || f.y >= FNY || f.z >= FNZ) continue;
    vec4 s = texelFetch(uFineP, fineTexel(f), 0);
    if (isSolidP(s)) solid += 1.0;
    else { sum += s.g; fluid += 1.0; }
  }
  if (fluid < 0.5 || solid > fluid) { fragColor = vec4(0.0, SOLID_MARK, 0.0, 0.0); return; }
  float p0 = fetchCell(uPrevC, C).r * uWarm;
  fragColor = vec4(p0, sum / fluid, 0.0, 0.0);
}
