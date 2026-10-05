/* The mannequin every capture is put on.
 *
 * One standard humanoid, built here in code rather than loaded from a file, so
 * that what cermin exports is always the same skeleton with the same names.
 * The names are Mixamo's (Hips, Spine, LeftArm, LeftHandIndex1…), because that
 * is what Blender's retargeting add-ons, Unreal's IK Retargeter and gerak all
 * already recognise.
 *
 * Two rules make the solving simple, and everything in solve.js leans on them:
 *
 *   1. Every bone's rest rotation is zero. A bone's rest direction is just the
 *      offset to its child, so "point this bone that way" is one rotation.
 *   2. The mannequin stands in a T-pose facing +Z, with its own left on +X.
 *      Palms face down, thumbs face forward.
 *
 * The body is rigid pieces, each wholly owned by one bone, which is how a
 * wooden artist's mannequin works and why there is nothing to paint. The face
 * is a separate mesh with ARKit-named shape keys, so the 51 face values
 * MediaPipe gives can drive it - and any real character that has the same
 * names.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';

// name, parent, offset from the parent in metres
const SPINE = [
  ['Hips', null, [0, 0.95, 0]],
  ['Spine', 'Hips', [0, 0.09, 0]],
  ['Spine1', 'Spine', [0, 0.11, 0]],
  ['Spine2', 'Spine1', [0, 0.12, 0]],
  ['Neck', 'Spine2', [0, 0.17, 0]],
  ['Head', 'Neck', [0, 0.09, 0]],
  ['HeadTop_End', 'Head', [0, 0.21, 0]],
];

// One side, written for the left (+X) and mirrored for the right.
const ARM = [
  ['Shoulder', 'Spine2', [0.03, 0.12, 0]],
  ['Arm', 'Shoulder', [0.13, 0, 0]],
  ['ForeArm', 'Arm', [0.28, 0, 0]],
  ['Hand', 'ForeArm', [0.25, 0, 0]],
  ['HandThumb1', 'Hand', [0.025, -0.008, 0.028]],
  ['HandThumb2', 'HandThumb1', [0.028, -0.004, 0.02]],
  ['HandThumb3', 'HandThumb2', [0.026, 0, 0.012]],
  ['HandThumb4', 'HandThumb3', [0.022, 0, 0.006]],
  ['HandIndex1', 'Hand', [0.09, 0, 0.024]],
  ['HandIndex2', 'HandIndex1', [0.04, 0, 0.002]],
  ['HandIndex3', 'HandIndex2', [0.025, 0, 0]],
  ['HandIndex4', 'HandIndex3', [0.02, 0, 0]],
  ['HandMiddle1', 'Hand', [0.094, 0, 0.004]],
  ['HandMiddle2', 'HandMiddle1', [0.045, 0, 0]],
  ['HandMiddle3', 'HandMiddle2', [0.028, 0, 0]],
  ['HandMiddle4', 'HandMiddle3', [0.021, 0, 0]],
  ['HandRing1', 'Hand', [0.088, 0, -0.016]],
  ['HandRing2', 'HandRing1', [0.04, 0, 0]],
  ['HandRing3', 'HandRing2', [0.026, 0, 0]],
  ['HandRing4', 'HandRing3', [0.02, 0, 0]],
  ['HandPinky1', 'Hand', [0.08, 0, -0.034]],
  ['HandPinky2', 'HandPinky1', [0.032, 0, 0]],
  ['HandPinky3', 'HandPinky2', [0.02, 0, 0]],
  ['HandPinky4', 'HandPinky3', [0.018, 0, 0]],
];

const LEG = [
  ['UpLeg', 'Hips', [0.09, -0.04, 0]],
  ['Leg', 'UpLeg', [0, -0.43, 0]],
  ['Foot', 'Leg', [0, -0.41, 0]],
  ['ToeBase', 'Foot', [0, -0.045, 0.13]],
  ['Toe_End', 'ToeBase', [0, 0, 0.07]],
];

function sided(rows, side) {
  const sign = side === 'Left' ? 1 : -1;
  const named = (n) => (n === 'Spine2' || n === 'Hips' ? n : side + n);
  return rows.map(([n, p, [x, y, z]]) => [side + n, named(p), [x * sign, y, z]]);
}

export const BONES = [
  ...SPINE,
  ...sided(ARM, 'Left'), ...sided(ARM, 'Right'),
  ...sided(LEG, 'Left'), ...sided(LEG, 'Right'),
];

export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

/* The ARKit face shapes the mannequin can show. MediaPipe gives 51 of
 * ARKit's 52 (not tongueOut); these are the ones a face drawn with a few
 * lines can make visible. All 51 are still exported as data, in the .csv
 * beside the take. */
