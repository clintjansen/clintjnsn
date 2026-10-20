// The avatar's skin: skinned by three bones (chest, neck, head).
// vObj is the REST-pose position, so the painted contour lines ride on the skin when he moves.

#include <common>
#include <skinning_pars_vertex>

varying vec3 vObj;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vObjN;

void main() {
  #include <skinbase_vertex>
  #include <beginnormal_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>

  vObj = position;
  vObjN = normal;            // rest-pose normal: where the projected strokes would smear
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * objectNormal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
