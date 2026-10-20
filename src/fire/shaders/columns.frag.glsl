// columns.frag.glsl — per (x, y) column of the grid: the occupied slice range and the
// fuel-weighted mean XY velocity. Rendered into an NX x NY target.
// out = (vx, vy, kFirst, kLast); empty column: kFirst > kLast.

uniform sampler2D uScal;
uniform sampler2D uVel;
uniform float uThreshold;

layout(location = 0) out vec4 fragColor;

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  float kLo = 1e4;
  float kHi = -1e4;
  vec2 vs = vec2(0.0);
  float ws = 0.0;
  for (int k = 0; k < NZ; k++) {
    float d = fetchCell(uScal, ivec3(ij, k)).r;
    if (d > uThreshold) {
      kLo = min(kLo, float(k));
      kHi = max(kHi, float(k));
      vs += fetchCell(uVel, ivec3(ij, k)).xy * d;
      ws += d;
    }
  }
  fragColor = vec4(ws > 0.0 ? vs / ws : vec2(0.0), kLo, kHi);
}