export const FACE_SHAPES = [
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeWideLeft', 'eyeWideRight',
  'eyeSquintLeft', 'eyeSquintRight',
  'browInnerUp', 'browDownLeft', 'browDownRight', 'browOuterUpLeft', 'browOuterUpRight',
  'jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthPucker', 'mouthFunnel', 'mouthLeft', 'mouthRight',
  'mouthStretchLeft', 'mouthStretchRight',
];

const BODY_COLOUR = new THREE.Color('#c9ced8');
const JOINT_COLOUR = new THREE.Color('#9aa3b5');
const FACE_COLOUR = new THREE.Color('#23262e');

/** World rest position of every bone (rest rotations are all zero). */
export function restPositions() {
  const at = {};
  for (const [name, parent, off] of BONES) {
    const base = parent ? at[parent] : new THREE.Vector3();
    at[name] = base.clone().add(new THREE.Vector3(...off));
  }
  return at;
}

// --------------------------------------------------------------------------
// the body: rigid pieces, one bone each
// --------------------------------------------------------------------------

function tagged(geo, boneIndex, colour) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const key of Object.keys(g.attributes)) {
    if (!['position', 'normal'].includes(key)) g.deleteAttribute(key);
  }
  const n = g.attributes.position.count;
  const idx = new Uint16Array(n * 4);
  const wgt = new Float32Array(n * 4);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    idx[i * 4] = boneIndex;
    wgt[i * 4] = 1;
    col[i * 3] = colour.r; col[i * 3 + 1] = colour.g; col[i * 3 + 2] = colour.b;
  }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wgt, 4));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

function capsule(a, b, r) {
  const dir = b.clone().sub(a);
  const len = Math.max(0.001, dir.length() - r * 0.6);
  const g = new THREE.CapsuleGeometry(r, len, 6, 14);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), dir.normalize()));
  g.translate(...a.clone().add(b).multiplyScalar(0.5).toArray());
  return g;
}

function ellipsoid(centre, radii) {
  const g = new THREE.SphereGeometry(1, 24, 16);
  g.scale(...radii);
  g.translate(...centre.toArray());
  return g;
}

function box(centre, size) {
  const g = new THREE.BoxGeometry(...size, 2, 1, 2);
  g.translate(...centre.toArray());
  return g;
}

function bodyPieces(at) {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const p = [];
  const add = (bone, geo, colour = BODY_COLOUR) => p.push({ bone, geo, colour });

  add('Hips', ellipsoid(at.Hips.clone().add(V(0, 0.01, 0)), [0.15, 0.1, 0.1]));
  add('Spine', capsule(at.Spine, at.Spine1, 0.115));
  add('Spine1', ellipsoid(at.Spine1.clone().add(V(0, 0.06, 0)), [0.145, 0.1, 0.095]));
  add('Spine2', ellipsoid(at.Spine2.clone().add(V(0, 0.07, 0.005)), [0.17, 0.125, 0.105]));
  add('Neck', capsule(at.Neck, at.Head, 0.045));
  add('Head', ellipsoid(at.Head.clone().add(V(0, 0.09, 0.01)), [0.085, 0.115, 0.1]));

  for (const s of ['Left', 'Right']) {
    const x = s === 'Left' ? 1 : -1;
    add(s + 'Shoulder', capsule(at[s + 'Shoulder'], at[s + 'Arm'], 0.045));
    add(s + 'Arm', ellipsoid(at[s + 'Arm'], [0.055, 0.055, 0.055]), JOINT_COLOUR);
    add(s + 'Arm', capsule(at[s + 'Arm'], at[s + 'ForeArm'], 0.05));
    add(s + 'ForeArm', ellipsoid(at[s + 'ForeArm'], [0.045, 0.045, 0.045]), JOINT_COLOUR);
    add(s + 'ForeArm', capsule(at[s + 'ForeArm'], at[s + 'Hand'], 0.04));
    add(s + 'Hand', box(at[s + 'Hand'].clone().add(V(0.048 * x, 0, -0.003)), [0.1, 0.026, 0.085]));
    for (const f of FINGERS) {
      for (let k = 1; k <= 3; k++) {
        const a = at[`${s}Hand${f}${k}`], b = at[`${s}Hand${f}${k + 1}`];
        add(`${s}Hand${f}${k}`, capsule(a, b, f === 'Thumb' ? 0.011 : 0.009));
      }
    }
    add(s + 'UpLeg', capsule(at[s + 'UpLeg'], at[s + 'Leg'], 0.07));
    add(s + 'Leg', ellipsoid(at[s + 'Leg'], [0.06, 0.06, 0.06]), JOINT_COLOUR);
    add(s + 'Leg', capsule(at[s + 'Leg'], at[s + 'Foot'], 0.052));
    const ankle = at[s + 'Foot'];
    add(s + 'Foot', box(V(ankle.x, 0.04, 0.035), [0.09, 0.08, 0.19]));
    add(s + 'ToeBase', box(V(ankle.x, 0.025, 0.165), [0.085, 0.05, 0.08]));
  }
  return p;
}

