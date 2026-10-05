/* cermin, driven the way a person drives it, in a real Chrome.
 *
 *   1. upload a video of someone doing jumping jacks and burpees
 *   2. check the person was found, and that the mannequin does what they did:
 *      hands above the head at the top of a jumping jack, feet on the floor
 *   3. export .glb, .bvh and .csv, and check each file is what it says
 *   4. record from a camera - Chrome's fake camera, fed a video of a squat -
 *      and check that take goes through the same way
 *
 * Its takes go to tests/out/data, never to ~/Documents.
 *
 *   node tests/smoke.mjs            everything
 *   node tests/smoke.mjs --fbx      also make the .fbx through Blender MCP
 *   node tests/smoke.mjs --show     with the browser window visible
 */

import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const OUT = path.join(HERE, 'out');
const DATA = path.join(OUT, 'data');
const MEDIA = path.join(HERE, 'media');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });

let failed = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { console.log(`  FAIL ${m}`); failed++; };
const check = (c, m) => (c ? ok(m) : bad(m));

// ── the server ─────────────────────────────────────────────────────────────
const server = spawn('python3', [path.join(ROOT, 'server.py'), '--no-open'], {
  env: { ...process.env, BENGKEL_DATA: DATA, CERMIN_PORT: '0' },
});
const ready = await new Promise((resolve, reject) => {
  let buf = '';
  server.stdout.on('data', (d) => {
    buf += d;
    const m = buf.match(/@@CERMIN-READY@@(.*)/);
    if (m) resolve(JSON.parse(m[1]));
  });
  server.stderr.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(d); });
  setTimeout(() => reject(new Error('the server never said it was ready')), 8000);
});
ok(`the server starts and prints its ready line (port ${ready.port})`);

// Check the guard before anything else: a page from elsewhere gets nothing.
const foreign = await fetch(`http://127.0.0.1:${ready.port}/api/takes?t=${ready.token}`,
  { headers: { Origin: 'https://example.com' } });
check(foreign.status === 403, 'a request from another origin is refused');
const tokenless = await fetch(`http://127.0.0.1:${ready.port}/api/takes`);
check(tokenless.status === 403, 'a request without the token is refused');

// ── the camera: Chrome's fake one, fed a squat ─────────────────────────────
const y4m = path.join(OUT, 'camera.y4m');
if (!fs.existsSync(y4m)) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(MEDIA, 'squat.webm'),
    '-vf', 'scale=960:540,fps=30', '-pix_fmt', 'yuv420p', y4m]);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !args.includes('--show'),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${y4m}`, '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 960 } });
await context.grantPermissions(['camera'], { origin: `http://127.0.0.1:${ready.port}` });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });

await page.goto(ready.url);
await page.waitForFunction(() => window.cermin, null, { timeout: 15000 });
ok('the page loads');
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, '1-empty.png') });

const waitForTake = async (label) => {
  const started = Date.now();
  await page.waitForFunction(() => {
    const s = window.cermin.state;
    return !s.busy && s.mode === 'take' && s.solved;
  }, null, { timeout: 10 * 60 * 1000, polling: 500 });
  return (Date.now() - started) / 1000;
};

// ── 1. upload ──────────────────────────────────────────────────────────────
console.log('\nupload');
await page.setInputFiles('#file', path.join(MEDIA, 'jumping12.webm'));
await page.waitForTimeout(3000);
await page.screenshot({ path: path.join(OUT, '2-tracking.png') });
const took = await waitForTake();
const stats = await page.evaluate(() => window.cermin.state.solved.stats);
ok(`a 12-second video is tracked and solved in ${took.toFixed(0)}s`);
check(stats.frames === 360, `360 frames at 30 fps (${stats.frames})`);
check(stats.person > 0.9, `the person is found in ${(stats.person * 100).toFixed(0)}% of frames`);
check(stats.legs > 0.6, `the legs are in the picture in ${(stats.legs * 100).toFixed(0)}% of frames`);
console.log(`       hands ${(stats.hands * 100).toFixed(0)}%, face ${(stats.face * 100).toFixed(0)}%`);

