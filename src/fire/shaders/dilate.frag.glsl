// dilate.frag.glsl — grows the column ranges by DILATE columns (the render warps its lookups
// sideways by up to that much) and converts them to world z with a one-cell margin.
// Also smooths the mean velocity that drives the flow noise.
// out = (vx, vy, z min, z max), z in world units; an empty column has z min > z max.

uniform sampler2D uCols;

layout(location = 0) out vec4 fragColor;

#define DILATE 3

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  float kLo = 1e4;
  float kHi = -1e4;
  vec2 v = vec2(0.0);
  float n = 0.0;
  for (int j = -DILATE; j <= DILATE; j++) {
    for (int i = -DILATE; i <= DILATE; i++) {
      vec4 c = texelFetch(uCols, clamp(ij + ivec2(i, j), ivec2(0), ivec2(NX - 1, NY - 1)), 0);
      if (c.w >= c.z) {
        kLo = min(kLo, c.z);
        kHi = max(kHi, c.w);
        v += c.xy;
        n += 1.0;
      }
    }
  }
  if (n < 0.5) { fragColor = vec4(0.0, 0.0, 1.0, -1.0); return; }
  float z0 = uBoundsMin.z + (kLo - 1.0) * uCell.z;
  float z1 = uBoundsMin.z + (kHi + 2.0) * uCell.z;
  fragColor = vec4(v / n, z0, z1);
}
