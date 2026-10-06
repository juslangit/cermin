/* A second, closer look: DWPose.
 *
 * MediaPipe is small and quick, and it is what finds the person, the face,
 * the hands and the depth. Where it is weakest is the legs under loose
 * clothes and the feet: on a dance video in wide trousers it lost the legs,
 * folded both into one, and put the heel halfway along the shoe.
 *
 * DWPose (Apache-2.0, from the IDEA Research DWPose project) is about ten
 * times heavier and was trained on far more varied people, with six points on
 * the feet - big toe, little toe and heel on each. It is run on each frame
 * cropped to the person MediaPipe found, and gives 2D points only. fuse.js
 * puts them back into 3D.
 *
 * It runs through ONNX Runtime in the page, on the graphics card where the
 * browser allows (WebGPU), else on the processor. The model is 134 MB, kept
 * out of git; tools/fetch-models.sh downloads it.
 */

import * as ort from './vendor/ort/ort.webgpu.min.mjs';

const MODEL = '/web/models/dwpose.onnx';
const W = 288, H = 384;                       // what the model looks at
const MEAN = [123.675, 116.28, 103.53];
const STD = [58.395, 57.12, 57.375];
export const KEEP = 23;                       // body (17) and feet (6) of its 133 points

ort.env.wasm.wasmPaths = '/web/vendor/ort/';
// It warns, through the console's error channel, that it put shape sums on
// the processor - which is it working as intended. Real errors still show
// (here, and as logSeverityLevel on the session itself).
ort.env.logLevel = 'error';
// Several threads need the page to be cross-origin isolated, which the
// server's headers make it; one thread otherwise.
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

/** Is the model on this Mac? */
export async function available() {
  try {
    const res = await fetch(MODEL, { headers: { Range: 'bytes=0-0' } });
    return res.ok;
  } catch {
    return false;
  }
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;

export class Refiner {
  static async load() {
    let session = null, used = null;
    for (const provider of ['webgpu', 'wasm']) {
      try {
        session = await ort.InferenceSession.create(MODEL, { executionProviders: [provider], logSeverityLevel: 3 });
        used = provider;
        break;
      } catch (err) {
        console.warn(`cermin: DWPose on ${provider} failed`, err);
      }
    }
    if (!session) throw new Error('The refining model could not be started.');
    return new Refiner(session, used);
  }

  constructor(session, provider) {
    this.session = session;
    this.provider = provider;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.input = new Float32Array(3 * W * H);
  }

  /** The person's box from MediaPipe's points, grown a quarter and shaped to the model's 3:4. */
  box(pose, vw, vh) {
    const I = pose.i;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < 33; k++) {
      x0 = Math.min(x0, I[k * 2] * vw); x1 = Math.max(x1, I[k * 2] * vw);
      y0 = Math.min(y0, I[k * 2 + 1] * vh); y1 = Math.max(y1, I[k * 2 + 1] * vh);
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let bw = (x1 - x0) * 1.25, bh = (y1 - y0) * 1.25;
    if (bw / bh > W / H) bh = bw / (W / H); else bw = bh * (W / H);
    return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
  }

  /** The 23 body and feet points for this frame, in the picture's 0..1 coordinates. */
  async run(video, pose) {
    if (!pose) return null;
    const vw = video.videoWidth, vh = video.videoHeight;
    const b = this.box(pose, vw, vh);

    // Only the part of the box inside the picture is drawn; the rest stays
    // black, as the model was trained on.
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const sx = Math.max(0, b.x), sy = Math.max(0, b.y);
    const ex = Math.min(vw, b.x + b.w), ey = Math.min(vh, b.y + b.h);
    if (ex <= sx || ey <= sy) return null;
    const k = W / b.w;
    ctx.drawImage(video, sx, sy, ex - sx, ey - sy, (sx - b.x) * k, (sy - b.y) * k, (ex - sx) * k, (ey - sy) * k);

    const px = ctx.getImageData(0, 0, W, H).data;
    const plane = W * H, x = this.input;
    for (let i = 0, j = 0; j < plane; i += 4, j++) {
      x[j] = (px[i] - MEAN[0]) / STD[0];
      x[plane + j] = (px[i + 1] - MEAN[1]) / STD[1];
      x[2 * plane + j] = (px[i + 2] - MEAN[2]) / STD[2];
    }
    const out = await this.session.run({ input: new ort.Tensor('float32', x, [1, 3, H, W]) });
    const simX = out.simcc_x, simY = out.simcc_y;
    const nx = simX.dims[2], ny = simY.dims[2];
    const ax = simX.data, ay = simY.data;

    // Each point is the peak of its row: where along the width, and where
    // along the height. The peak's height is how sure the model is.
    const pts = [], score = [];
    for (let p = 0; p < KEEP; p++) {
      let bx = 0, vx = -Infinity, by = 0, vy = -Infinity;
      for (let q = 0; q < nx; q++) { const v = ax[p * nx + q]; if (v > vx) { vx = v; bx = q; } }
      for (let q = 0; q < ny; q++) { const v = ay[p * ny + q]; if (v > vy) { vy = v; by = q; } }
      const u = b.x + ((bx / (nx / W)) / W) * b.w;
      const v = b.y + ((by / (ny / H)) / H) * b.h;
      pts.push(r4(u / vw), r4(v / vh));
      score.push(r4(Math.min(vx, vy)));
    }
    return { i: pts, s: score };
  }
}