// Walk the solved take through the mannequin and measure it.
const motion = await page.evaluate(() => {
  const { state, man } = window.cermin;
  const names = Object.keys(man.bones);
  const bad = [];
  let handsUp = 0, lowest = Infinity, highest = -Infinity, travel = 0;
  const v = (n) => man.bones[n].getWorldPosition(new man.root.position.constructor());
  for (let i = 0; i < state.solved.frames.length; i++) {
    const f = state.solved.frames[i];
    for (let b = 0; b < f.q.length / 4; b++) {
      const len = Math.hypot(f.q[b * 4], f.q[b * 4 + 1], f.q[b * 4 + 2], f.q[b * 4 + 3]);
      if (!(Math.abs(len - 1) < 1e-3)) bad.push(i);
    }
    names.forEach((n, b) => man.bones[n].quaternion.fromArray(f.q, b * 4));
    man.bones.Hips.position.fromArray(f.hips);
    man.root.updateMatrixWorld(true);
    const head = v('Head').y;
    if (v('LeftHand').y > head && v('RightHand').y > head) handsUp++;
    for (const s of ['Left', 'Right']) {
      const toe = v(s + 'ToeBase').y;
      lowest = Math.min(lowest, toe);
    }
    highest = Math.max(highest, f.hips[1]);
    travel = Math.max(travel, Math.abs(f.hips[0]));
  }
  man.reset();
  return { bad: bad.length, handsUp, lowest, highest, travel, n: state.solved.frames.length };
});
check(motion.bad === 0, 'every rotation in every frame is a proper rotation');
check(motion.handsUp > 15, `both hands go above the head in ${motion.handsUp} frames — the jumping jacks`);
check(motion.lowest > -0.08, `the feet never go far through the floor (lowest toe ${motion.lowest.toFixed(3)} m)`);
check(motion.highest < 1.5, `the hips stay near the ground (highest ${motion.highest.toFixed(2)} m)`);
console.log(`       furthest the hips travel sideways: ${motion.travel.toFixed(2)} m`);

