/* Getting a take out of cermin.
 *
 *   .glb  the mannequin and its animation, for Godot, three.js, gerak, Blender
 *   .bvh  the skeleton and its motion, the plain-text format every animation
 *         package has read since the nineties - no mesh, no face
 *   .csv  all 51 face values per frame (ARKit's 52 less tongueOut), named the ARKit way, to drive a real
 *         character's face somewhere else
 *   .fbx  made from the .glb by Blender, on the server (see blender/to_fbx.py)
 *
 * The animation clip built here is also what the viewport plays, so what you
 * watch is exactly what you export.
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/GLTFExporter.js';
import { BONES, FACE_SHAPES } from './mannequin.js';
import { BONE_NAMES } from './solve.js';

/** The solved take as a three.js animation clip. */
export function buildClip(solved, name = 'cermin') {
  const n = solved.frames.length;
  const times = Float32Array.from({ length: n }, (_, i) => i / solved.fps);
  const tracks = [];

  BONE_NAMES.forEach((bone, b) => {
    const values = new Float32Array(n * 4);
    let moves = false;
    let px = 0, py = 0, pz = 0, pw = 1;
    for (let i = 0; i < n; i++) {
      const q = solved.frames[i].q;
      let x = q[b * 4], y = q[b * 4 + 1], z = q[b * 4 + 2], w = q[b * 4 + 3];
      // Keep each key on the same side of the sphere as the one before, or
      // the interpolation between them takes the long way round.
      if (x * px + y * py + z * pz + w * pw < 0) { x = -x; y = -y; z = -z; w = -w; }
      values.set([x, y, z, w], i * 4);
      px = x; py = y; pz = z; pw = w;
      if (Math.abs(w) < 0.99999) moves = true;
    }
    if (moves) tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values));
  });

  const hips = new Float32Array(n * 3);
  solved.frames.forEach((f, i) => hips.set(f.hips, i * 3));
  tracks.push(new THREE.VectorKeyframeTrack('Hips.position', times, hips));

  FACE_SHAPES.forEach((shape, k) => {
    const values = Float32Array.from(solved.frames, (f) => f.m[k]);
    if (values.some((v) => v > 0.01)) {
      tracks.push(new THREE.NumberKeyframeTrack(`Face.morphTargetInfluences[${shape}]`, times, values));
    }
  });

  return new THREE.AnimationClip(name, n / solved.fps, tracks);
}

/** The mannequin in its T-pose, with the take as its one animation. */
export async function toGLB(mannequin, clip) {
  mannequin.reset();
  const exporter = new GLTFExporter();
  return exporter.parseAsync(mannequin.root, {
    binary: true, animations: [clip], onlyVisible: true,
  });
}

/** The skeleton and its motion as a .bvh, in centimetres. */
export function toBVH(solved) {
  const children = {};
  for (const [name, parent] of BONES) (children[parent] ||= []).push(name);
  const offset = Object.fromEntries(BONES.map(([n, , o]) => [n, o]));
  const cm = (v) => (v * 100).toFixed(4);
  const order = [];                       // the joints, in the order their channels are written
  const lines = ['HIERARCHY'];

  const write = (name, depth) => {
    const pad = '  '.repeat(depth);
    const kids = children[name] || [];
    if (!kids.length) {
      const [x, y, z] = offset[name];
      lines.push(`${pad}End Site`, `${pad}{`, `${pad}  OFFSET ${cm(x)} ${cm(y)} ${cm(z)}`, `${pad}}`);
      return;
    }
    const root = depth === 0;
    const [x, y, z] = root ? [0, 0, 0] : offset[name];
    lines.push(`${pad}${root ? 'ROOT' : 'JOINT'} ${name}`, `${pad}{`,
      `${pad}  OFFSET ${cm(x)} ${cm(y)} ${cm(z)}`,
      root ? `${pad}  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation`
        : `${pad}  CHANNELS 3 Zrotation Xrotation Yrotation`);
    order.push(name);
    for (const k of kids) write(k, depth + 1);
    lines.push(`${pad}}`);
  };
  write('Hips', 0);

  const index = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  const deg = THREE.MathUtils.radToDeg;
  lines.push('MOTION', `Frames: ${solved.frames.length}`, `Frame Time: ${(1 / solved.fps).toFixed(6)}`);
  for (const f of solved.frames) {
    const row = f.hips.map(cm);
    for (const name of order) {
      const b = index[name];
      q.set(f.q[b * 4], f.q[b * 4 + 1], f.q[b * 4 + 2], f.q[b * 4 + 3]);
      // BVH's "Z X Y" is three.js's 'ZXY': the matrix Rz · Rx · Ry.
      e.setFromQuaternion(q, 'ZXY');
      row.push(deg(e.z).toFixed(4), deg(e.x).toFixed(4), deg(e.y).toFixed(4));
    }
    lines.push(row.join(' '));
  }
  return lines.join('\n') + '\n';
}

/** All 51 face values per frame. */
export function toFaceCSV(solved) {
  const names = (solved.faceNames || []).filter((n) => n !== '_neutral');
  const at = Object.fromEntries((solved.faceNames || []).map((n, i) => [n, i]));
  const rows = [['time', ...names].join(',')];
  solved.faceAll.forEach((f, i) => {
    const t = (i / solved.fps).toFixed(4);
    rows.push([t, ...names.map((n) => (f ? f[at[n]].toFixed(4) : ''))].join(','));
  });
  return rows.join('\n') + '\n';
}
