/* Scanning the floor.
 *
 * A camera that moves makes everything in the picture move, and from the
 * person alone there is no telling the two apart: feet rising in the picture
 * could be a jump, or the camera dipping. The floor settles it. Floor does not
 * jump, so however the floor moves in the picture is the camera.
 *
 * Every frame, a few patches of floor are taken beside and just below the
 * person's feet - where the floor is at the person's own distance from the
 * camera, so a camera moving in or out moves them the same way it moves the
 * feet - and each is found again in the next frame by sliding it around until
 * it matches. The middle of their answers is how far the floor moved there.
 *
 * Patches with no texture (a plain painted floor) say nothing, and are
 * dropped rather than trusted; a frame where none can be read records no
 * floor movement, and the solver falls back to judging jumps by their shape.
 */

const WIDTH = 256;          // the picture is matched this wide
const PATCH_W = 36, PATCH_H = 14;
const REACH = 14;           // how far a patch is searched for, in matching pixels

export class FloorScan {
  constructor(video) {
    this.w = WIDTH;
    this.h = Math.max(32, Math.round((WIDTH * video.videoHeight) / Math.max(1, video.videoWidth)));
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null;
    this.prevPose = null;
  }

  grey(video) {
    this.ctx.drawImage(video, 0, 0, this.w, this.h);
    const rgba = this.ctx.getImageData(0, 0, this.w, this.h).data;
    const g = new Uint8Array(this.w * this.h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) {
      g[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    }
    return g;
  }

  /** Where to look: patches of floor beside and below the feet, clear of the person. */
  patches(pose) {
    const { w, h } = this;
    let feetY = 0.92, left = 0.4, right = 0.6, feetX = 0.5;
    if (pose) {
      const I = pose.i, V = pose.v;
      const xs = [], ys = [];
      for (let k = 0; k < 33; k++) {
        const x = I[k * 2], y = I[k * 2 + 1];
        if (V[k] > 0.3 && x > 0 && x < 1 && y > 0 && y < 1) { xs.push(x); ys.push(y); }
      }
      const feet = [27, 28, 29, 30, 31, 32].filter((k) => I[k * 2 + 1] > 0 && I[k * 2 + 1] < 1);
      if (xs.length > 4 && feet.length) {
        left = Math.min(...xs) - 0.03;
        right = Math.max(...xs) + 0.03;
        feetY = Math.max(...feet.map((k) => I[k * 2 + 1]));
        feetX = feet.reduce((s, k) => s + I[k * 2], 0) / feet.length;
      }
    }
    const pw = PATCH_W / w, ph = PATCH_H / h;
    const y = Math.min(feetY + ph * 0.3, 1 - ph / 2 - REACH / h);
    const spots = [
      [left - pw * 0.6, y], [left - pw * 1.8, y],
      [right + pw * 0.6, y], [right + pw * 1.8, y],
      [feetX, feetY + ph * 1.6],                         // just in front of the feet
    ];
    const sides = ['left', 'left', 'right', 'right', 'front'];
    return spots
      .map(([cx, cy], k) => [Math.round(cx * w - PATCH_W / 2), Math.round(cy * h - PATCH_H / 2), sides[k]])
      .filter(([x0, y0]) => x0 >= REACH && y0 >= REACH
        && x0 + PATCH_W + REACH <= w && y0 + PATCH_H + REACH <= h);
  }

  /** Find one patch of the last frame again in this one. → [dx, dy] or null. */
  match(prev, cur, x0, y0) {
    const { w } = this;
    let sum = 0, sum2 = 0;
    for (let y = 0; y < PATCH_H; y++) {
      for (let x = 0; x < PATCH_W; x++) {
        const v = prev[(y0 + y) * w + x0 + x];
        sum += v; sum2 += v * v;
      }
    }
    const n = PATCH_W * PATCH_H;
    const spread = Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2));
    if (spread < 5) return null;                        // nothing to hold on to

