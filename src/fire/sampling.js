/**
 * sampling.js — the GLSL snippet other materials include to be lit by the local fire.
 *
 *   const fire = createFire(renderer, ...);
 *   material.uniforms = { ...material.uniforms, ...fire.sampling.uniforms };   // same objects!
 *   material.fragmentShader = fire.sampling.glsl + '\n' + material.fragmentShader;
 *   // in the shader:  float h = fireHeatAt(worldPos + worldNormal * 0.03);
 *
 * The uniform objects are shared, so the texture the module swaps in after every step()
 * reaches every material that spread them in. fireHeatAt returns the fuel (~0..1.2) with
 * trilinear filtering, 0 outside the box. Cells inside the head are 0, so sample a little
 * outside the surface (2-4 cm) for lighting. Written with float maths only, so it compiles in
 * ShaderMaterial (GLSL1-style, texture2D) and in GLSL3 RawShaderMaterial (texture).
 */

import * as THREE from 'three';

export function createSampling({ NX, NY, NZ, TX, AW, AH, bmin, bmax }) {
  const f = (n) => `${n}.0`;
  const uniforms = {
    fireScalars: { value: null },
    fireBoundsMin: { value: new THREE.Vector3().copy(bmin) },
    fireBoundsMax: { value: new THREE.Vector3().copy(bmax) },
  };
  const glsl = /* glsl */ `
// ---- fire sampling (src/fire/sampling.js)
#ifndef FIRE_TEX
#if __VERSION__ >= 300
#define FIRE_TEX texture
#else
#define FIRE_TEX texture2D
#endif
#endif
uniform sampler2D fireScalars;
uniform vec3 fireBoundsMin;
uniform vec3 fireBoundsMax;

vec4 fireSampleRaw(vec3 worldPos) {
  const vec3 N = vec3(${f(NX)}, ${f(NY)}, ${f(NZ)});
  const vec2 ATLAS = vec2(${f(AW)}, ${f(AH)});
  const float TXF = ${f(TX)};
  vec3 g = (worldPos - fireBoundsMin) / (fireBoundsMax - fireBoundsMin) * N;
  if (any(lessThan(g, vec3(0.0))) || any(greaterThan(g, N))) return vec4(0.0);
  g = vec3(clamp(g.xy, vec2(0.502), N.xy - 0.502), clamp(g.z, 0.5, N.z - 0.5)); // never tap the next tile
  float zc = g.z - 0.5;
  float k0 = floor(zc);
  float fz = zc - k0;
  float k1 = min(k0 + 1.0, N.z - 1.0);
  float ty0 = floor((k0 + 0.5) / TXF);
  float ty1 = floor((k1 + 0.5) / TXF);
  vec2 o0 = vec2((k0 - ty0 * TXF) * N.x, ty0 * N.y);
  vec2 o1 = vec2((k1 - ty1 * TXF) * N.x, ty1 * N.y);
  vec4 a = FIRE_TEX(fireScalars, (o0 + g.xy) / ATLAS);
  vec4 b = FIRE_TEX(fireScalars, (o1 + g.xy) / ATLAS);
  return mix(a, b, fz);
}

// Fuel / heat of the fire at a world position (~0..1.2).
float fireHeatAt(vec3 worldPos) {
  return max(fireSampleRaw(worldPos).r, 0.0);
}

// Seconds since the fuel at worldPos left the scalp (0 where there is none).
float fireAgeAt(vec3 worldPos) {
  vec4 s = fireSampleRaw(worldPos);
  return s.r > 1e-3 ? s.g / s.r : 0.0;
}
// ---- end fire sampling
`;
  return { uniforms, glsl };
}
