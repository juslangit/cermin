/* Finding the person, frame by frame.
 *
 * MediaPipe, running in this page: one model for the body (33 points), one
 * for hands (21 points each), one for the face (52 expression values). The
 * models live in web/models/ and the engine in web/vendor/, so after the
 * first load nothing is fetched from anywhere - a take never leaves the Mac.
 *
 * A video is walked one frame at a time by seeking, not by playing it: playing
 * drops frames whenever the trackers fall behind, and a capture with holes in
 * it is worse than one that took longer.
 *
 * What comes out is the raw capture - the points as seen, before smoothing,
 * and how the floor near the feet moved (floor.js) - which is what gets
 * saved. Smoothing and solving happen afterwards, in solve.js, so that
 * changing them never means tracking the video again.
 */

import { FilesetResolver, PoseLandmarker, HandLandmarker, FaceLandmarker }
  from './vendor/mediapipe/vision_bundle.mjs';
import { FloorScan } from './floor.js';

const WASM = '/web/vendor/mediapipe/wasm';
const MODELS = {
  poseAccurate: '/web/models/pose_landmarker_heavy.task',
  poseFast: '/web/models/pose_landmarker_full.task',
  hand: '/web/models/hand_landmarker.task',
  face: '/web/models/face_landmarker.task',
};

let fileset = null;

async function make(Kind, model, extra) {
  fileset = fileset || await FilesetResolver.forVisionTasks(WASM);
  // The graphics card when the browser allows it, the processor when not -
  // slower, but a capture that works beats one that refuses to start.
  for (const delegate of ['GPU', 'CPU']) {
    try {
      return await Kind.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: model, delegate },
        runningMode: 'VIDEO',
        ...extra,
      });
    } catch (err) {
      if (delegate === 'CPU') throw err;
      console.warn(`cermin: ${Kind.name} on the GPU failed, using the CPU`, err);
    }
  }
}

/** A set of trackers. `accurate` picks the heavy body model, for files. */
export async function trackers({ accurate = true, hands = true, face = true } = {}) {
  const [pose, hand, faceLm] = await Promise.all([
    make(PoseLandmarker, accurate ? MODELS.poseAccurate : MODELS.poseFast, {
      numPoses: 1, minPoseDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
    }),
    hands ? make(HandLandmarker, MODELS.hand, {
      numHands: 2, minHandDetectionConfidence: 0.4, minTrackingConfidence: 0.4,
    }) : null,
    face ? make(FaceLandmarker, MODELS.face, {
      numFaces: 1, outputFaceBlendshapes: true,
    }) : null,
  ]);
  // Each tracker needs its timestamps to keep rising, across videos too.
  return { pose, hand, face: faceLm, clock: 0, faceNames: null };
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** Run every tracker on whatever the video is showing now. */
export function detect(T, source, timestamp) {
  const ts = Math.max(T.clock + 1, Math.round(timestamp));
  T.clock = ts;
  const frame = { pose: null, hands: null, face: null };

  const p = T.pose.detectForVideo(source, ts);
  if (p.landmarks && p.landmarks.length) {
    const img = p.landmarks[0], world = p.worldLandmarks[0];
    frame.pose = {
      w: world.flatMap((l) => [r4(l.x), r4(l.y), r4(l.z)]),
      i: img.flatMap((l) => [r4(l.x), r4(l.y)]),
      v: img.map((l) => r4(l.visibility ?? 1)),
    };
  }

  if (T.hand && frame.pose) {
    const h = T.hand.detectForVideo(source, ts);
    frame.hands = assignHands(h, frame.pose);
  }

  if (T.face) {
    const f = T.face.detectForVideo(source, ts);
    const cats = f.faceBlendshapes && f.faceBlendshapes[0] && f.faceBlendshapes[0].categories;
    if (cats) {
      T.faceNames = T.faceNames || cats.map((c) => c.categoryName);
      frame.face = cats.map((c) => r4(c.score));
    }
  }
  return frame;
}

/* The hand tracker's own "left" and "right" guess assumes a mirrored selfie
 * picture, and is wrong as often as not on an ordinary video. So each hand is
 * given to whichever of the body's wrists it is nearest in the picture -
 * which is never confused about whose arm it is on. */
function assignHands(h, pose) {
  if (!h.landmarks || !h.landmarks.length) return null;
  const wrist = (k) => [pose.i[k * 2], pose.i[k * 2 + 1]];
  const lw = wrist(15), rw = wrist(16);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const out = {};
  const best = {};
  h.landmarks.forEach((lm, n) => {
    const at = [lm[0].x, lm[0].y];
    const side = d(at, lw) <= d(at, rw) ? 'L' : 'R';
    const dist = d(at, side === 'L' ? lw : rw);
    if (dist > 0.2) return;                         // someone else's hand
    if (best[side] !== undefined && best[side] < dist) return;
    best[side] = dist;
    out[side] = {
      w: h.worldLandmarks[n].flatMap((l) => [r4(l.x), r4(l.y), r4(l.z)]),
      i: lm.flatMap((l) => [r4(l.x), r4(l.y)]),
    };
  });
  return Object.keys(out).length ? out : null;
}

function once(el, event, ms = 3000) {
  return new Promise((resolve) => {
    const done = () => { el.removeEventListener(event, done); clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, ms);
    el.addEventListener(event, done);
  });
}

/** A recorded .webm says its length is Infinity until it has been read to the end. */
export async function settleDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  video.currentTime = 1e9;
  await once(video, 'durationchange', 4000);
  video.currentTime = 0;
  await once(video, 'seeked', 2000);
  return video.duration;
}