for (const [t, name] of [[1.0, '3-standing'], [5.2, '4-jack'], [9.0, '5-burpee']]) {
  await page.evaluate((t) => { const v = document.getElementById('video'); v.pause(); v.currentTime = t; }, t);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

// Changing the clean-up re-solves without tracking again.
const before = await page.evaluate(() => window.cermin.state.solved.frames[100].hips[0]);
await page.click('#opt-root [data-v="place"]');
await page.waitForTimeout(300);
const after = await page.evaluate(() => window.cermin.state.solved.frames.every((f) => f.hips[0] === 0));
check(after, `"Stay in place" puts the hips back on the spot (was ${before.toFixed(3)} m)`);
await page.click('#opt-root [data-v="video"]');

// ── 2. export ──────────────────────────────────────────────────────────────
console.log('\nexport');
const take = await page.evaluate(() => window.cermin.state.take);
const takeDir = path.join(DATA, 'takes', take);
for (const kind of ['glb', 'bvh', 'csv']) {
  await page.click(`[data-export="${kind}"]`);
  await page.waitForTimeout(kind === 'glb' ? 2500 : 800);
}
const glb = path.join(takeDir, 'cermin.glb');
if (fs.existsSync(glb)) {
  const buf = fs.readFileSync(glb);
  const len = buf.readUInt32LE(12);
  const doc = JSON.parse(buf.subarray(20, 20 + len).toString());
  const joints = doc.skins?.[0]?.joints?.length || 0;
  const anim = doc.animations?.[0];
  const morphs = (doc.meshes || []).flatMap((m) => m.extras?.targetNames || []);
  check(joints === 65, `the .glb has a skin of ${joints} joints`);
  check(anim && anim.channels.length > 40, `and one animation with ${anim ? anim.channels.length : 0} channels`);
  check(morphs.includes('jawOpen') && morphs.includes('eyeBlinkLeft'), `and ${morphs.length} named face shapes`);
  check(doc.nodes.some((n) => n.name === 'LeftHandIndex1'), 'with Mixamo bone names (LeftHandIndex1)');
} else bad('the .glb was written');

const bvh = path.join(takeDir, 'cermin.bvh');
if (fs.existsSync(bvh)) {
  const text = fs.readFileSync(bvh, 'utf8');
  const channels = (text.match(/CHANNELS (\d)/g) || []).reduce((n, c) => n + Number(c.slice(-1)), 0);
  const rows = text.split('MOTION')[1].trim().split('\n').slice(2);
  const widths = new Set(rows.map((r) => r.trim().split(/\s+/).length));
  check(text.startsWith('HIERARCHY\nROOT Hips'), 'the .bvh starts with its hierarchy');
  check(rows.length === 360, `and has 360 frames of motion (${rows.length})`);
  check(widths.size === 1 && widths.has(channels), `every row has all ${channels} channels`);
} else bad('the .bvh was written');

const csv = path.join(takeDir, 'face.csv');
if (fs.existsSync(csv)) {
  const lines = fs.readFileSync(csv, 'utf8').trim().split('\n');
  // MediaPipe gives ARKit's 52 shapes less tongueOut, plus a _neutral that is left out.
  check(lines[0].split(',').length === 52, `the face .csv has time plus 51 ARKit shapes (${lines[0].split(',').length - 1})`);
} else bad('the face .csv was written');

if (args.includes('--fbx')) {
  await page.click('[data-export="fbx"]');
  // Done when the page says so - saved, or why not.
  await page.waitForFunction(() => /cermin\.fbx|Blender|bengkel/.test(document.getElementById('toast').textContent)
    && !document.getElementById('toast').hidden, null, { timeout: 300000 });
  console.log(`       ${await page.textContent('#toast')}`);
  const fbx = path.join(takeDir, 'cermin.fbx');
  check(fs.existsSync(fbx) && fs.statSync(fbx).size > 10000, `the .fbx is made through Blender (${fs.existsSync(fbx) ? fs.statSync(fbx).size : 0} bytes)`);
}

// ── 3. reopening ───────────────────────────────────────────────────────────
console.log('\ntakes');
const listed = await page.$$eval('.take', (rows) => rows.length);
check(listed === 1, 'the take is listed');
await page.reload();
await page.waitForFunction(() => document.querySelectorAll('.take').length === 1);
await page.click('.take');
await waitForTake();
const again = await page.evaluate(() => window.cermin.state.solved.frames.length);
check(again === 360, 'it reopens from disk without tracking again');

// ── 4. record ──────────────────────────────────────────────────────────────
console.log('\nrecord');
await page.click('#record');
await page.waitForFunction(() => /Found you|No one/.test(document.getElementById('rec-say').textContent), null, { timeout: 60000 });
await page.waitForTimeout(1500);
const liveSay = await page.textContent('#rec-say');
check(/Found you/.test(liveSay), `the live preview finds the person ("${liveSay}")`);
await page.screenshot({ path: path.join(OUT, '6-live.png') });
await page.click('#rec-go');
await page.waitForTimeout(2400 + 5000);
await page.click('#rec-go');
await page.waitForTimeout(1000);
await waitForTake();
const rs = await page.evaluate(() => ({ s: window.cermin.state.solved.stats, take: window.cermin.state.take }));
check(rs.s.frames >= 120, `a ~5-second recording becomes a take of ${rs.s.frames} frames`);
check(rs.s.person > 0.8, `and the person is found in ${(rs.s.person * 100).toFixed(0)}% of it`);
const files = fs.readdirSync(path.join(DATA, 'takes', rs.take));
check(files.some((f) => /^video\.(mp4|webm)$/.test(f)) && files.includes('capture.json'),
  `the recording is kept beside its capture (${files.join(', ')})`);
// A squat bends both knees together. Seen from behind the tracker's depth is
// at its weakest, so this is measured loosely - but a leg standing straight
// while the other bends is the failure this guards against.
const knees = await page.evaluate(() => {
  const { state, man } = window.cermin;
  const names = Object.keys(man.bones);
  const v = (n) => man.bones[n].getWorldPosition(new man.root.position.constructor());
  const bend = (s) => {
    const a = v(s + 'UpLeg'), b = v(s + 'Leg'), c = v(s + 'Foot');
    return Math.PI - a.sub(b).angleTo(c.sub(b));
  };
  const diffs = [];
  let deep = 0;
  for (const f of state.solved.frames) {
    names.forEach((n, b) => man.bones[n].quaternion.fromArray(f.q, b * 4));
    man.root.updateMatrixWorld(true);
    const l = bend('Left'), r = bend('Right');
    diffs.push(Math.abs(l - r));
    if (l > 0.6 && r > 0.6) deep++;
  }
  man.reset();
  diffs.sort((a, b) => a - b);
  return { median: diffs[Math.floor(diffs.length / 2)] * 180 / Math.PI, deep, n: diffs.length };
});
console.log(`       knees differ by ${knees.median.toFixed(0)}° (median) — filmed from behind, where the tracker's depth is weakest`);
check(knees.deep > 10, `both knees bend past 35° in ${knees.deep} of ${knees.n} frames — the squat`);
await page.evaluate(() => { const v = document.getElementById('video'); v.pause(); v.currentTime = 0.4; });
await page.waitForTimeout(700);
await page.screenshot({ path: path.join(OUT, '7-recorded.png') });

// ── 5. close up: hands, fingers and face ───────────────────────────────────
console.log('\nclose up (sign language: hands, fingers, face, no legs)');
await page.setInputFiles('#file', path.join(MEDIA, 'signs10.webm'));
await page.waitForTimeout(1500);
await waitForTake();
const close = await page.evaluate(() => {
  const { state, man } = window.cermin;
  const s = state.solved;
  const names = Object.keys(man.bones);
  const curl = [], mouth = [], blink = [];
  // In FACE_SHAPES: 0 eyeBlinkLeft, 11 jawOpen … 21 mouthStretchRight.
  const v = (n) => man.bones[n].getWorldPosition(new man.root.position.constructor());
  for (const f of s.frames) {
    names.forEach((n, b) => man.bones[n].quaternion.fromArray(f.q, b * 4));
    man.root.updateMatrixWorld(true);
    // How far the right index fingertip is from the wrist: short when curled.
    curl.push(v('RightHandIndex4').distanceTo(v('RightHand')));
    mouth.push(Math.max(...Array.from(f.m).slice(11, 22))); blink.push(f.m[0]);
  }
  man.reset();
  const span = (a) => Math.max(...a) - Math.min(...a);
  return { stats: s.stats, cal: s.calibration, curl: span(curl), mouth: Math.max(...mouth), blink: Math.max(...blink) };
});
check(close.stats.face > 0.9, `the face is found in ${(close.stats.face * 100).toFixed(0)}% of frames`);
check(close.stats.hands > 0.5, `a hand is found in ${(close.stats.hands * 100).toFixed(0)}% of frames`);
check(close.stats.legs < 0.2, `the legs are out of the picture (${(close.stats.legs * 100).toFixed(0)}%), so they stand still`);
check(close.curl > 0.03, `the fingers open and close (the fingertip moves ${(close.curl * 100).toFixed(1)} cm against the wrist)`);
check(close.mouth > 0.3, `the mouth moves (strongest mouth shape ${close.mouth.toFixed(2)})`);
console.log(`       blink up to ${close.blink.toFixed(2)}; camera levelled by ${close.cal.level.toFixed(1)}°, head neutral ${close.cal.headPitch.toFixed(1)}°`);
for (const [t, name] of [[2.0, '8-signs-a'], [6.0, '9-signs-b']]) {
  await page.evaluate((t) => { const v = document.getElementById('video'); v.pause(); v.currentTime = t; }, t);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

// ── done ───────────────────────────────────────────────────────────────────
// MediaPipe prints its own start-up notes through console.error.
const real = problems.filter((p) => !/favicon|GPU stall|WebGL|^INFO:|TensorFlow Lite/.test(p));
check(real.length === 0, `no errors in the page${real.length ? ': ' + real.slice(0, 3).join(' | ') : ''}`);

await browser.close();
server.kill();
console.log(failed ? `\n${failed} failed` : '\nall good');
process.exit(failed ? 1 : 0);
