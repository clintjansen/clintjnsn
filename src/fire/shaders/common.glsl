// common.glsl — prepended to every fire pass (after three's #defines NX NY NZ TX TY).
//
// The NX x NY x NZ grid lives in a 2D atlas: slice k is the tile (k % TX, k / TX), so the
// atlas is (TX*NX) x (TY*NY) texels. Cell (i, j, k) has its centre at world
// boundsMin + (i + 0.5, j + 0.5, k + 0.5) * cell. Tiles past NZ are unused (always 0).

precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec3 uBoundsMin;
uniform vec3 uBoundsMax;
uniform vec3 uCell;          // world size of one cell, per axis

const ivec3 GRID = ivec3(NX, NY, NZ);
const vec3 GRIDF = vec3(float(NX), float(NY), float(NZ));
const vec2 ATLAS = vec2(float(NX * TX), float(NY * TY));

ivec2 atlasTexel(ivec3 c) {
  return ivec2((c.z % TX) * NX + c.x, (c.z / TX) * NY + c.y);
}

// The cell this fragment writes; c.z >= NZ for the unused tiles at the end of the atlas.
// Also keeps its atlas texel and tile column for the neighbour lookups below.
ivec2 gP;
int gTx;
ivec3 fragCell() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int tx = p.x / NX;
  int ty = p.y / NY;
  gP = p;
  gTx = tx;
  return ivec3(p.x - tx * NX, p.y - ty * NY, ty * TX + tx);
}

// Atlas texels of the fragment cell's 6 neighbours without integer division / modulo (slow on
// GPUs, and the hot passes did two per neighbour). Only valid for neighbours inside the grid:
// the callers test the walls first, so an x or y neighbour never leaves the tile.
ivec2 texelXm() { return gP - ivec2(1, 0); }
ivec2 texelXp() { return gP + ivec2(1, 0); }
ivec2 texelYm() { return gP - ivec2(0, 1); }
ivec2 texelYp() { return gP + ivec2(0, 1); }
ivec2 texelZm() { return gTx == 0 ? gP + ivec2((TX - 1) * NX, -NY) : gP - ivec2(NX, 0); }
ivec2 texelZp() { return gTx == TX - 1 ? gP + ivec2(-(TX - 1) * NX, NY) : gP + ivec2(NX, 0); }
// the same, clamped to the grid (a neighbour past a wall is the cell itself), like fetchClamped
ivec2 texelXmC(ivec3 c) { return c.x > 0 ? texelXm() : gP; }
ivec2 texelXpC(ivec3 c) { return c.x < NX - 1 ? texelXp() : gP; }
ivec2 texelYmC(ivec3 c) { return c.y > 0 ? texelYm() : gP; }
ivec2 texelYpC(ivec3 c) { return c.y < NY - 1 ? texelYp() : gP; }
ivec2 texelZmC(ivec3 c) { return c.z > 0 ? texelZm() : gP; }
ivec2 texelZpC(ivec3 c) { return c.z < NZ - 1 ? texelZp() : gP; }

vec4 fetchCell(sampler2D t, ivec3 c) {
  return texelFetch(t, atlasTexel(c), 0);
}

vec4 fetchClamped(sampler2D t, ivec3 c) {
  return texelFetch(t, atlasTexel(clamp(c, ivec3(0), GRID - 1)), 0);
}

// Trilinear lookup at continuous grid coordinates g (cell centres at i + 0.5): two hardware
// bilinear taps from the neighbouring slices, mixed by the z fraction. x, y are clamped to
// [0.5, N - 0.5] (plus a hair: the filter's 8-bit subtexel weights can round a tap sitting on
// a texel centre into the neighbouring texel, which at a tile edge belongs to another slice)
// so a tap never reaches into the next tile. Beyond the outer cell centres the value is held.
const float TILE_GUARD = 0.502;
vec4 sampleGrid(sampler2D t, vec3 g) {
  g = vec3(clamp(g.xy, vec2(TILE_GUARD), GRIDF.xy - TILE_GUARD), clamp(g.z, 0.5, GRIDF.z - 0.5));
  float zc = g.z - 0.5;
  float k0 = floor(zc);
  float k1 = min(k0 + 1.0, GRIDF.z - 1.0);
  // tile of slice k: (k mod TX, k div TX), in float maths (integer division is slow on GPUs;
  // (k + 0.5) / TX is never near an integer, so the floor is exact)
  const float TXF = float(TX);
  float ty0 = floor((k0 + 0.5) * (1.0 / TXF));
  float ty1 = floor((k1 + 0.5) * (1.0 / TXF));
  vec2 o0 = vec2((k0 - ty0 * TXF) * GRIDF.x, ty0 * GRIDF.y);
  vec2 o1 = vec2((k1 - ty1 * TXF) * GRIDF.x, ty1 * GRIDF.y);
  vec4 a = textureLod(t, (o0 + g.xy) * (1.0 / ATLAS), 0.0);
  vec4 b = textureLod(t, (o1 + g.xy) * (1.0 / ATLAS), 0.0);
  return mix(a, b, zc - k0);
}

vec3 cellCentre(ivec3 c) {
  return uBoundsMin + (vec3(c) + 0.5) * uCell;
}

vec3 worldToGrid(vec3 w) {
  return (w - uBoundsMin) / uCell;
}