// --------------------------------------------------------------------------
// the face: a few dark marks on the head, each with shape keys
// --------------------------------------------------------------------------

/* Every face part is a flat shape on the front of the head. Each vertex
 * remembers which part it belongs to and where it sits within it, and each
 * shape key is a rule for how that moves - which is easier to read, and to
 * correct, than a table of numbers. */
function faceGeometry(at) {
  const hc = at.Head.clone().add(new THREE.Vector3(0, 0.09, 0.01));
  const parts = [];
  const part = (geo, kind, side, centre, w) => {
    geo.translate(centre.x, centre.y, centre.z);
    parts.push({ geo: geo.index ? geo.toNonIndexed() : geo, kind, side, centre, w });
  };
  for (const [side, x] of [['Left', 1], ['Right', -1]]) {
    const eye = new THREE.CircleGeometry(1, 24);
    eye.scale(0.016, 0.009, 1);
    part(eye, 'eye', side, hc.clone().add(new THREE.Vector3(0.032 * x, 0.015, 0.096)), 0.016);
    const brow = new THREE.BoxGeometry(0.03, 0.005, 0.004, 6, 1, 1);
    part(brow, 'brow', side, hc.clone().add(new THREE.Vector3(0.034 * x, 0.045, 0.088)), 0.015);
  }
  const mouth = new THREE.CircleGeometry(1, 40);
  mouth.scale(0.026, 0.0035, 1);
  part(mouth, 'mouth', null, hc.clone().add(new THREE.Vector3(0, -0.05, 0.094)), 0.026);

  // The rules. (dx, dy) for a vertex at (u, v) within its part, where u runs
  // from -1 to 1 across the part and v is its height in metres.
  const rules = {
    eyeBlink: (pt, side) => pt.kind === 'eye' && pt.side === side
      ? (u, v) => [0, -v * 0.92 - 0.001] : null,
    eyeWide: (pt, side) => pt.kind === 'eye' && pt.side === side
      ? (u, v) => [0, v * 0.5] : null,
    eyeSquint: (pt, side) => pt.kind === 'eye' && pt.side === side
      ? (u, v) => [0, v < 0 ? -v * 0.6 : -v * 0.2] : null,
    browInnerUp: (pt) => pt.kind === 'brow'
      ? (u, v, x) => [0, 0.011 * inner(u, x)] : null,
    browDown: (pt, side) => pt.kind === 'brow' && pt.side === side
      ? (u, v, x) => [0, -0.006 - 0.004 * inner(u, x)] : null,
    browOuterUp: (pt, side) => pt.kind === 'brow' && pt.side === side
      ? (u, v, x) => [0, 0.011 * (1 - inner(u, x))] : null,
    jawOpen: (pt) => pt.kind === 'mouth'
      ? (u, v) => [-u * 0.004, v < 0 ? v * 7 - 0.006 : v * 2.5 - 0.002] : null,
    mouthSmile: (pt, side) => pt.kind === 'mouth'
      ? (u) => (sideOf(u) === side ? [Math.sign(u) * 0.003 * u * u, 0.008 * u * u] : [0, 0]) : null,
    mouthFrown: (pt, side) => pt.kind === 'mouth'
      ? (u) => (sideOf(u) === side ? [0, -0.007 * u * u] : [0, 0]) : null,
    mouthPucker: (pt) => pt.kind === 'mouth'
      ? (u, v) => [-u * 0.026 * 0.45, v * 0.8] : null,
    mouthFunnel: (pt) => pt.kind === 'mouth'
      ? (u, v) => [-u * 0.026 * 0.3, v * 2.6] : null,
    mouthLeft: (pt) => pt.kind === 'mouth' ? () => [0.008, 0] : null,
    mouthRight: (pt) => pt.kind === 'mouth' ? () => [-0.008, 0] : null,
    mouthStretch: (pt, side) => pt.kind === 'mouth'
      ? (u) => (sideOf(u) === side ? [Math.sign(u) * 0.006 * Math.abs(u), -0.002 * Math.abs(u)] : [0, 0]) : null,
  };
  // How far toward the nose a point on a brow is: 1 at the inner end.
  function inner(u, x) { return THREE.MathUtils.clamp(0.5 - 0.5 * u * Math.sign(x), 0, 1); }
  function sideOf(u) { return u > 0.05 ? 'Left' : u < -0.05 ? 'Right' : null; }

  const merged = mergeGeometries(parts.map((pt) => {
    const g = pt.geo.clone();
    for (const key of Object.keys(g.attributes)) {
      if (!['position', 'normal'].includes(key)) g.deleteAttribute(key);
    }
    return g;
  }));

  const morphs = [];
  for (const name of FACE_SHAPES) {
    const side = name.endsWith('Left') ? 'Left' : name.endsWith('Right') ? 'Right' : null;
    const base = side ? name.slice(0, -side.length) : name;
    const delta = [];
    for (const pt of parts) {
      const rule = rules[base] && rules[base](pt, side);
      const pos = pt.geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        const u = (x - pt.centre.x) / pt.w, v = y - pt.centre.y;
        const [dx, dy] = rule ? rule(u, v, pt.centre.x) : [0, 0];
        delta.push(dx, dy, 0);
      }
    }
    morphs.push(new THREE.Float32BufferAttribute(delta, 3));
  }
  merged.morphAttributes.position = morphs;
  merged.morphTargetsRelative = true;
  return merged;
}

