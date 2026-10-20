// divergence.frag.glsl — div(v) and the warm-start pressure into an RG16F target:
// out = (p0, div), and solid cells store SOLID_MARK in g. The Jacobi passes keep that layout,
// so one 32-bit fetch per neighbour gives both its pressure and whether it is solid.

uniform sampler2D uVel;
uniform sampler2D uPrevP;
uniform float uWarm;

layout(location = 0) out vec4 fragColor;

vec3 nbVel(ivec3 c, ivec2 t, vec3 vc) {
  int k = wallKind(c);
  if (k == 1) return vc;
  if (k == 2) return vec3(0.0);
  return texelFetch(uVel, t, 0).xyz;   // solid cells hold the obstacle velocity
}

void main() {
  ivec3 c = fragCell();
  if (c.z >= NZ) { fragColor = vec4(0.0); return; }
  vec4 vc = texelFetch(uVel, gP, 0);
  if (vc.w > 0.5) { fragColor = vec4(0.0, SOLID_MARK, 0.0, 0.0); return; }
  float vL = nbVel(c + ivec3(-1, 0, 0), texelXm(), vc.xyz).x;
  float vR = nbVel(c + ivec3(1, 0, 0), texelXp(), vc.xyz).x;
  float vD = nbVel(c + ivec3(0, -1, 0), texelYm(), vc.xyz).y;
  float vU = nbVel(c + ivec3(0, 1, 0), texelYp(), vc.xyz).y;
  float vB = nbVel(c + ivec3(0, 0, -1), texelZm(), vc.xyz).z;
  float vF = nbVel(c + ivec3(0, 0, 1), texelZp(), vc.xyz).z;
  float div = 0.5 * ((vR - vL) / uCell.x + (vU - vD) / uCell.y + (vF - vB) / uCell.z);
  float p0 = uWarm > 0.0 ? texelFetch(uPrevP, gP, 0).r * uWarm : 0.0;   // 0 with multigrid (prolong overwrites it)
  fragColor = vec4(p0, clamp(div, -SOLID_LIMIT, SOLID_LIMIT), 0.0, 0.0);
}
