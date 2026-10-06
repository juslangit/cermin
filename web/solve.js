/* From tracked points to a moving mannequin.
 *
 * MediaPipe gives points: 33 on the body, 21 on each hand, and 52 numbers for
 * the face. A skeleton wants rotations. This file is the step between, and it
 * runs in four passes over the whole take:
 *
 *   1. fill     a frame where the person was lost borrows from its neighbours
 *   2. smooth   a One Euro filter, run forwards and then backwards and the two
 *               averaged, so the shake goes without the motion lagging behind
 *               the video (a filter run one way always trails)
 *   3. aim      each bone is turned to point where the points say it points
 *   4. ground   the hips are lifted or lowered until the lower foot touches
 *               the floor - the mannequin's legs are not the person's legs, so
 *               copying the person's height would leave it floating or sunk -
 *               and a jump is added back from how far the feet left the floor
 *               in the picture
 *
 * Coordinates: MediaPipe's x runs right across the picture, y down it, z away
 * from the camera. The mannequin's x is its own left, y is up, z is toward the
 * viewer. (x, -y, -z) turns one into the other, and it is a rotation, not a
 * mirror, so left stays left.
 */

import * as THREE from 'three';
import { BONES, FINGERS, FACE_SHAPES, restPositions } from './mannequin.js';
import { findJumps, travelAcross, scaleAtPerson } from './ground.js';
import { fuse } from './fuse.js';

export const P = {
  nose: 0, lEar: 7, rEar: 8, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16,
  lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20, lHip: 23, rHip: 24, lKnee: 25,
  rKnee: 26, lAnk: 27, rAnk: 28, lHeel: 29, rHeel: 30, lToe: 31, rToe: 32,
};
// Hand points: wrist, then four per finger from the knuckle nearest the palm.
const HAND_CHAIN = { Thumb: [1, 2, 3, 4], Index: [5, 6, 7, 8], Middle: [9, 10, 11, 12],
  Ring: [13, 14, 15, 16], Pinky: [17, 18, 19, 20] };

/* Where the nose sits against the line between the ears depends on the
 * person and on how high the camera is - a camera on the floor sees the nose
 * above the ears. So no fixed number is right. Over a whole take, the head's
 * middle pitch (relative to the chest) is taken as looking straight ahead,
 * within these limits. */
const HEAD_PITCH_LIMIT = THREE.MathUtils.degToRad(30);

/* The same is true of the camera itself: one tilted up or down makes a
 * standing person lean. The best evidence of "up" is someone standing on
 * straight legs - the line from between the ankles to between the hips is
 * then vertical, whatever the chest is doing - so those frames are used when
 * there are enough of them. Otherwise the chest's "up", when the hips were
 * really seen. Either way the middle of them is taken as upright, unless it is
 * so far from upright that it cannot be the camera. */
const LEVEL_LIMIT = THREE.MathUtils.degToRad(35);

/* Whether MediaPipe's "Left" face shapes are the person's left. Kept as one
 * switch so that, if a capture shows a wink on the wrong eye, it is one word
 * to change rather than a hunt. */
const FACE_SWAP_SIDES = false;

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

export const BONE_NAMES = BONES.map((b) => b[0]);
const BONE_INDEX = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));
const PARENT = Object.fromEntries(BONES.map(([n, p]) => [n, p]));
const OFFSET = Object.fromEntries(BONES.map(([n, , o]) => [n, new THREE.Vector3(...o)]));

// --------------------------------------------------------------------------
// small geometry
// --------------------------------------------------------------------------

const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();

function frameOf(a, b, out) {
  const e1 = a.clone().normalize();
  const e2 = b.clone().addScaledVector(e1, -b.dot(e1)).normalize();
  const e3 = new THREE.Vector3().crossVectors(e1, e2);
  return out.makeBasis(e1, e2, e3);
}

/** The rotation that takes direction a0 to a, with b0 swung as near to b as it can go. */
function align(a0, b0, a, b) {
  frameOf(a, b, _m1);
  frameOf(a0, b0, _m2).transpose();
  return new THREE.Quaternion().setFromRotationMatrix(_m1.multiply(_m2));
}

function swing(q, restDir, target) {
  const from = restDir.clone().applyQuaternion(q).normalize();
  return new THREE.Quaternion().setFromUnitVectors(from, target.clone().normalize()).multiply(q);
}

