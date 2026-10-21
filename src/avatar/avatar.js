/**
 * avatar.js — the character as a real 3D model: a skinned mesh with three bones.
 *
 * The mesh (tools/build_avatar.py) is built from the painting itself, so in its rest pose and
 * seen through the page's orthographic camera it has exactly the painted outline. The bones
 * (chest -> neck -> head) let him breathe, bob, nod and turn his head towards the viewer; the
 * skin keeps its contour lines because they live in rest-pose object space.
 *
 * It also describes itself to the fire: every frame `fireFrame(dt)` returns the head's
 * collision volumes and scalp in their current pose, so the 3D fire grows from his scalp
 * and flows around his head as he moves.
 *
 * World space: units = backdrop image heights, X right, Y up, Z towards the viewer.
 */

import * as THREE from 'three';
import binUrl from './bust.bin?url';
import meta from './bust.json';
import vertexShader from './bust.vert.glsl?raw';
import fragmentShaderSrc from './bust.frag.glsl?raw';

export const avatarMeta = meta;

// The skin's teleport dissolve, alone (keep in sync with bust.frag.glsl).
const DEPTH_FRAGMENT = `
uniform sampler2D uNoise;
uniform float uReveal;
varying vec3 vObj;
const mat2 ROT = mat2(0.80, 0.60, -0.60, 0.80);
float ntex(vec2 p, vec4 sel) { return dot(texture2D(uNoise, p * 0.125), sel) * 2.0 - 1.0; }
float fbm(vec2 p) {
  return (ntex(p, vec4(1.0, 0.0, 0.0, 0.0)) * 0.62 + ntex(ROT * p * 2.3 + 5.1, vec4(0.0, 0.0, 1.0, 0.0)) * 0.26) * 0.6 + 0.5;
}
void main() {
  if (fbm(vObj.xy * 5.0 + vObj.z * 3.0) > uReveal * 1.25 - 0.1) discard;
  gl_FragColor = vec4(0.0);
}
`;

export async function loadAvatarBuffer() {
  const res = await fetch(binUrl);
  if (!res.ok) throw new Error(`avatar mesh: HTTP ${res.status}`);
  return res.arrayBuffer();
}