    // Every placement is scored in full: the spread of scores is what says
    // whether the best one stands out or the floor simply looks the same
    // everywhere.
    const side = REACH * 2 + 1;
    const grid = new Float64Array(side * side);
    let best = Infinity, bx = 0, by = 0;
    for (let dy = -REACH; dy <= REACH; dy++) {
      for (let dx = -REACH; dx <= REACH; dx++) {
        let c = 0;
        for (let y = 0; y < PATCH_H; y++) {
          const a = (y0 + y) * w + x0, b = (y0 + y + dy) * w + x0 + dx;
          for (let x = 0; x < PATCH_W; x++) c += Math.abs(prev[a + x] - cur[b + x]);
        }
        grid[(dy + REACH) * side + dx + REACH] = c;
        if (c < best) { best = c; bx = dx; by = dy; }
      }
    }
    const sorted = Float64Array.from(grid).sort();
    const typical = sorted[Math.floor(sorted.length / 2)];
    if (best / n > 18 || best > typical * 0.6) return null;
    if (Math.abs(bx) === REACH || Math.abs(by) === REACH) return null;   // ran off the edge

    // Between pixels: a parabola through the best score and its neighbours.
    // A camera drifting a third of a pixel a frame would otherwise read as
    // not moving at all, and those thirds add up.
    const at = (dx, dy) => grid[(dy + REACH) * side + dx + REACH];
    const vertex = (l, c, r) => { const d = l - 2 * c + r; return d > 0 ? (l - r) / (2 * d) : 0; };
    return [bx + vertex(at(bx - 1, by), best, at(bx + 1, by)),
      by + vertex(at(bx, by - 1), best, at(bx, by + 1))];
  }

  /**
   * How the floor near the feet moved since the last frame, as a fraction of
   * the picture's width and height, or null if no patch could be read.
   */
  step(video, pose) {
    const cur = this.grey(video);
    let out = null;
    if (this.prev) {
      const moves = this.patches(this.prevPose)
        .map(([x0, y0, side]) => {
          const m = this.match(this.prev, cur, x0, y0);
          return m && { dx: m[0], dy: m[1], side, x: x0 + PATCH_W / 2 };
        })
        .filter(Boolean);
      if (moves.length) {
        const mid = (a) => a.slice().sort((p, q) => p - q)[Math.floor(a.length / 2)];
        // Sideways, what is wanted is the camera turning, and nothing else.
        // A camera moving in spreads the floor out from the middle of the
        // picture - each patch sideways in proportion to how far it is from
        // the middle - so each patch's movement is fitted as that spread plus
        // one turn, and only the turn is kept. Taking the patches' middle
        // value instead added the spread up frame after frame and carried a
        // man doing burpees on the spot a metre and a half.
        let dx = 0, zoom = 0;
        const xs = moves.map((m) => m.x - this.w / 2);
        const span = Math.max(...xs) - Math.min(...xs);
        if (span > PATCH_W) {
          const n = moves.length;
          const mx = xs.reduce((a, b) => a + b, 0) / n;
          const md = moves.reduce((a, m) => a + m.dx, 0) / n;
          let sxx = 0, sxd = 0;
          moves.forEach((m, k) => { sxx += (xs[k] - mx) ** 2; sxd += (xs[k] - mx) * (m.dx - md); });
          const spread = sxx > 0 ? sxd / sxx : 0;
          dx = md - spread * mx;                         // the movement at the middle: the turn
          // And the spread itself: how much bigger the floor at the person's
          // distance got this frame - the camera moving in (or out). The
          // depth pass takes it off the person's own growth in the picture.
          if (Math.abs(spread) > 0.0015) zoom = spread;
        }
        let dy = mid(moves.map((m) => m.dy));
        // A still floor reads a few hundredths of a pixel either way; summed
        // over a minute that is a walk.
        if (Math.abs(dx) < 0.15) dx = 0;
        if (Math.abs(dy) < 0.15) dy = 0;
        out = {
          dx: Math.round((dx / this.w) * 1e5) / 1e5,
          dy: Math.round((dy / this.h) * 1e5) / 1e5,
          zoom: Math.round(zoom * 1e5) / 1e5,
          n: moves.length,
        };
      }
    }
    this.prev = cur;
    this.prevPose = pose || this.prevPose;
    return out;
  }
}