/** q to the power t, for sharing one turn between several joints. */
function share(q, t) {
  return new THREE.Quaternion().slerp(q, t);   // identity → q
}

function local(parentWorld, world) {
  return parentWorld.clone().invert().multiply(world);
}

// --------------------------------------------------------------------------
// 1 and 2: fill the gaps, then smooth
// --------------------------------------------------------------------------

class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1.0) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0 });
  }
  static a(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  step(x, dt) {
    if (this.x === null) { this.x = x; return x; }
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.a(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.a(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

/** Smoothing 0..1 → how hard the filter holds still. */
function filterSettings(smoothing) {
  return { minCutoff: THREE.MathUtils.lerp(8, 0.35, smoothing), beta: 1.2 };
}

/* A series is an array with one entry per frame, each entry a flat array of
 * numbers or null where nothing was seen. */
function fillGaps(series, maxGap) {
  const n = series.length;
  const out = series.slice();
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (!series[i]) continue;
    if (last >= 0 && i - last > 1 && i - last - 1 <= maxGap) {
      const a = series[last], b = series[i];
      for (let k = last + 1; k < i; k++) {
        const t = (k - last) / (i - last);
        out[k] = a.map((v, j) => v + (b[j] - v) * t);
      }
    }
    last = i;
  }
  return out;
}

function smoothSeries(series, dt, { minCutoff, beta }, scale = 1) {
  const n = series.length;
  const width = (series.find(Boolean) || []).length;
  if (!width) return series;
  const run = (order) => {
    const res = new Array(n).fill(null);
    let filters = null;
    for (const i of order) {
      const v = series[i];
      if (!v) { filters = null; continue; }      // a gap restarts the filter
      if (!filters) filters = Array.from({ length: width }, () => new OneEuro(minCutoff, beta / scale));
      res[i] = v.map((x, j) => filters[j].step(x, dt));
    }
    return res;
  };
  const idx = [...Array(n).keys()];
  const fwd = run(idx), back = run(idx.slice().reverse());
  return fwd.map((f, i) => (f ? f.map((x, j) => (x + back[i][j]) / 2) : null));
}

/** Pull one track out of the capture, as a series of flat arrays. */
function track(frames, pick) {
  return frames.map((f) => { const v = pick(f); return v ? Array.from(v) : null; });
}

export function prepare(capture, { smoothing = 0.5 } = {}) {
  const dt = 1 / capture.fps;
  const fs = filterSettings(smoothing);
  const F = capture.frames;
  const gap = Math.round(capture.fps * 0.5);

  const prep = (pick, maxGap, scale) =>
    smoothSeries(fillGaps(track(F, pick), maxGap), dt, fs, scale);
  // The body as MediaPipe saw it, with DWPose's legs and feet folded in when
  // the take was tracked on Best (fuse.js).
  const poses = fuse(capture);
  const pose = (n) => poses[n];

  return {
    fps: capture.fps,
    width: capture.width,
    height: capture.height,
    faceNames: capture.faceNames || [],
    n: F.length,
    poses,
    world: smoothSeries(fillGaps(F.map((_, n) => (pose(n) ? Array.from(pose(n).w) : null)), gap), dt, fs, 1),
    img: smoothSeries(fillGaps(F.map((_, n) => (pose(n) ? Array.from(pose(n).i) : null)), gap), dt, fs, 1),
    vis: fillGaps(F.map((_, n) => (pose(n) ? Array.from(pose(n).v) : null)), gap),
    handL: prep((f) => f.hands && f.hands.L && f.hands.L.w, Math.round(gap / 2), 0.15),
    handR: prep((f) => f.hands && f.hands.R && f.hands.R.w, Math.round(gap / 2), 0.15),
    face: prep((f) => f.face, gap, 1),
  };
}

// --------------------------------------------------------------------------
// 3: aim the bones
// --------------------------------------------------------------------------

const pt = (arr, i) => new THREE.Vector3(arr[i * 3], -arr[i * 3 + 1], -arr[i * 3 + 2]);
const mid = (a, b) => a.clone().add(b).multiplyScalar(0.5);
const restDir = (child) => OFFSET[child].clone().normalize();

/* Whether a point was really seen. MediaPipe reports every point, including
 * ones outside the picture, which it is guessing. A point inside the picture
 * is used even when its confidence is modest - a knee half-hidden behind the
 * other leg is still a far better guess than no knee - but one outside the
 * picture is not. Deciding with a high confidence bar instead made one leg
 * stand straight while the other bent, which is worse than either. */
export function isSeen(vis, img, i, min = 0.2) {
  if (vis && !(vis[i] > min)) return false;
  if (!img) return true;
  const x = img[i * 2], y = img[i * 2 + 1];
  return x > -0.02 && x < 1.02 && y > -0.02 && y < 1.02;
}

export function legSeen(vis, img, left) {
  return left ? isSeen(vis, img, P.lKnee) && isSeen(vis, img, P.lAnk)
    : isSeen(vis, img, P.rKnee) && isSeen(vis, img, P.rAnk);
}

/** Everything about one frame's pose, as world rotations of the bones.
 *  `level` turns the camera upright; `headPitch` is the head's neutral tilt. */
export function aimFrame(w, vis, handL, handR, { level = null, headPitch = 0, img = null } = {}) {
  const W = {};                                        // world rotations
  const get = (i) => (level ? pt(w, i).applyQuaternion(level) : pt(w, i));
  const hpt = (arr, i) => (level ? pt(arr, i).applyQuaternion(level) : pt(arr, i));
  const seen = (i, min) => isSeen(vis, img, i, min);

  // Hips and chest: the line across, and the line up.
  const shoulders = get(P.lSh).sub(get(P.rSh));
  let chest;
  if (seen(P.lHip, 0.5) && seen(P.rHip, 0.5)) {
    const up = mid(get(P.lSh), get(P.rSh)).sub(mid(get(P.lHip), get(P.rHip)));
    W.Hips = align(X, Y, get(P.lHip).sub(get(P.rHip)), up);
    chest = align(X, Y, shoulders, up);
  } else {
    // A webcam framed from the chest up: the tracker still reports hips, but
    // it is guessing, and its guess tips the whole body over. So the hips
    // only turn the way the shoulders face, and the chest stands upright,
    // keeping just the tilt of the shoulders.
    const flat = shoulders.clone().setY(0);
    W.Hips = align(X, Y, flat.lengthSq() > 1e-6 ? flat : X, Y);
    chest = align(X, Y, shoulders, Y);
  }
  const spineTurn = local(W.Hips, chest);
  W.Spine = W.Hips.clone().multiply(share(spineTurn, 1 / 3));
  W.Spine1 = W.Spine.clone().multiply(share(spineTurn, 1 / 3));
  W.Spine2 = chest;

  // Head: the line between the ears, and the way the nose points.
  const earMid = mid(get(P.lEar), get(P.rEar));
  const headMeasured = align(X, Z, get(P.lEar).sub(get(P.rEar)), get(P.nose).sub(earMid));
  const head = headMeasured.multiply(new THREE.Quaternion().setFromAxisAngle(X, -headPitch));
  const neckTurn = local(chest, head);
  W.Neck = chest.clone().multiply(share(neckTurn, 0.5));
  W.Head = head;

  for (const [s, sign] of [['Left', 1], ['Right', -1]]) {
    const l = s === 'Left';
    const sh = get(l ? P.lSh : P.rSh), el = get(l ? P.lEl : P.rEl), wr = get(l ? P.lWr : P.rWr);

    // Arm. The upper arm is aimed with the elbow's bend kept in the right
    // plane: in the T-pose the forearm folds forward (+Z), so the bend's
    // normal is (along the arm) × (forward). A straight arm has no bend to
    // read, so it borrows that normal from the chest instead of spinning.
    W[s + 'Shoulder'] = chest.clone();
    const upper = el.clone().sub(sh), fore = wr.clone().sub(el);
    const along0 = X.clone().multiplyScalar(sign);
    const bend0 = new THREE.Vector3().crossVectors(along0, Z);
    const bend = new THREE.Vector3().crossVectors(upper, fore)
      .addScaledVector(bend0.clone().applyQuaternion(chest), 0.12 * upper.length() * fore.length());
    W[s + 'Arm'] = align(along0, bend0, upper, bend);
    let foreArm = swing(W[s + 'Arm'], restDir(s + 'Hand'), fore);

    // Hand: the way the fingers point, and which side the thumb is on. From
    // the hand tracker when it saw the hand, from the body's rough hand points
    // when it did not.
    const hand = l ? handL : handR;
    let fingers, thumbSide;
    if (hand) {
      const h = (i) => hpt(hand, i);
      fingers = h(9).sub(h(0));
      thumbSide = h(5).sub(h(17));
    } else {
      const idx = get(l ? P.lIndex : P.rIndex), pk = get(l ? P.lPinky : P.rPinky);
      fingers = mid(idx, pk).sub(wr);
      thumbSide = idx.clone().sub(pk);
    }
    const handWorld = align(along0, Z, fingers, thumbSide);

    // Turning the palm over happens in the forearm, not the wrist, so the
    // forearm takes the twist and the hand keeps only its bend.
    const axis = fore.clone().normalize();
    const flat = (v) => v.clone().addScaledVector(axis, -v.dot(axis)).normalize();
    const a = flat(Z.clone().applyQuaternion(foreArm)), b = flat(Z.clone().applyQuaternion(handWorld));
    const twist = Math.atan2(axis.dot(new THREE.Vector3().crossVectors(a, b)), a.dot(b));
    foreArm = new THREE.Quaternion().setFromAxisAngle(axis, twist).multiply(foreArm);
    W[s + 'ForeArm'] = foreArm;
    W[s + 'Hand'] = handWorld;

    // Fingers: each joint swung from its parent to where the next point is.
    for (const f of FINGERS) {
      let parent = handWorld;
      for (let k = 1; k <= 3; k++) {
        const name = `${s}Hand${f}${k}`;
        let q = parent.clone();
        if (hand) {
          const ch = HAND_CHAIN[f];
          const dir = hpt(hand, ch[k]).sub(hpt(hand, ch[k - 1]));
          q = swing(parent, restDir(`${s}Hand${f}${k + 1}`), dir);
        }
        W[name] = q;
        parent = q;
      }
    }

    // Leg, the same way as the arm: in the T-pose the knee folds backward.
    const hip = get(l ? P.lHip : P.rHip), kn = get(l ? P.lKnee : P.rKnee), an = get(l ? P.lAnk : P.rAnk);
    const legsSeen = legSeen(vis, img, l);
    if (legsSeen) {
      const thigh = kn.clone().sub(hip), shin = an.clone().sub(kn);
      const down = Y.clone().negate();
      const kneeBend0 = new THREE.Vector3().crossVectors(down, Z.clone().negate());
      const kneeBend = new THREE.Vector3().crossVectors(thigh, shin)
        .addScaledVector(kneeBend0.clone().applyQuaternion(W.Hips), 0.12 * thigh.length() * shin.length());
      W[s + 'UpLeg'] = align(down, kneeBend0, thigh, kneeBend);
      W[s + 'Leg'] = swing(W[s + 'UpLeg'], restDir(s + 'Foot'), shin);
      const heel = get(l ? P.lHeel : P.rHeel), toe = get(l ? P.lToe : P.rToe);
      W[s + 'Foot'] = seen(l ? P.lToe : P.rToe, 0.3)
        ? align(Z, Y, toe.clone().sub(heel), an.clone().sub(heel))
        : W[s + 'Leg'].clone();
    } else {
      // Out of the picture: stand on them, straight under the hips.
      W[s + 'UpLeg'] = W.Hips.clone();
      W[s + 'Leg'] = W.Hips.clone();
      W[s + 'Foot'] = W.Hips.clone();
    }
  }
  return W;
}

/** World rotations → each bone's rotation relative to its parent. */
export function toLocal(W) {
  const out = new Float32Array(BONE_NAMES.length * 4);
  const worldOf = {};
  BONE_NAMES.forEach((name, i) => {
    const parent = PARENT[name];
    const parentWorld = parent ? worldOf[parent] : new THREE.Quaternion();
    const world = W[name] || parentWorld;             // ends follow their parent
    worldOf[name] = world;
    const q = local(parentWorld, world).normalize();
    out[i * 4] = q.x; out[i * 4 + 1] = q.y; out[i * 4 + 2] = q.z; out[i * 4 + 3] = q.w;
  });
  return out;
}

export function faceWeights(face, names) {
  const m = new Float32Array(FACE_SHAPES.length);
  if (!face) return m;
  const at = Object.fromEntries(names.map((n, i) => [n, i]));
  FACE_SHAPES.forEach((shape, k) => {
    let name = shape;
    if (FACE_SWAP_SIDES) name = name.replace(/Left$|Right$/, (s) => (s === 'Left' ? 'Right' : 'Left'));
    const i = at[name];
    if (i !== undefined) m[k] = THREE.MathUtils.clamp(face[i], 0, 1);
  });
  return m;
}

// --------------------------------------------------------------------------
// 4: put it on the floor
// --------------------------------------------------------------------------

/** Where each sole and palm is, and the lowest point of the body that can
 *  stand on the floor, with the hips at the origin (turned as they are). */
export function feetOf(mannequin, q) {
  const { bones, root } = mannequin;
  BONE_NAMES.forEach((name, i) => bones[name].quaternion.set(q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]));
  bones.Hips.position.set(0, 0, 0);
  root.updateMatrixWorld(true);
  let low = Infinity;
  const v = new THREE.Vector3();
  const soles = {};
  for (const s of ['Left', 'Right']) {
    for (const [bone, offset] of [['Foot', [0, -0.07, -0.05]], ['Foot', [0, -0.07, 0.1]],
                                  ['ToeBase', [0, -0.02, 0.06]]]) {
      v.set(...offset).applyMatrix4(bones[s + bone].matrixWorld);
      low = Math.min(low, v.y);
    }
    soles[s[0]] = new THREE.Vector3(0, -0.07, 0.03).applyMatrix4(bones[s + 'Foot'].matrixWorld);
    // The palm, for when the hands are on the floor - a burpee, a crawl, a
    // floor move. Nothing goes through the floor, hands included.
    const palm = new THREE.Vector3(0.05 * (s === 'Left' ? 1 : -1), -0.018, 0)
      .applyMatrix4(bones[s + 'Hand'].matrixWorld);
    soles[s[0] + 'H'] = palm;
    low = Math.min(low, palm.y);
  }
  // Upright: the chest above the hips, and the feet under them - the only
  // shape a body jumps from.
  const neck = bones.Neck.getWorldPosition(new THREE.Vector3());
  const feetMid = soles.L.clone().add(soles.R).multiplyScalar(0.5);
  const upright = neck.angleTo(Y) < THREE.MathUtils.degToRad(45) && Math.hypot(feetMid.x, feetMid.z) < 0.45;
  return { low, soles, upright };
}

/** Where the lowest point of either foot is, with the hips at the origin. */
export function lowestFoot(mannequin, q) {
  return feetOf(mannequin, q).low;
}

function median(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

/** How far the chest is tilted from upright, and how far the nose is above
 *  the ears, in every frame - the raw material for the two calibrations. */
function calibrate(S) {
  const ups = [], standing = [], pitches = [];
  const bend = (hip, knee, ankle) => knee.clone().sub(hip).angleTo(ankle.clone().sub(knee));
  S.world.forEach((w, i) => {
    if (!w) return;
    const v = S.vis[i], im = S.img[i];
    const hipsSeen = isSeen(v, im, P.lHip, 0.5) && isSeen(v, im, P.rHip, 0.5);
    const hipMid = mid(pt(w, P.lHip), pt(w, P.rHip));
    const up = hipsSeen
      ? mid(pt(w, P.lSh), pt(w, P.rSh)).sub(hipMid).normalize()
      : Y.clone();
    // Only a body that was really seen says anything about the camera.
    if (hipsSeen) ups.push(up);
    if (hipsSeen && legSeen(v, im, true) && legSeen(v, im, false)) {
      standing.push({
        up: hipMid.clone().sub(mid(pt(w, P.lAnk), pt(w, P.rAnk))).normalize(),
        bend: Math.max(bend(pt(w, P.lHip), pt(w, P.lKnee), pt(w, P.lAnk)),
          bend(pt(w, P.rHip), pt(w, P.rKnee), pt(w, P.rAnk))),
      });
    }
    const fwd = pt(w, P.nose).sub(mid(pt(w, P.lEar), pt(w, P.rEar))).normalize();
    pitches.push(Math.asin(THREE.MathUtils.clamp(-fwd.dot(up), -1, 1)));
  });
  let level = null;
  // A handful of frames is noise, not a camera.
  const enough = (list) => list.length >= Math.max(10, 0.15 * S.n);
  // The straightest third of the frames with legs in them, and only if those
  // are fairly straight: the tracker reads a standing knee as 25-35 degrees
  // bent, so "straight" has to be relative to the take.
  standing.sort((a, b) => a.bend - b.bend);
  const legUps = standing.slice(0, Math.ceil(standing.length / 3))
    .filter((f) => f.bend < THREE.MathUtils.degToRad(40)).map((f) => f.up);
  const evidence = enough(legUps) ? legUps : enough(ups) ? ups : null;
  if (evidence) {
    const m = new THREE.Vector3(median(evidence.map((u) => u.x)), median(evidence.map((u) => u.y)),
      median(evidence.map((u) => u.z))).normalize();
    if (m.angleTo(Y) < LEVEL_LIMIT) level = new THREE.Quaternion().setFromUnitVectors(m, Y);
  }
  const headPitch = THREE.MathUtils.clamp(median(pitches) || 0, -HEAD_PITCH_LIMIT, HEAD_PITCH_LIMIT);
  return { level, headPitch };
}

// The mannequin's own measurements, to turn the person's size in the
// picture into metres: hips to shoulders, and hip to ankle.
const REST = restPositions();
const TORSO_M = REST.LeftArm.clone().add(REST.RightArm).multiplyScalar(0.5)
  .distanceTo(REST.LeftUpLeg.clone().add(REST.RightUpLeg).multiplyScalar(0.5));
const LEG_M = REST.LeftUpLeg.distanceTo(REST.LeftFoot);

/**
 * The whole take, solved. `root` is 'follow' (move across the floor as the
 * person did) or 'place' (stay on the spot; jumps are kept either way).
 */
export function solve(capture, mannequin, { smoothing = 0.5, root = 'follow', hands = true, face = true } = {}) {
  const S = prepare(capture, { smoothing });
  const cal = calibrate(S);
  const W = S.width, H = S.height;

  // Pass 1: every frame's pose, and where its feet are.
  const frames = [];
  const soles = [], lows = [], upright = [];
  let found = 0, handsFound = 0, faceFound = 0;
  for (let i = 0; i < S.n; i++) {
    const w = S.world[i];
    if (w) found++;
    const hl = hands ? S.handL[i] : null, hr = hands ? S.handR[i] : null;
    if (hl || hr) handsFound++;
    if (S.face[i]) faceFound++;
    const q = w ? toLocal(aimFrame(w, S.vis[i], hl, hr, { ...cal, img: S.img[i] }))
      : (frames.length ? frames[frames.length - 1].q : toLocal({}));
    const feet = feetOf(mannequin, q);
    soles.push(feet.soles);
    lows.push(feet.low);
    upright.push(feet.upright);
    frames.push({ q, m: face ? faceWeights(S.face[i], S.faceNames) : new Float32Array(FACE_SHAPES.length) });
  }
  mannequin.reset();

  // Pass 2: the person's feet and size in the picture, and the floor's movement.
  const footPx = new Array(S.n).fill(NaN);
  const torsoPx = new Array(S.n).fill(NaN);
  const legPx = new Array(S.n).fill(NaN);
  const legsSeen = new Array(S.n).fill(false);
  const hipPx = new Array(S.n).fill(NaN);
  const floorDy = capture.frames.map((f) => (f.floor ? f.floor.dy * H : NaN));
  const floorDx = capture.frames.map((f) => (f.floor ? f.floor.dx * W : NaN));
  const hipX = new Array(S.n).fill(NaN);
  for (let i = 0; i < S.n; i++) {
    const im = S.img[i], v = S.vis[i];
    if (!im) continue;
    const px = (k) => new THREE.Vector2(im[k * 2] * W, im[k * 2 + 1] * H);
    const hipMid = px(P.lHip).add(px(P.rHip)).multiplyScalar(0.5);
    if (isSeen(v, im, P.lHip, 0.5) && isSeen(v, im, P.rHip, 0.5)) {
      torsoPx[i] = px(P.lSh).add(px(P.rSh)).multiplyScalar(0.5).distanceTo(hipMid);
      hipPx[i] = hipMid.y;
      hipX[i] = hipMid.x;
    }
    legsSeen[i] = legSeen(v, im, true) && legSeen(v, im, false);
    if (legsSeen[i]) {
      legPx[i] = Math.max(px(P.lHip).distanceTo(px(P.lAnk)), px(P.rHip).distanceTo(px(P.rAnk)));
      footPx[i] = Math.max(...[P.lHeel, P.rHeel, P.lToe, P.rToe].map((k) => im[k * 2 + 1] * H));
    }
  }
  const pxPerM = scaleAtPerson(torsoPx, legPx, TORSO_M, LEG_M, S.fps);
  const ground = findJumps(footPx, pxPerM, floorDy, S.fps, hipPx, upright);

  // Pass 3: the hips over the floor.
  const across = root === 'follow' ? travelAcross(hipX, pxPerM, floorDx, W) : null;
  const restHips = OFFSET.Hips.y;
  let takeoff = restHips;
  frames.forEach((f, i) => {
    // On the floor, the lowest point touches it. In the air, the hips are as
    // far above where they took off from as the picture says they rose -
    // never so low that a foot goes through the floor.
    const grounded = legsSeen[i] ? -lows[i] : restHips;
    if (ground.air[i] && !(i > 0 && ground.air[i - 1])) takeoff = i > 0 && legsSeen[i - 1] ? -lows[i - 1] : grounded;
    const y = ground.air[i] ? Math.max(grounded, takeoff + ground.lift[i]) : grounded;
    f.hips = [across ? across[i] : 0, y, 0];
    f.air = ground.air[i];
    f.lift = ground.lift[i];
    // Drawn over the video: under the feet while they are on it, and where it
    // was left while the person is in the air.
    const under = ground.air[i] ? ground.floorPx[i] : footPx[i];
    f.floor = Number.isFinite(under) ? under / H : null;
  });

  const scanned = capture.frames.filter((f) => f.floor).length;
  const moving = capture.frames.filter((f) => f.floor && Math.hypot(f.floor.dx, f.floor.dy) > 0.002).length;

  return {
    fps: S.fps,
    frames,
    faceNames: S.faceNames,
    faceAll: face ? S.face : S.face.map(() => null),
    jumps: ground.jumps,
    poses: S.poses,
    refined: capture.frames.some((f) => f.dw),
    rejectedJumps: ground.rejected,
    calibration: { level: cal.level ? THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(cal.level.w)))) : 0,
      headPitch: THREE.MathUtils.radToDeg(cal.headPitch) },
    stats: {
      frames: S.n,
      person: S.n ? found / S.n : 0,
      hands: S.n ? handsFound / S.n : 0,
      face: S.n ? faceFound / S.n : 0,
      legs: S.n ? legsSeen.filter(Boolean).length / S.n : 0,
      jumps: ground.jumps.length,
      // How much of the take the floor could be read in, and how much of it
      // the camera was moving. A take tracked before the floor scan has none.
      floorScanned: (capture.version || 1) >= 2 ? scanned / Math.max(1, S.n) : null,
      cameraMoving: scanned ? moving / scanned : 0,
    },
  };
}

