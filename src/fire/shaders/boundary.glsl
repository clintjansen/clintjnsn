// boundary.glsl — domain walls for the projection passes.
// Open (Dirichlet p = 0, zero-gradient velocity): top (+Y), back (-X), both Z sides.
// Closed (Neumann p, zero velocity): bottom (-Y) and front (+X).
// Solid cells (obstacles) are Neumann for pressure and carry the obstacle velocity.

// 0 = inside, 1 = outside through an open wall, 2 = outside through a closed wall
int wallKind(ivec3 c) {
  if (c.x >= NX || c.y < 0) return 2;
  if (c.x < 0 || c.y >= NY || c.z < 0 || c.z >= NZ) return 1;
  return 0;
}

// Pressure targets are RG16F: r = pressure, g = divergence, or SOLID_MARK for solid cells.
const float SOLID_MARK = 30000.0;
const float SOLID_LIMIT = 20000.0;
bool isSolidP(vec4 s) { return s.g > SOLID_LIMIT; }