// --------------------------------------------------------------------------
// putting it together
// --------------------------------------------------------------------------

export function buildMannequin() {
  const at = restPositions();
  const root = new THREE.Group();
  root.name = 'cermin';

  const bones = {};
  const list = [];
  for (const [name, parent, off] of BONES) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(...off);
    (parent ? bones[parent] : root).add(bone);
    bones[name] = bone;
    list.push(bone);
  }
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(list);
  const indexOf = Object.fromEntries(list.map((b, i) => [b.name, i]));

  const bodyGeo = mergeGeometries(bodyPieces(at).map((pc) =>
    tagged(pc.geo, indexOf[pc.bone], pc.colour)));
  const body = new THREE.SkinnedMesh(bodyGeo, new THREE.MeshStandardMaterial({
    name: 'Mannequin', vertexColors: true, roughness: 0.62, metalness: 0.0,
  }));
  body.name = 'Body';
  body.castShadow = true;

  // Already non-indexed, so tagged() keeps the same geometry and its shape keys.
  const faceGeo = tagged(faceGeometry(at), indexOf.Head, FACE_COLOUR);
  const face = new THREE.SkinnedMesh(faceGeo, new THREE.MeshStandardMaterial({
    name: 'Face', vertexColors: true, roughness: 0.8, side: THREE.DoubleSide,
  }));
  face.name = 'Face';
  face.morphTargetDictionary = Object.fromEntries(FACE_SHAPES.map((n, i) => [n, i]));
  face.morphTargetInfluences = FACE_SHAPES.map(() => 0);

  root.add(body, face);
  body.bind(skeleton);
  face.bind(skeleton);

  const rest = Object.fromEntries(list.map((b) => [b.name, b.position.clone()]));

  return {
    root, bones, skeleton, body, face, rest,
    restAt: at,
    /** Back to the T-pose, every face shape at zero. */
    reset() {
      for (const b of list) { b.quaternion.identity(); b.position.copy(rest[b.name]); }
      face.morphTargetInfluences.fill(0);
      root.updateMatrixWorld(true);
    },
  };
}