// --------------------------------------------------------------------------
// live: one frame at a time, for the camera preview
// --------------------------------------------------------------------------

export class LiveSolver {
  constructor(smoothing = 0.5) {
    this.fs = filterSettings(smoothing);
    this.filters = {};
    this.last = 0;
  }
  smooth(key, arr, t, scale = 1) {
    if (!arr) { delete this.filters[key]; return null; }
    let f = this.filters[key];
    if (!f || f.length !== arr.length) {
      f = this.filters[key] = Array.from(arr, () => new OneEuro(this.fs.minCutoff, this.fs.beta / scale));
    }
    const dt = Math.max(1 / 120, t - this.last || 1 / 30);
    return Array.from(arr, (x, j) => f[j].step(x, dt));
  }
  /** One frame from the tracker → local rotations and face weights. */
  step(frame, t, faceNames) {
    const w = this.smooth('w', frame.pose && frame.pose.w, t);
    const hl = this.smooth('hl', frame.hands && frame.hands.L && frame.hands.L.w, t, 0.15);
    const hr = this.smooth('hr', frame.hands && frame.hands.R && frame.hands.R.w, t, 0.15);
    const face = this.smooth('f', frame.face, t);
    this.last = t;
    if (!w) return null;
    return { q: toLocal(aimFrame(w, frame.pose.v, hl, hr, { img: frame.pose.i })), m: faceWeights(face, faceNames) };
  }
}

export { BONE_INDEX };
