/* Putting DWPose's flat points back into 3D.
 *
 * DWPose says where a knee is in the picture, more reliably than MediaPipe
 * does under wide trousers - but only across and down, never how far from
 * the camera. MediaPipe gives all three, less reliably. So each limb is
 * rebuilt from the body outward, a bone at a time, using what each is good
 * at:
 *
 *   across and down   DWPose: the child joint's offset from its parent in the
 *                     picture, turned into metres by how big the person is
 *                     in this frame
 *   the bone's length MediaPipe, but its middle value over the whole take -
 *                     a thigh is the same length in every frame, even when
 *                     a single frame's estimate wobbles
 *   toward or away    whatever length is left over goes into depth, on the
 *                     side MediaPipe says the joint is (in front of its
 *                     parent, or behind)
 *
 * The torso - shoulders and hips - stays MediaPipe's, which tracks it well.
 * A joint DWPose was unsure of keeps MediaPipe's own direction from its
 * parent, so a limb is never torn between the two.
 */

// MediaPipe's point ← DWPose's point(s). The two toe points are averaged to
// make MediaPipe's single "foot index", which sits between them.
const FROM_DW = {
  11: [5], 12: [6], 13: [7], 14: [8], 15: [9], 16: [10],
  23: [11], 24: [12], 25: [13], 26: [14], 27: [15], 28: [16],
  29: [19], 30: [22], 31: [17, 18], 32: [20, 21],
};

// Rebuilt from the body outward: [parent, child].
const BONES = [
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [27, 29], [27, 31],
  [24, 26], [26, 28], [28, 30], [28, 32],
];
const TORSO = [11, 12, 23, 24];

const SURE = 0.35;

function median(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

const sub3 = (w, a, b) => [w[a * 3] - w[b * 3], w[a * 3 + 1] - w[b * 3 + 1], w[a * 3 + 2] - w[b * 3 + 2]];
const len3 = (v) => Math.hypot(v[0], v[1], v[2]);

/**
 * Every frame's pose with DWPose's points folded in, or the capture's own
 * poses unchanged when it was not refined. Returns [{ w, i, v }] per frame.
 */
export function fuse(capture) {
  const F = capture.frames;
  if (!F.some((f) => f.dw)) return F.map((f) => f.pose);
  const W = capture.width, H = capture.height;

  // Each bone's length over the take, as MediaPipe measures it.
  const length = {};
  for (const [a, b] of BONES) {
    length[`${a}-${b}`] = median(F.map((f) => (f.pose ? len3(sub3(f.pose.w, b, a)) : NaN)));
  }

  // Pixels per MediaPipe metre in each frame: the torso's length in the
  // picture against its length in 3D, steadied over half a second.
  const raw = F.map((f) => {
    if (!f.pose) return NaN;
    const I = f.pose.i, w = f.pose.w;
    const mid = (a, b) => [(I[a * 2] + I[b * 2]) / 2 * W, (I[a * 2 + 1] + I[b * 2 + 1]) / 2 * H];
    const s = mid(11, 12), h = mid(23, 24);
    const px = Math.hypot(s[0] - h[0], s[1] - h[1]);
    const m = len3([(w[33] + w[36] - w[69] - w[72]) / 2, (w[34] + w[37] - w[70] - w[73]) / 2,
      (w[35] + w[38] - w[71] - w[74]) / 2]);
    return m > 0.05 ? px / m : NaN;
  });
  const half = Math.round(capture.fps / 2);
  const scale = raw.map((_, i) => median(raw.slice(Math.max(0, i - half), i + half + 1)));
  const fallback = median(raw);

  return F.map((f, n) => {
    if (!f.pose) return null;
    if (!f.dw) return f.pose;
    const i = f.pose.i.slice(), w = f.pose.w.slice(), v = f.pose.v.slice();
    const sure = {};
    for (const [mp, dws] of Object.entries(FROM_DW)) {
      const s = Math.min(...dws.map((d) => f.dw.s[d]));
      if (!(s > SURE)) continue;
      i[mp * 2] = dws.reduce((t, d) => t + f.dw.i[d * 2], 0) / dws.length;
      i[mp * 2 + 1] = dws.reduce((t, d) => t + f.dw.i[d * 2 + 1], 0) / dws.length;
      v[mp] = Math.max(v[mp], s);
      sure[mp] = true;
    }
    const pxPerM = Number.isFinite(scale[n]) ? scale[n] : fallback;
    if (!Number.isFinite(pxPerM)) return { w, i, v };

    // The torso is MediaPipe's; everything hanging from it is rebuilt.
    for (const [a, b] of BONES) {
      const L = length[`${a}-${b}`];
      const before = sub3(f.pose.w, b, a);            // MediaPipe's own bone
      let d;
      if (sure[a] || TORSO.includes(a)) {
        if (sure[b] && Number.isFinite(L)) {
          let dx = ((i[b * 2] - i[a * 2]) * W) / pxPerM;
          let dy = ((i[b * 2 + 1] - i[a * 2 + 1]) * H) / pxPerM;
          const flat = Math.hypot(dx, dy);
          let dz = 0;
          if (flat > L) { dx *= L / flat; dy *= L / flat; } else {
            dz = Math.sign(before[2] || 1) * Math.sqrt(L * L - flat * flat);
          }
          d = [dx, dy, dz];
        } else {
          d = before;
        }
      } else {
        d = before;
      }
      w[b * 3] = w[a * 3] + d[0];
      w[b * 3 + 1] = w[a * 3 + 1] + d[1];
      w[b * 3 + 2] = w[a * 3 + 2] + d[2];
    }
    return { w, i, v };
  });
}