function buildGeometry(buffer) {
  const n = meta.vertexCount;
  const L = meta.layout;
  const q = new Uint16Array(buffer, L.position, n * 3);
  const nr = new Int8Array(buffer, L.normal, n * 4);
  const w8 = new Uint8Array(buffer, L.skinWeight, n * 4);
  const idx = meta.indexType === 'uint16'
    ? new Uint16Array(buffer, L.index, meta.indexCount)
    : new Uint32Array(buffer, L.index, meta.indexCount);

  const lo = meta.posMin;
  const span = meta.posMax.map((v, i) => v - lo[i]);
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const sw = new Float32Array(n * 4);
  const si = new Uint16Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) pos[i * 3 + k] = lo[k] + (q[i * 3 + k] / 65535) * span[k];
    const x = nr[i * 4] / 127, y = nr[i * 4 + 1] / 127, z = nr[i * 4 + 2] / 127;
    const l = Math.hypot(x, y, z) || 1;
    nrm[i * 3] = x / l; nrm[i * 3 + 1] = y / l; nrm[i * 3 + 2] = z / l;
    for (let k = 0; k < 4; k++) sw[i * 4 + k] = w8[i * 4 + k] / 255;
    si[i * 4] = 0; si[i * 4 + 1] = 1; si[i * 4 + 2] = 2; si[i * 4 + 3] = 0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setIndex(new THREE.BufferAttribute(idx.slice(), 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * @param {ArrayBuffer} buffer   src/avatar/bust.bin
 * @param {object} opts
 * @param {THREE.Texture} opts.noise         the shared tiling noise texture
 * @param {{uniforms: object, glsl: string}|null} opts.fireSampling  fire light (optional)
 */
export function createAvatar(buffer, { noise, fireSampling = null }) {
  const geometry = buildGeometry(buffer);

  const uniforms = {
    uNoise: { value: noise },
    uTime: { value: 0 },
    uLineFreq: { value: 76 },
    uLineWidth: { value: 0.19 },
    uKeyDir: { value: new THREE.Vector3(0.4, 0.5, 0.75).normalize() },
    uFlare: { value: 0.5 },
    uReveal: { value: 0 },
    uDebug: { value: 0 },
    ...(fireSampling ? fireSampling.uniforms : {}),
  };
  const fragmentShader = fireSampling
    ? '#define HAS_FIRE\n' + fragmentShaderSrc.replace('// FIRE_SAMPLING', fireSampling.glsl)
    : fragmentShaderSrc;
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, side: THREE.FrontSide });
  // Depth only, for the fire's occlusion: same skinning, same teleport dissolve as the skin.
  const depthMaterial = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader: DEPTH_FRAGMENT,
    colorWrite: false,
  });

  // ---- rig: chest -> neck -> head, at the pivots measured on the painting
  const P = meta.bones.pivot;
  const chest = new THREE.Bone();
  const neck = new THREE.Bone();
  const head = new THREE.Bone();
  chest.name = 'chest'; neck.name = 'neck'; head.name = 'head';
  chest.position.fromArray(P.chest);
  neck.position.set(P.neck[0] - P.chest[0], P.neck[1] - P.chest[1], P.neck[2] - P.chest[2]);
  head.position.set(P.head[0] - P.neck[0], P.head[1] - P.neck[1], P.head[2] - P.neck[2]);
  chest.rotation.order = 'YZX';
  neck.rotation.order = 'YZX';
  head.rotation.order = 'YZX';
  chest.add(neck);
  neck.add(head);

  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.add(chest);
  mesh.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton([chest, neck, head]);
  mesh.bind(skeleton);
  const bones = { chest, neck, head };
  const boneIndex = { chest: 0, neck: 1, head: 2 };

  // ---- fire interface: obstacles + scalp, rest matrices (ellipsoid unit sphere -> world)
  const restOf = (o) => new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(o.center),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), o.rotationZ),
    new THREE.Vector3().fromArray(o.radii),
  );
  const obstacles = meta.obstacles.map((o) => ({ bone: boneIndex[o.bone], rest: restOf(o) }));
  const scalpRest = restOf(meta.scalp);
  const scalpBone = boneIndex[meta.scalp.bone];

  const tmp = new THREE.Matrix4();
  const frame = {
    obstacles: obstacles.map(() => new THREE.Matrix4()),
    obstacleVelocity: obstacles.map(() => new THREE.Vector3()),
    scalp: new THREE.Matrix4(),
    scalpCapDir: new THREE.Vector3().fromArray(meta.scalp.capDir).normalize(),
    scalpCapCos: meta.scalp.capCos,
    pointer: { x: -10, y: -10, vx: 0, vy: 0, active: false },
    intensity: 0,
  };
  const prevCentre = obstacles.map(() => new THREE.Vector3());
  const centre = new THREE.Vector3();
  let primed = false;

  /** world matrix of the ellipsoid (unit sphere -> world) in the current pose */
  function posed(boneIdx, rest, out) {
    // bone world now * inverse(bone world at rest) * rest
    out.multiplyMatrices(skeleton.bones[boneIdx].matrixWorld, skeleton.boneInverses[boneIdx]);
    return out.multiply(rest);
  }

  /**
   * Pose the rig. All angles in radians.
   *   yaw    0 = profile (rest), > 0 turns his face towards the viewer
   *   pitch  > 0 lifts the chin, < 0 nods down
   *   roll   > 0 tilts the top of the head towards the viewer (about the line of his nose)
   *   breath -1..1, bob {x, y} in world units
   * The turn is shared down the spine: the shoulders follow a little, the neck twists, the head
   * does the rest; the skull, face and jaw turn as one (see the skin weights in the builder).
   */
  function setPose({ yaw = 0, pitch = 0, roll = 0, breath = 0, bobX = 0, bobY = 0 } = {}) {
    chest.position.set(P.chest[0] + bobX * 0.6, P.chest[1] + bobY * 0.6 + 0.004 * breath, P.chest[2]);
    chest.rotation.set(0, -yaw * 0.06, 0.010 * breath);
    neck.rotation.set(roll * 0.35, -yaw * 0.34, pitch * 0.35 - 0.012 * breath);
    head.rotation.set(roll * 0.65, -yaw * 0.60, pitch * 0.65 + 0.006 * breath);
    // the head carries a little more of the bob than the chest: it floats
    head.position.set(P.head[0] - P.neck[0] + bobX * 0.4, P.head[1] - P.neck[1] + bobY * 0.4, 0);
    mesh.updateMatrixWorld(true);
  }

  /** The current pose as the fire module's frame description. */
  function fireFrame(dt) {
    for (let i = 0; i < obstacles.length; i++) {
      posed(obstacles[i].bone, obstacles[i].rest, tmp);
      centre.setFromMatrixPosition(tmp);
      if (primed && dt > 0) frame.obstacleVelocity[i].subVectors(centre, prevCentre[i]).divideScalar(dt);
      else frame.obstacleVelocity[i].set(0, 0, 0);
      prevCentre[i].copy(centre);
      frame.obstacles[i].copy(tmp).invert();
    }
    posed(scalpBone, scalpRest, tmp);
    frame.scalp.copy(tmp).invert();
    primed = true;
    return frame;
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
    depthMaterial.dispose();
    skeleton.dispose();
  }

  return { mesh, bones, skeleton, uniforms, material, depthMaterial, setPose, fireFrame, frame, dispose };
}

/** Give an existing avatar a material lit by the fire simulation (keeps its uniform values). */
createAvatar.relight = function relight(avatar, fireSampling) {
  Object.assign(avatar.uniforms, fireSampling.uniforms);
  const material = new THREE.ShaderMaterial({
    uniforms: avatar.uniforms,
    vertexShader,
    fragmentShader: '#define HAS_FIRE\n' + fragmentShaderSrc.replace('// FIRE_SAMPLING', fireSampling.glsl),
  });
  avatar.mesh.material = material;
  avatar.material = material;
};