/**
 * Track a whole video, one frame at a time.
 * onProgress(done, total, frame) is called after every frame.
 */
export async function trackVideo(T, video, { fps = 30, onProgress, cancelled, refiner = null } = {}) {
  const duration = await settleDuration(video);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('That video has no length the browser can read.');
  video.pause();
  const total = Math.max(1, Math.floor(duration * fps));
  T.clock += 10000;                                   // a new video: no memory of the last
  const start = T.clock;
  const frames = [];
  const floor = new FloorScan(video);
  for (let n = 0; n < total; n++) {
    if (cancelled && cancelled()) throw new Error('cancelled');
    const t = Math.min(duration - 0.001, n / fps + 0.0005);
    video.currentTime = t;
    await once(video, 'seeked');
    const frame = detect(T, video, start + (n * 1000) / fps);
    frame.t = r4(t);
    frame.floor = floor.step(video, frame.pose);
    // The second, closer look (refine.js): DWPose's points for legs and feet.
    if (refiner && frame.pose) frame.dw = await refiner.run(video, frame.pose);
    frames.push(frame);
    if (onProgress) onProgress(n + 1, total, frame);
    if (n % 4 === 3) await new Promise((r) => setTimeout(r, 0));   // let the page draw
  }
  return {
    version: 3,                 // 2: the floor's movement; 3: DWPose's points, when refined
    fps,
    width: video.videoWidth,
    height: video.videoHeight,
    duration,
    faceNames: T.faceNames || [],
    frames,
  };
}

// --------------------------------------------------------------------------
// drawing what was found over the picture
// --------------------------------------------------------------------------

const BODY_LINES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24],
  [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [27, 31],
  [28, 30], [30, 32], [28, 32], [0, 7], [0, 8]];
const HAND_LINES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9],
  [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17],
  [17, 18], [18, 19], [19, 20]];

export function drawOverlay(ctx, frame, w, h, accent = '#f5a524', ground = null) {
  ctx.clearRect(0, 0, w, h);
  if (!frame || !frame.pose) return;
  if (ground && ground.floor !== null && ground.floor !== undefined) drawFloor(ctx, frame, w, h, ground);
  const I = frame.pose.i, V = frame.pose.v;
  const at = (k) => [I[k * 2] * w, I[k * 2 + 1] * h];

  // The box: where cermin thinks the person is.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < 33; k++) {
    if (V[k] < 0.4) continue;
    const [x, y] = at(k);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const pad = 0.06 * (y1 - y0);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x0 - pad, y0 - pad * 1.6, x1 - x0 + pad * 2, y1 - y0 + pad * 2.6);
  ctx.setLineDash([]);

  ctx.lineWidth = Math.max(2, w / 320);
  ctx.strokeStyle = accent;
  ctx.beginPath();
  for (const [a, b] of BODY_LINES) {
    if (V[a] < 0.4 || V[b] < 0.4) continue;
    ctx.moveTo(...at(a)); ctx.lineTo(...at(b));
  }
  ctx.stroke();
  ctx.fillStyle = '#fff';
  for (let k = 0; k < 33; k++) {
    if (V[k] < 0.4 || (k > 0 && k < 11)) continue;
    ctx.beginPath(); ctx.arc(...at(k), Math.max(2.5, w / 260), 0, Math.PI * 2); ctx.fill();
  }

  if (frame.hands) {
    ctx.strokeStyle = '#4ea3f5';
    ctx.lineWidth = Math.max(1.5, w / 480);
    for (const side of ['L', 'R']) {
      const hd = frame.hands[side];
      if (!hd) continue;
      const hp = (k) => [hd.i[k * 2] * w, hd.i[k * 2 + 1] * h];
      ctx.beginPath();
      for (const [a, b] of HAND_LINES) { ctx.moveTo(...hp(a)); ctx.lineTo(...hp(b)); }
      ctx.stroke();
    }
  }
}

/* The virtual floor under the feet: solid while they are on it, and while
 * the person is in the air a dashed line with the gap marked. */
function drawFloor(ctx, frame, w, h, ground) {
  const I = frame.pose.i;
  const xs = [27, 28, 29, 30, 31, 32].map((k) => I[k * 2] * w);
  const feetY = Math.max(...[29, 30, 31, 32].map((k) => I[k * 2 + 1] * h));
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  const half = Math.max(w * 0.09, (Math.max(...xs) - Math.min(...xs)) * 0.9);
  const y = ground.floor * h;
  ctx.save();
  ctx.lineWidth = Math.max(2, w / 300);
  ctx.strokeStyle = '#3fd0c9';
  ctx.fillStyle = 'rgba(63,208,201,0.16)';
  ctx.beginPath();
  ctx.ellipse(mid, y, half, half * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
  if (ground.air) ctx.setLineDash([8, 6]);
  ctx.stroke();
  if (ground.air) {
    ctx.beginPath();
    ctx.moveTo(mid, y);
    ctx.lineTo(mid, feetY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `600 ${Math.max(12, Math.round(w / 45))}px ui-sans-serif, -apple-system, system-ui`;
    ctx.fillStyle = '#3fd0c9';
    ctx.fillText('in the air', mid + 8, (y + feetY) / 2);
  }
  ctx.restore();
}
