/* The virtual floor.
 *
 * Two questions the picture alone answers badly once the camera moves:
 *
 *   Is the person in the air?   Feet rising in the picture could be a jump, or
 *                               the camera dipping or moving in.
 *   Where have they gone?       Hips sliding across the picture could be the
 *                               person walking, or the camera turning.
 *
 * So neither is answered from the picture directly.
 *
 * In the air: the floor is a line under the feet, carried from frame to frame.
 * While a foot is down, the floor is wherever that foot is. Between frames it
 * moves only as the floor itself was seen to move (floor.js) - which is the
 * camera - and it may creep upward only slowly, so a camera drifting is
 * followed while a jump is not. When both feet rise clear of that line it is
 * a candidate jump, and it is kept only if it looks like one: off the floor
 * for between a tenth of a second and a second, high enough to be more than
 * the tracker's wobble, highest somewhere in the middle, back down at the
 * end - and two things only a real jump does:
 *
 *   the hips go up            a jump is measured by the hips, not the feet.
 *                             Feet the tracker loses under wide trousers
 *                             flicker upward on their own; the hips do not.
 *                             And a tuck jump pulls the feet up to the hips -
 *                             97 cm of feet for 43 cm of jump.
 *   gravity                   time in the air fixes the height: up and down
 *                             in T seconds is g·T²/8 high. Half a second is
 *                             30 cm; a whole second is 1.2 m, so a "jump" of
 *                             a second and 15 cm is not one.
 *   upright                   chest over hips, feet under them. With the
 *                             camera low, feet kicked back into a plank move
 *                             UP the picture as they move away, hips too, and
 *                             the timing can even fit gravity - a burpee read
 *                             as a 45 cm leap. (So flips do not count.)
 *
 * Anything else was the camera or the tracker, and the feet stay on the floor.
 * (Found on a dance video on 2026-10-05: six "jumps" with both feet down.)
 *
 * Travel: a foot standing on the floor does not slide. So while a foot is
 * planted, however it moves relative to the hips is the hips moving the other
 * way over the floor. That uses the skeleton only - never the picture - so a
 * moving camera cannot add travel, and walking toward the camera is caught as
 * well as walking across it.
 */

const CONTACT = 0.035;      // metres above the floor that still count as touching it
const CREEP = 0.12;         // metres a second the floor may rise without a jump
const MIN_AIR = 0.1;        // seconds: shorter than this is a stumble in the tracking
const MAX_AIR = 1.0;        // seconds: longer than this is not a jump, it is the camera
const MIN_HEIGHT = 0.06;    // metres a jump must clear to be one
const PLANTED = 0.03;       // metres: a foot this close to the lower one is standing
const G = 9.81;
const GRAVITY_SLACK = [0.4, 2.5];   // measured height against g·T²/8: the tracker trims the ends

function rollingMedian(xs, half) {
  return xs.map((_, i) => {
    const w = [];
    for (let k = Math.max(0, i - half); k <= Math.min(xs.length - 1, i + half); k++) {
      if (Number.isFinite(xs[k])) w.push(xs[k]);
    }
    w.sort((a, b) => a - b);
    return w.length ? w[Math.floor(w.length / 2)] : NaN;
  });
}

/**
 * When the person is in the air, and how high.
 *
 *   footPx[i]    lowest point of the feet in the picture, pixels down (NaN if unseen)
 *   pxPerM[i]    how many pixels a metre is at the person, this frame
 *   floorDy[i]   how far the floor near the feet moved down since the last frame, pixels
 *   hipPx[i]     the hips' height in the picture, pixels down (NaN if unseen)
 *   upright[i]   whether the body is in a shape that can jump
 *
 * Returns per frame { air, lift (metres the hips are above where they took
 * off), floorPx } and the jumps found.
 */
