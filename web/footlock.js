/* Feet that stay where they are put.
 *
 * The tracker's feet tremble, and the hips are placed over the floor from the
 * picture, so a foot standing still on the floor drifts a few centimetres
 * this way and that - foot sliding, the most obvious sign of motion capture
 * that has not been cleaned up.
 *
 * So: while a foot is on the floor, it is pinned to one spot - the middle of
 * where it was over that stretch - and the leg is bent to reach it. The bend
 * is a two-bone solve (hip, knee, ankle): the thigh and shin keep their
 * lengths, the knee stays on the side it was pointing, and the foot keeps the
 * angle it had. A pin eases in and out over a few frames, so a step never
 * snaps.
 *
 * Only across the floor: how high the foot is, is already right - the floor
 * pass put the lowest point on it.
 */

import * as THREE from 'three';
import { BONES } from './mannequin.js';

const BONE_NAMES = BONES.map((b) => b[0]);      // the same order solve.js keys them in

const TOUCHING = 0.035;     // metres above the floor that count as standing on it
const SHORTEST = 4;         // frames: a touch shorter than this is passing through
const EASE = 3;             // frames to ease a pin in and out

const INDEX = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));

function setPose(man, f) {
  BONE_NAMES.forEach((n, i) => man.bones[n].quaternion.fromArray(f.q, i * 4));
  man.bones.Hips.position.fromArray(f.hips);
  man.root.updateMatrixWorld(true);
}

const pos = (bone) => bone.getWorldPosition(new THREE.Vector3());
const rot = (bone) => bone.getWorldQuaternion(new THREE.Quaternion());

/**
 * Pin planted feet in `frames` (changes their leg rotations in place).
 * Returns how many frames had a foot pinned.
 */
export function lockFeet(man, frames, { air, legsSeen }) {
  const n = frames.length;
  const sides = ['Left', 'Right'];

  // Where each ankle is, and whether that foot is on the floor.
  const ankle = { Left: [], Right: [] }, down = { Left: [], Right: [] };
  frames.forEach((f, i) => {
    setPose(man, f);
    for (const s of sides) {
      const foot = man.bones[s + 'Foot'];
      ankle[s].push(pos(foot));
      // Its lowest point - heel, ball or toe. The tracker tilts feet, so the
      // middle of the sole is often a few centimetres up while the heel is
      // down; judging by it found a foot planted in one frame in six.
      const lowest = Math.min(
        new THREE.Vector3(0, -0.07, -0.05).applyMatrix4(foot.matrixWorld).y,
        new THREE.Vector3(0, -0.07, 0.1).applyMatrix4(foot.matrixWorld).y,
        new THREE.Vector3(0, -0.02, 0.06).applyMatrix4(man.bones[s + 'ToeBase'].matrixWorld).y);
      down[s].push(!!legsSeen[i] && !air[i] && lowest < TOUCHING);
    }
  });

  // Stretches on the floor, and the spot each is pinned to.
  const pin = { Left: new Array(n).fill(null), Right: new Array(n).fill(null) };
  for (const s of sides) {
    for (let i = 0; i < n; i++) {
      if (!down[s][i]) continue;
      let j = i;
      while (j + 1 < n && down[s][j + 1]) j++;
      if (j - i + 1 >= SHORTEST) {
        const xs = [], zs = [];
        for (let k = i; k <= j; k++) { xs.push(ankle[s][k].x); zs.push(ankle[s][k].z); }
        const mid = (a) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
        const spot = [mid(xs), mid(zs)];
        for (let k = i; k <= j; k++) {
          const weight = Math.min(1, (k - i + 1) / EASE, (j - k + 1) / EASE);
          pin[s][k] = { x: spot[0], z: spot[1], weight };
        }
      }
      i = j;
    }
  }

  let pinned = 0;
  frames.forEach((f, i) => {
    if (!pin.Left[i] && !pin.Right[i]) return;
    pinned++;
    setPose(man, f);
    for (const s of sides) {
      const p = pin[s][i];
      if (!p) continue;
      const hipB = man.bones[s + 'UpLeg'], kneeB = man.bones[s + 'Leg'], footB = man.bones[s + 'Foot'];
      const A = pos(hipB), B = pos(kneeB), C = pos(footB);
      const target = new THREE.Vector3(
        C.x + (p.x - C.x) * p.weight, C.y, C.z + (p.z - C.z) * p.weight);
      if (target.distanceTo(C) < 1e-4) continue;

      // Two bones: where the knee goes so the ankle reaches the target.
      const l1 = A.distanceTo(B), l2 = B.distanceTo(C);
      const toT = target.clone().sub(A);
      const d = Math.min(toT.length(), (l1 + l2) * 0.999);
      const dir = toT.normalize();
      const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
      // The knee stays on the side it was pointing.
      const bend = B.clone().sub(A);
      bend.addScaledVector(dir, -bend.dot(dir));
      if (bend.lengthSq() < 1e-8) bend.set(0, 0, 1).applyQuaternion(rot(man.bones.Hips));
      bend.normalize();
      const knee = A.clone().addScaledVector(dir, a).addScaledVector(bend, h);
      const reach = A.clone().addScaledVector(dir, d);

      const footWorld = rot(footB);
      const turnThigh = new THREE.Quaternion().setFromUnitVectors(
        B.clone().sub(A).normalize(), knee.clone().sub(A).normalize());
      const thighWorld = turnThigh.clone().multiply(rot(hipB));
      const shinBefore = C.clone().sub(B).applyQuaternion(turnThigh).normalize();
      const shinWorld = new THREE.Quaternion()
        .setFromUnitVectors(shinBefore, reach.clone().sub(knee).normalize())
        .multiply(turnThigh.clone().multiply(rot(kneeB)));

      // Back to rotations relative to each parent; the foot keeps its angle.
      const hipsWorld = rot(man.bones.Hips);
      const local = {
        [s + 'UpLeg']: hipsWorld.clone().invert().multiply(thighWorld),
        [s + 'Leg']: thighWorld.clone().invert().multiply(shinWorld),
        [s + 'Foot']: shinWorld.clone().invert().multiply(footWorld),
      };
      for (const [name, q] of Object.entries(local)) {
        q.normalize();
        f.q[INDEX[name] * 4] = q.x; f.q[INDEX[name] * 4 + 1] = q.y;
        f.q[INDEX[name] * 4 + 2] = q.z; f.q[INDEX[name] * 4 + 3] = q.w;
        man.bones[name].quaternion.copy(q);
      }
      man.root.updateMatrixWorld(true);
    }
  });
  man.reset();
  return pinned;
}
