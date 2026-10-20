// confine.frag.glsl — vorticity confinement: f = eps * h * (N x w), N = grad|w| / |grad|w||.
// Weighted by the fuel so the clear air stays calm and only the flames curl.

uniform sampler2D uVel;
uniform sampler2D uCurl;
uniform sampler2D uScal;
uniform float uDt;
uniform float uVorticity;

layout(location = 0) out vec4 fragColor;

void main() {
  ivec3 c = fragCell();
  if (c.z >= NZ) { fragColor = vec4(0.0); return; }
  vec4 vc = texelFetch(uVel, gP, 0);
  if (vc.w > 0.5) { fragColor = vc; return; }
  // the force is weighted by the fuel: skip the 7 curl fetches in clear air
  float fuel = smoothstep(0.0, 0.08, texelFetch(uScal, gP, 0).r);
  if (fuel <= 0.0) { fragColor = vec4(vc.xyz, 0.0); return; }
  vec3 w = texelFetch(uCurl, gP, 0).xyz;
  float wL = texelFetch(uCurl, texelXmC(c), 0).w;
  float wR = texelFetch(uCurl, texelXpC(c), 0).w;
  float wD = texelFetch(uCurl, texelYmC(c), 0).w;
  float wU = texelFetch(uCurl, texelYpC(c), 0).w;
  float wB = texelFetch(uCurl, texelZmC(c), 0).w;
  float wF = texelFetch(uCurl, texelZpC(c), 0).w;
  vec3 grad = vec3((wR - wL) / uCell.x, (wU - wD) / uCell.y, (wF - wB) / uCell.z) * 0.5;
  float gl = length(grad);
  vec3 v = vc.xyz;
  if (gl > 1e-4) {
    float h = (uCell.x + uCell.y + uCell.z) / 3.0;
    v += uDt * uVorticity * h * fuel * cross(grad / gl, w);
  }
  fragColor = vec4(v, 0.0);
}