export function findJumps(footPx, pxPerM, floorDy, fps, hipPx = [], upright = []) {
  const n = footPx.length;
  const lift = new Array(n).fill(0);
  const floorPx = new Array(n).fill(NaN);
  const candidate = new Array(n).fill(false);
  const creep = CREEP / fps;

  let floor = NaN;
  let runStart = -1;
  for (let i = 0; i < n; i++) {
    const moved = Number.isFinite(floorDy[i]) ? floorDy[i] : 0;
    if (!Number.isFinite(footPx[i]) || !Number.isFinite(pxPerM[i])) {
      if (Number.isFinite(floor)) floor += moved;
      runStart = -1;
      continue;
    }
    if (!Number.isFinite(floor)) floor = footPx[i];
    const predicted = floor + moved;
    if (footPx[i] >= predicted) {
      floor = footPx[i];                             // a foot below the floor: the floor is lower
    } else if (runStart >= 0) {
      floor = predicted;                             // mid-jump the floor holds still
    } else {
      floor = predicted - Math.min(predicted - footPx[i], creep * pxPerM[i]);
    }
    const up = (floor - footPx[i]) / pxPerM[i];
    if (up > CONTACT) {
      if (runStart < 0) runStart = i;
      // Off the floor for longer than any jump: the floor was wrong. Start it
      // again from the feet.
      if ((i - runStart) / fps > MAX_AIR) { floor = footPx[i]; floorPx[i] = floor; runStart = -1; continue; }
      candidate[i] = true;
      lift[i] = up;
    } else {
      runStart = -1;
    }
    floorPx[i] = floor;
  }

  // Keep the runs that look like jumps.
  const air = new Array(n).fill(false);
  const jumps = [], rejected = [];
  for (let i = 0; i < n; i++) {
    if (!candidate[i]) continue;
    let j = i;
    while (j + 1 < n && candidate[j + 1]) j++;
    const seconds = (j - i + 1) / fps;
    const landed = j + 1 < n && Number.isFinite(footPx[j + 1]);
    const tookOff = i > 0 && Number.isFinite(footPx[i - 1]);

    // The height of a jump is how far the hips rose - not the feet, which a
    // tuck jump pulls up to the hips. Measured above the floor as it was at
    // take-off, against where the hips were just before.
    const hipsUp = (k) => (floorPx[k] - hipPx[k]) / pxPerM[k];
    const before = [];
    for (let k = Math.max(0, i - 3); k < i; k++) if (Number.isFinite(hipsUp(k))) before.push(hipsUp(k));
    const base = before.length ? before.reduce((x, y) => x + y, 0) / before.length : NaN;
    const rise = [];
    let peak = -1;
    for (let k = i; k <= j; k++) {
      const r = Number.isFinite(base) && Number.isFinite(hipsUp(k)) ? Math.max(0, hipsUp(k) - base) : 0;
      rise.push(r);
      if (peak < 0 || r > rise[peak - i]) peak = k;
    }
    const height = rise[peak - i];
    const shaped = j === i || (peak > i && peak < j);
    // Gravity: the ends of a jump are where the tracker is least sure, so the
    // flight is taken as the run plus a frame.
    const flight = seconds + 1 / fps;
    const ballistic = height / ((G * flight * flight) / 8);
    let tall = 0;
    for (let k = Math.max(0, i - 1); k <= j; k++) if (upright[k] !== false) tall++;
    const stood = tall >= 0.8 * (j - Math.max(0, i - 1) + 1);

    if (seconds >= MIN_AIR && seconds <= MAX_AIR && height >= MIN_HEIGHT
        && landed && tookOff && shaped && stood
        && ballistic >= GRAVITY_SLACK[0] && ballistic <= GRAVITY_SLACK[1]) {
      for (let k = i; k <= j; k++) { air[k] = true; lift[k] = rise[k - i]; }
      jumps.push({ from: i, to: j, height });
    } else if (seconds >= MIN_AIR) {
      rejected.push({ from: i, to: j, height, ballistic,
        why: !stood ? 'not upright - a floor move' : height < MIN_HEIGHT ? 'the hips stayed down'
          : seconds > MAX_AIR ? 'too long in the air' : 'not how gravity works' });
    }
    i = j;
  }
  for (let i = 0; i < n; i++) if (!air[i]) lift[i] = 0;
  return { air, lift, floorPx, jumps, rejected };
}

/**
 * How far the person has moved across the floor, sideways, in metres.
 *
 *   hipX[i]      the hips across the picture, pixels (NaN if unseen)
 *   pxPerM[i]    how many pixels a metre is at the person, this frame
 *   floorDx[i]   how far the floor moved right since the last frame, pixels
 *
 * Measured from the middle of the picture and in this frame's own metres, so
 * a camera moving in or out - which spreads everything away from the middle -
 * does not read as the person moving; and with the floor's own sideways
 * movement taken off, so a camera turning does not either.
 *
 * (Travel from the feet - a planted foot does not slide, so the body moves by
 * however the foot moves under it - was tried first and dropped on
 * 2026-10-05: dancing slides and pivots on purpose, and in a burpee the
 * hands take over from the feet under the body where the tracker sees them
 * worst. It walked a man doing burpees on the spot most of a metre.)
 */
export function travelAcross(hipX, pxPerM, floorDx, width) {
  let shift = 0, start = NaN, last = 0;
  return hipX.map((x, i) => {
    if (Number.isFinite(floorDx[i])) shift += floorDx[i];
    if (!Number.isFinite(x) || !Number.isFinite(pxPerM[i])) return last;
    const metres = (x - width / 2 - shift) / pxPerM[i];
    if (!Number.isFinite(start)) start = metres;
    last = metres - start;
    return last;
  });
}

/** Pixels per metre at the person, frame by frame, steadied over half a second. */
export function scaleAtPerson(torsoPx, legPx, torsoM, legM, fps) {
  // A body bending away shortens in the picture, so whichever of the torso
  // and the legs is longer (less foreshortened) gives the truer scale.
  const raw = torsoPx.map((t, i) => {
    const a = Number.isFinite(t) ? t / torsoM : NaN;
    const b = Number.isFinite(legPx[i]) ? legPx[i] / legM : NaN;
    return Number.isFinite(a) && Number.isFinite(b) ? Math.max(a, b) : Number.isFinite(a) ? a : b;
  });
  const steady = rollingMedian(raw, Math.round(fps / 2));
  const all = raw.filter(Number.isFinite).sort((a, b) => a - b);
  const fallback = all.length ? all[Math.floor(all.length / 2)] : NaN;
  return steady.map((v) => (Number.isFinite(v) ? v : fallback));
}
