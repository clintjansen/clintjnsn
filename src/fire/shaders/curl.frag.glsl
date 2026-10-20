// curl.frag.glsl — vorticity w = curl(v) by central differences; .w = |w|.

uniform sampler2D uVel;

layout(location = 0) out vec4 fragColor;

void main() {
  ivec3 c = fragCell();
  if (c.z >= NZ) { fragColor = vec4(0.0); return; }
  vec3 vL = texelFetch(uVel, texelXmC(c), 0).xyz;
  vec3 vR = texelFetch(uVel, texelXpC(c), 0).xyz;
  vec3 vD = texelFetch(uVel, texelYmC(c), 0).xyz;
  vec3 vU = texelFetch(uVel, texelYpC(c), 0).xyz;
  vec3 vB = texelFetch(uVel, texelZmC(c), 0).xyz;
  vec3 vF = texelFetch(uVel, texelZpC(c), 0).xyz;
  vec3 dx = (vR - vL) / (2.0 * uCell.x);
  vec3 dy = (vU - vD) / (2.0 * uCell.y);
  vec3 dz = (vF - vB) / (2.0 * uCell.z);
  vec3 w = vec3(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x);
  fragColor = vec4(w, length(w));
}
