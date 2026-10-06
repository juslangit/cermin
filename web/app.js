/* cermin — the page.
 *
 * Two ways in, one way through:
 *
 *   Upload a video ─┐
 *                   ├─► track every frame ─► solve ─► play beside the video ─► export
 *   Record ─────────┘
 *
 * Recording is not a separate path. The camera is shown live with a quick
 * tracker on it, so you can see cermin has found you before you start, but
 * what is kept is the recorded video - tracked afterwards with the accurate
 * models exactly as an uploaded one would be. The live preview is for
 * standing in the right place, not for the take.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { api, say, working } from '/common/tool.js';
import { buildMannequin } from './mannequin.js';
import { CHARACTERS, loadCharacter } from './characters.js';
import { trackers, trackVideo, detect, drawOverlay } from './track.js';
import { Refiner, available as refinerAvailable } from './refine.js';
import { solve, LiveSolver, lowestFoot, legSeen, BONE_NAMES } from './solve.js';
import { buildClip, toGLB, toBVH, toFaceCSV } from './export.js';

const TOKEN = window.BENGKEL_TOKEN;
const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d');

const state = {
  trackers: null, trackersKey: '', live: null,
  capture: null, solved: null, clip: null, action: null,
  take: null, mode: 'empty', busy: false, cancel: false,
  character: 'mannequin', characterLoading: false,
};

// --------------------------------------------------------------------------
// options
// --------------------------------------------------------------------------

function seg(id, onChange) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    el.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('is-on', x === b));
    if (onChange) onChange(b.dataset.v ?? b.dataset.view ?? b.dataset.speed);
  });
  return () => { const on = el.querySelector('.is-on'); return on.dataset.v ?? on.dataset.view ?? on.dataset.speed; };
}

const opt = {
  quality: seg('opt-quality'),
  fps: seg('opt-fps'),
  root: seg('opt-root', () => resolve()),
};
seg('view', (v) => setView(v));
seg('speed', (v) => { video.playbackRate = Number(v); });
$('opt-smooth').addEventListener('input', () => { $('smooth-val').textContent = $('opt-smooth').value; });
$('opt-smooth').addEventListener('change', () => resolve());
$('opt-hands').addEventListener('change', () => resolve());
$('opt-face').addEventListener('change', () => resolve());

const solveOptions = () => ({
  smoothing: Number($('opt-smooth').value) / 100,
  root: opt.root(),
  hands: $('opt-hands').checked,
  face: $('opt-face').checked,
  lockFeet: $('opt-lock').checked,
});
$('opt-lock').addEventListener('change', () => resolve());

// --------------------------------------------------------------------------
// the viewport
// --------------------------------------------------------------------------

const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#121419');
scene.fog = new THREE.Fog('#121419', 9, 22);
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.9, 0);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight('#dfe6f5', '#2a2e38', 1.4));
const sun = new THREE.DirectionalLight('#ffffff', 2.2);
sun.position.set(2.5, 5, 3.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 });
scene.add(sun, sun.target);
const rim = new THREE.DirectionalLight('#3fd0c9', 0.9);
rim.position.set(-3, 3, -3);
scene.add(rim);

const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 64),
  new THREE.MeshStandardMaterial({ color: '#1a1d23', roughness: 1 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(24, 48, '#2f3542', '#232731');
grid.position.y = 0.001;
scene.add(grid);

// A new key on 2026-10-06, when the standard mannequin became the default
// again: a choice remembered under the old key was made when there was no
// standard mannequin to choose.
const CHARACTER_KEY = 'cermin.character.v2';

const man = buildMannequin();
scene.add(man.root);
man.root.visible = false;
const mixer = new THREE.AnimationMixer(man.root);

let characterRequest = 0;
/* The standard mannequin is cermin's own: 65 bones with Mixamo names,
 * fingers and a face with ARKit shapes, so an export opens as a standard
 * humanoid in Blender, Unreal and gerak. It is the default. The downloaded
 * characters below it are for seeing the motion on a real body. */
function useStandard() {
  ++characterRequest;
  if (man.avatar) { scene.remove(man.avatar.root); man.avatar.dispose(); man.avatar = null; }
  man.root.visible = true;
  state.character = 'standard';
  state.characterLoading = false;
  $('character').value = 'standard';
  $('character-status').textContent = '';
  const credit = $('character-credit');
  credit.removeAttribute('href');
  credit.textContent = '';
  $('character-capabilities').textContent = 'Body, fingers and face. Standard bone names — opens as a humanoid in Blender, Unreal and gerak.';
  try { localStorage.setItem(CHARACTER_KEY, 'standard'); } catch (_) { /* optional preference */ }
}

async function changeCharacter(name) {
  if (name === 'standard') { useStandard(); return; }
  const request = ++characterRequest;
  state.characterLoading = true;
  $('character-status').textContent = 'Loading character…';
  try {
    const avatar = await loadCharacter(name);
    if (request !== characterRequest) { avatar.dispose(); return; }
    const previous = man.avatar;
    man.avatar = avatar;
    scene.add(avatar.root);
    avatar.sync(man);
    if (previous) { scene.remove(previous.root); previous.dispose(); }
    man.root.visible = false;
    const credit = $('character-credit');
    credit.href = avatar.root.userData.source;
    credit.textContent = `${avatar.info.title} · ${avatar.info.author} · CC BY`;
    $('character-capabilities').textContent = avatar.info.fingers
      ? 'Body + fingers. Face motion is saved as CSV; this model has no expression shapes.'
      : 'Body + wrists. Finger and face motion are saved; this wooden model has no finger or expression rig.';
    state.character = name;
    $('character').value = name;
    try { localStorage.setItem(CHARACTER_KEY, name); } catch (_) { /* optional preference */ }
  } catch (error) {
    if (request !== characterRequest) return;
    $('character').value = state.character;
    say(error.message, true);
  } finally {
    if (request === characterRequest) {
      state.characterLoading = false;
      $('character-status').textContent = '';
    }
  }
}
$('character').addEventListener('change', () => changeCharacter($('character').value));


const VIEWS = {
  front: [0, 1.15, 4.6], side: [4.6, 1.15, 0], three: [3.2, 1.6, 3.4],
};
function setView(v) {
  const [x, y, z] = VIEWS[v] || VIEWS.front;
  const t = controls.target;
  camera.position.set(t.x + x, y, t.z + z);
  controls.update();
}
setView('front');

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = w + 'px';
  renderer.domElement.style.height = h + 'px';
  camera.aspect = w / Math.max(1, h);
  // Keep both outstretched hands in the narrow half-width stage.
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.max(
    Math.tan(THREE.MathUtils.degToRad(35 / 2)), 1.04 / (4.6 * camera.aspect))));
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

function applyPose(q, m, hips) {
  BONE_NAMES.forEach((n, i) => man.bones[n].quaternion.set(q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]));
  if (m) m.forEach((v, i) => { man.face.morphTargetInfluences[i] = v; });
  man.bones.Hips.position.set(...hips);
}

// Follow the mannequin when it walks, so it does not leave the frame.
const follow = new THREE.Vector3();
function frameFollow() {
  man.bones.Hips.getWorldPosition(follow);
  const dx = (follow.x - controls.target.x) * 0.08;
  controls.target.x += dx;
  camera.position.x += dx;
}

function frameIndex() {
  if (!state.capture) return -1;
  const n = state.capture.frames.length;
  return Math.max(0, Math.min(n - 1, Math.round(video.currentTime * state.capture.fps - 0.0005 * state.capture.fps)));
}

function tick() {
  requestAnimationFrame(tick);
  if (state.mode === 'take' && state.action && state.trim && !video.paused) {
    const fps = state.capture.fps;
    if (video.currentTime > (state.trim[1] + 1) / fps || video.currentTime < state.trim[0] / fps - 0.05) {
      video.currentTime = state.trim[0] / fps;
    }
  }
  if (state.mode === 'take' && state.action) {
    mixer.setTime(Math.min(video.currentTime, state.clip.duration - 1e-4));
    frameFollow();
    const i = frameIndex();
    const sf = state.solved.frames[i];
    if (!state.busy) {
      // The points the mannequin was solved from - refined, when they were.
      const raw = state.capture.frames[i];
      const shown = raw && state.solved.poses[i] ? { ...raw, pose: state.solved.poses[i] } : raw;
      drawOverlay(octx, shown, overlay.width, overlay.height, undefined,
        sf && { floor: sf.floor, air: sf.air });
    }
    updateTime();
  } else if (state.mode === 'live') {
    liveStep();
  }
  if (man.avatar) man.avatar.sync(man);
  controls.update();
  renderer.render(scene, camera);
}

// --------------------------------------------------------------------------
// transport
// --------------------------------------------------------------------------

const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
function updateTime() {
  const d = state.capture ? state.capture.duration : 0;
  $('time').textContent = `${fmt(video.currentTime)} / ${fmt(d)}`;
  if (!scrubbing && d) $('scrub').value = String(Math.round((video.currentTime / d) * 1000));
  $('play').textContent = video.paused ? '▶' : '❚❚';
}
let scrubbing = false;
$('scrub').addEventListener('input', () => {
  scrubbing = true;
  if (state.capture) video.currentTime = (Number($('scrub').value) / 1000) * state.capture.duration;
});
$('scrub').addEventListener('change', () => { scrubbing = false; });
function togglePlay() {
  if (state.mode !== 'take') return;
  if (video.paused) video.play(); else video.pause();
}
$('play').addEventListener('click', togglePlay);
video.loop = true;
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, button')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
});

// --------------------------------------------------------------------------
// talking to the server
// --------------------------------------------------------------------------

async function putFile(take, name, body) {
  const res = await fetch(`/api/take-file?take=${encodeURIComponent(take)}&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'X-Bengkel-Token': TOKEN, 'Content-Type': 'application/octet-stream' },
    body,
  });
  const doc = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(doc.error || res.statusText);
  return doc;
}

const takeURL = (take, name) =>
  `/api/take-file?t=${encodeURIComponent(TOKEN)}&take=${encodeURIComponent(take)}&name=${encodeURIComponent(name)}`;

// --------------------------------------------------------------------------
// tracking a video
// --------------------------------------------------------------------------

async function fileTrackers() {
  const key = [opt.quality(), $('opt-hands').checked, $('opt-face').checked].join();
  if (state.trackers && state.trackersKey === key) return state.trackers;
  working(true, 'Getting the trackers ready', 'The first time takes a few seconds — the models load from this Mac, nothing is downloaded.');
  state.trackers = await trackers({
    accurate: opt.quality() !== 'fast', hands: $('opt-hands').checked, face: $('opt-face').checked,
  });
  state.trackersKey = key;
  return state.trackers;
}

function loadVideo(src) {
  return new Promise((resolve, reject) => {
    video.srcObject = null;
    video.onloadeddata = () => { video.onloadeddata = null; video.onerror = null; resolve(); };
    video.onerror = () => reject(new Error('The browser cannot play that video. Try an .mp4 or .mov.'));
    video.src = src;
    video.load();
  });
}

function sizeOverlay() {
  overlay.width = video.videoWidth || 1280;
  overlay.height = video.videoHeight || 720;
}

/** Track `blob` as a new take called `label`. */
async function captureVideo(blob, label, ext) {
  if (state.busy) return;
  state.busy = true;
  state.cancel = false;
  let failed = false;
  showWorking(true);
  try {
    const url = URL.createObjectURL(blob);
    await loadVideo(url);
    sizeOverlay();
    setMode('take-loading');
    $('video-empty').hidden = true;

    const { take } = await api('/api/take', { label });
    // The video goes to disk while the trackers work.
    const saving = putFile(take, `video.${ext}`, blob);

    const fps = Number(opt.fps());
    const capture = await track(fps);
    capture.source = label;
    capture.video = `video.${ext}`;

    working(true, 'Saving the take', '');
    await saving;
    await putFile(take, 'capture.json', JSON.stringify(capture));
    state.take = take;
    state.capture = capture;
    state.trim = null;
    showTrim();
    resolve();
    await putFile(take, 'take.json', JSON.stringify({
      label, video: capture.video, duration: capture.duration, fps,
      frames: capture.frames.length, stats: state.solved.stats,
      created: new Date().toISOString(),
    }));
    await listTakes();
    video.currentTime = 0;
    video.play();
    warnIfThin(state.solved.stats);
  } catch (err) {
    if (err.message === 'cancelled') say('Stopped. Nothing was kept.');
    else { console.error(err); say(err.message || String(err), true); }
    failed = true;
  } finally {
    state.busy = false;
    showWorking(false);
  }
  // Back to whatever was open before, rather than a half-loaded video.
  if (failed) {
    if (state.take) openTake(state.take);
    else { video.removeAttribute('src'); video.load(); setMode('empty'); }
  }
}

/** The DWPose refiner, loaded the first time Best is used. */
async function bestRefiner() {
  if (opt.quality() !== 'best') return null;
  if (!state.refiner) {
    working(true, 'Loading the larger model', 'Once per session — 134 MB, from this Mac.');
    state.refiner = await Refiner.load();
  }
  return state.refiner;
}

/** Track whatever video is loaded, showing how far along it is. */
async function track(fps) {
  const T = await fileTrackers();
  const refiner = await bestRefiner();
  const started = performance.now();
  return trackVideo(T, video, {
    fps,
    refiner,
    cancelled: () => state.cancel,
    onProgress: (done, total, frame) => {
      drawOverlay(octx, frame, overlay.width, overlay.height);
      const per = (performance.now() - started) / done;
      const left = Math.max(0, Math.round(((total - done) * per) / 1000));
      working(true, `${refiner ? 'Looking twice at every frame' : 'Following the person and scanning the floor'} — frame ${done} of ${total}`,
        frame.pose ? `About ${left}s left` : `No one found in this frame · about ${left}s left`);
      $('bar').style.width = `${(100 * done) / total}%`;
    },
  });
}

/* Track the open take's own video again - with whatever the Capture settings
 * are now, and with the floor scan, which takes from before it lack. */
async function retrack() {
  if (state.busy || !state.take || !state.capture) return;
  const take = state.take, old = state.capture;
  state.busy = true;
  state.cancel = false;
  showWorking(true);
  try {
    video.pause();
    const capture = await track(Number(opt.fps()));
    capture.source = old.source;
    capture.video = old.video;
    working(true, 'Saving the take', '');
    await putFile(take, 'capture.json', JSON.stringify(capture));
    state.capture = capture;
    resolve();
    await putFile(take, 'take.json', JSON.stringify({
      label: old.source || take, video: capture.video, duration: capture.duration, fps: capture.fps,
      frames: capture.frames.length, stats: state.solved.stats, created: new Date().toISOString(),
      trim: state.trim ? state.trim.map((f) => f / capture.fps) : null,
    }));
    await listTakes();
    video.currentTime = 0;
    video.play();
    say('Tracked again, with the floor scanned.');
  } catch (err) {
    say(err.message === 'cancelled' ? 'Stopped. The take is as it was.' : (err.message || String(err)), err.message !== 'cancelled');
    state.capture = old;
  } finally {
    state.busy = false;
    showWorking(false);
  }
}
$('retrack').addEventListener('click', retrack);

function showWorking(on) {
  working(on, on ? 'Starting' : '', '');
  $('bar').style.width = '0';
  $('cancel').hidden = !on;
}
$('cancel').addEventListener('click', () => { state.cancel = true; });

function warnIfThin(s) {
  if (s.person < 0.6) {
    say(`The person was only found in ${Math.round(s.person * 100)}% of the frames — the rest are filled in. Whole body in the picture, plain light and a still camera help most.`, true);
  } else if (s.legs < 0.3) {
    say('The legs were mostly out of the picture, so they stand still. Step back from the camera to capture them.');
  }
}

// --------------------------------------------------------------------------
// solving, and showing the result
// --------------------------------------------------------------------------

function resolve() {
  if (!state.capture) return;
  state.solved = solve(state.capture, man, solveOptions());
  state.clip = buildClip(state.solved, state.take || 'cermin');
  mixer.stopAllAction();
  if (state.action) mixer.uncacheAction(state.action.getClip());
  state.action = mixer.clipAction(state.clip);
  state.action.play();
  setMode('take');
  showFacts(state.solved.stats, state.capture);
}

function showFacts(s, c) {
  const pct = (x) => `<dd class="${x < 0.6 ? 'low' : ''}">${Math.round(x * 100)}%</dd>`;
  $('facts').innerHTML = `
    <dt>Length</dt><dd>${c.duration.toFixed(1)}s · ${c.fps} fps</dd>
    <dt>Frames</dt><dd>${s.frames}</dd>
    <dt>Person found</dt>${pct(s.person)}
    <dt>Legs in picture</dt>${pct(s.legs)}
    <dt>Hands found</dt>${$('opt-hands').checked ? pct(s.hands) : '<dd>off</dd>'}
    <dt>Face found</dt>${$('opt-face').checked ? pct(s.face) : '<dd>off</dd>'}
    <dt>Jumps</dt><dd>${s.jumps}</dd>
    <dt>Camera</dt>${s.floorScanned === null ? '<dd class="low">floor not scanned</dd>'
      : s.floorScanned < 0.3 ? '<dd>floor too plain to read</dd>'
        : `<dd>${s.cameraMoving > 0.15 ? 'moving' : 'still'}</dd>`}`;
}

function setMode(mode) {
  state.mode = mode;
  const ready = mode === 'take';
  document.querySelectorAll('[data-export]').forEach((b) => { b.disabled = !ready; });
  $('reveal').disabled = !ready;
  $('to-gerak').disabled = !ready;
  $('trim-in').disabled = !ready;
  $('trim-out').disabled = !ready;
  $('retrack').disabled = !ready;
  $('scrub').disabled = !ready;
  document.body.classList.toggle('is-live', mode === 'live');
  if (mode === 'empty') {
    $('video-empty').hidden = false;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    man.reset();
  }
}

// --------------------------------------------------------------------------
// uploading
// --------------------------------------------------------------------------

function extOf(file) {
  const fromName = (file.name || '').split('.').pop().toLowerCase();
  if (['mp4', 'webm', 'mov', 'm4v'].includes(fromName)) return fromName;
  if (/webm/.test(file.type)) return 'webm';
  if (/quicktime/.test(file.type)) return 'mov';
  return 'mp4';
}

function takeFile(file) {
  if (!file) return;
  if (!/^video\//.test(file.type) && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) {
    say('That is not a video. cermin takes .mp4, .mov and .webm.', true);
    return;
  }
  if (state.mode === 'live') stopLive(false);
  captureVideo(file, file.name.replace(/\.[^.]+$/, ''), extOf(file));
}

$('upload').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', () => { takeFile($('file').files[0]); $('file').value = ''; });

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  takeFile(e.dataTransfer.files[0]);
});

// --------------------------------------------------------------------------
// recording
// --------------------------------------------------------------------------

const rec = { stream: null, recorder: null, chunks: [], started: 0, timer: null, solver: null };

async function startLive() {
  if (state.busy) return;
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false,
    });
  } catch (err) {
    say(err.name === 'NotAllowedError'
      ? 'cermin was not allowed to use the camera. Allow it in the browser and press Record again.'
      : `No camera could be opened (${err.message}).`, true);
    return;
  }
  video.pause();
  video.removeAttribute('src');
  video.srcObject = rec.stream;
  await video.play();
  sizeOverlay();
  $('video-empty').hidden = true;
  $('rec-bar').hidden = false;
  $('record').disabled = true;
  $('rec-say').textContent = 'Getting the live tracker ready…';
  setMode('live');
  mixer.stopAllAction();
  man.reset();

  if (!state.live) {
    state.live = await trackers({ accurate: false, hands: $('opt-hands').checked, face: $('opt-face').checked });
  }
  rec.solver = new LiveSolver(0.6);
  $('rec-say').textContent = 'Get into the picture — your whole body if you can';
}

let liveSeen = 0;
function liveStep() {
  if (!state.live || !rec.stream || video.readyState < 2) return;
  const now = performance.now();
  const frame = detect(state.live, video, now);
  drawOverlay(octx, frame, overlay.width, overlay.height);
  const pose = rec.solver.step(frame, now / 1000, state.live.faceNames || []);
  if (pose) {
    applyPose(pose.q, $('opt-face').checked ? pose.m : null, [0, 0, 0]);
    const legs = legSeen(frame.pose.v, frame.pose.i, true) && legSeen(frame.pose.v, frame.pose.i, false);
    man.bones.Hips.position.set(0, legs ? -lowestFoot(man, pose.q) : 0.95, 0);
    liveSeen = now;
  }
  if (!rec.recorder) {
    $('rec-say').textContent = !pose ? 'No one found yet — step into the picture'
      : legSeen(frame.pose.v, frame.pose.i, true) && legSeen(frame.pose.v, frame.pose.i, false)
        ? 'Found you, head to feet. Ready when you are.'
        : 'Found you — step back to get your legs in too';
  } else if (now - liveSeen > 1000) {
    $('rec-say').textContent = 'Lost you — come back into the picture';
  } else {
    $('rec-say').textContent = 'Recording';
  }
}

function pickMime() {
  for (const m of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

async function countdown() {
  const el = $('countdown');
  el.hidden = false;
  for (const n of [3, 2, 1]) {
    el.textContent = n;
    await new Promise((r) => setTimeout(r, 800));
    if (!rec.stream) break;
  }
  el.hidden = true;
}

$('rec-go').addEventListener('click', async () => {
  if (rec.recorder) { stopRecording(); return; }
  $('rec-go').disabled = true;
  await countdown();
  $('rec-go').disabled = false;
  if (!rec.stream) return;
  const mime = pickMime();
  rec.chunks = [];
  rec.recorder = new MediaRecorder(rec.stream, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : {});
  rec.recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
  rec.recorder.start(250);
  rec.started = performance.now();
  document.body.classList.add('is-recording');
  $('rec-go').textContent = 'Stop';
  rec.timer = setInterval(() => {
    $('rec-time').textContent = fmt((performance.now() - rec.started) / 1000).replace(/\.\d$/, '');
  }, 250);
});

function stopRecording() {
  const r = rec.recorder;
  r.onstop = () => {
    const type = r.mimeType || 'video/webm';
    const blob = new Blob(rec.chunks, { type });
    stopLive(false);              // not back to the last take: this one replaces it
    if (blob.size < 1000) { say('Nothing was recorded.', true); return; }
    captureVideo(blob, 'recording', /mp4/.test(type) ? 'mp4' : 'webm');
  };
  r.stop();
}

/** Close the camera; `reopen` goes back to the take that was open before. */
function stopLive(reopen = true) {
  clearInterval(rec.timer);
  if (rec.recorder && rec.recorder.state !== 'inactive') { rec.recorder.onstop = null; rec.recorder.stop(); }
  rec.recorder = null;
  if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
  rec.stream = null;
  video.srcObject = null;
  document.body.classList.remove('is-recording');
  $('rec-bar').hidden = true;
  $('rec-go').textContent = 'Start recording';
  $('rec-time').textContent = '0:00';
  $('record').disabled = false;
  if (!reopen) return;
  if (state.capture && state.take) openTake(state.take);
  else setMode('empty');
}

$('record').addEventListener('click', startLive);
$('rec-cancel').addEventListener('click', () => stopLive());

// --------------------------------------------------------------------------
// takes
// --------------------------------------------------------------------------

async function listTakes() {
  const { takes } = await api('/api/takes');
  const el = $('takes');
  if (!takes.length) return;
  el.innerHTML = '';
  for (const t of takes) {
    const row = document.createElement('div');
    row.className = 'row take' + (t.name === state.take ? ' is-on' : '');
    const when = t.name.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2}).*/, '$3/$2 $4:$5');
    const made = t.files.filter((f) => /^cermin\.|^face\.csv/.test(f)).map((f) => f.split('.').pop());
    row.innerHTML = `<button class="take-del" title="Move to the Trash">✕</button>
      <div class="take-name"></div>
      <div class="take-meta">${when} · ${(t.duration || 0).toFixed(1)}s${t.stats ? ` · ${Math.round(t.stats.person * 100)}% found` : ''}</div>
      <div class="row-tags">${made.map((m) => `<span class="tag tag-tool">.${m}</span>`).join('')}</div>`;
    row.querySelector('.take-name').textContent = t.label || t.name;
    row.addEventListener('click', (e) => {
      if (e.target.closest('.take-del')) return;
      openTake(t.name);
    });
    row.querySelector('.take-del').addEventListener('click', async () => {
      if (!confirm(`Move "${t.label || t.name}" to the Trash?`)) return;
      await api('/api/delete-take', { take: t.name });
      if (state.take === t.name) { state.take = null; state.capture = null; setMode('empty'); video.removeAttribute('src'); }
      listTakes();
    });
    el.appendChild(row);
  }
}

async function openTake(name) {
  if (state.busy) return;
  if (state.mode === 'live') stopLive(false);
  try {
    working(true, 'Opening the take', '');
    const res = await fetch(takeURL(name, 'capture.json'));
    if (!res.ok) throw new Error('That take could not be read.');
    const capture = await res.json();
    await loadVideo(takeURL(name, capture.video || 'video.mp4'));
    sizeOverlay();
    $('video-empty').hidden = true;
    state.take = name;
    state.capture = capture;
    resolve();
    await loadTrim(name, capture);
    // A take from before the floor scan says so, and offers the way to get one.
    if (state.solved.stats.floorScanned === null) {
      say('This take was tracked before cermin scanned the floor. Press "Track this video again" to scan it as well.');
    }
    document.querySelectorAll('.take').forEach((r) => r.classList.remove('is-on'));
    listTakes();
  } catch (err) {
    say(err.message, true);
  } finally {
    working(false);
  }
}

// --------------------------------------------------------------------------
// export
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// trimming
// --------------------------------------------------------------------------

/* Where the take starts and ends, in frames, kept in take.json beside it.
 * Playback loops inside it, and everything that leaves cermin - the files and
 * the hand-over to gerak - is only that part, starting on the spot. */
state.trim = null;

function trimmedSolved() {
  const s = state.solved;
  if (!s || !state.trim) return s;
  const [a, b] = state.trim;
  const frames = s.frames.slice(a, b + 1);
  // Start where the trimmed take starts: across and toward the camera from
  // there, so a clip dropped into a game begins on its own spot.
  const [x0, , z0] = frames[0].hips;
  return {
    ...s,
    frames: frames.map((f) => ({ ...f, hips: [f.hips[0] - x0, f.hips[1], f.hips[2] - z0] })),
    faceAll: s.faceAll.slice(a, b + 1),
  };
}
function exportClip() {
  return state.trim ? buildClip(trimmedSolved(), state.take || 'cermin') : state.clip;
}

function showTrim() {
  const band = $('trim-band');
  const n = state.capture ? state.capture.frames.length : 0;
  $('trim-clear').hidden = !state.trim;
  if (!state.trim || !n) { band.hidden = true; return; }
  band.hidden = false;
  band.style.left = `${(100 * state.trim[0]) / n}%`;
  band.style.width = `${(100 * (state.trim[1] - state.trim[0] + 1)) / n}%`;
}

async function saveTrim() {
  showTrim();
  if (!state.take) return;
  try {
    const res = await fetch(takeURL(state.take, 'take.json'));
    const info = res.ok ? await res.json() : {};
    info.trim = state.trim ? state.trim.map((f) => f / state.capture.fps) : null;
    await putFile(state.take, 'take.json', JSON.stringify(info));
  } catch (err) {
    say(`The trim could not be saved: ${err.message}`, true);
  }
}

function setTrim(end) {
  if (!state.capture) return;
  const n = state.capture.frames.length;
  const here = frameIndex();
  let [a, b] = state.trim || [0, n - 1];
  if (end === 'in') a = here; else b = here;
  if (b - a < 2) { say('The end has to come after the start.', true); return; }
  state.trim = (a === 0 && b === n - 1) ? null : [a, b];
  saveTrim();
  const fmtF = (f) => fmt(f / state.capture.fps);
  if (state.trim) say(`The take is now ${fmtF(a)} to ${fmtF(b)} — exports and gerak get only that.`);
}
$('trim-in').addEventListener('click', () => setTrim('in'));
$('trim-out').addEventListener('click', () => setTrim('out'));
$('trim-clear').addEventListener('click', () => { state.trim = null; saveTrim(); say('The whole video again.'); });
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select') || state.mode !== 'take') return;
  if (e.key === 'i') setTrim('in');
  if (e.key === 'o') setTrim('out');
});

async function loadTrim(take, capture) {
  state.trim = null;
  try {
    const res = await fetch(takeURL(take, 'take.json'));
    const info = res.ok ? await res.json() : {};
    if (Array.isArray(info.trim)) {
      const n = capture.frames.length;
      const a = Math.max(0, Math.round(info.trim[0] * capture.fps));
      const b = Math.min(n - 1, Math.round(info.trim[1] * capture.fps));
      if (b - a >= 2) state.trim = [a, b];
    }
  } catch { /* no trim */ }
  showTrim();
}

async function exportAs(kind) {
  if (!state.solved || !state.take) return;
  if (state.characterLoading) { say('Wait for the character to finish loading, then export.'); return; }
  const take = state.take;
  try {
    if (kind === 'glb' || kind === 'fbx') {
      working(true, 'Writing the .glb', '');
      const buf = await toGLB(man, exportClip());
      await putFile(take, 'cermin.glb', buf);
      if (kind === 'fbx') {
        working(true, 'Making the .fbx in Blender', 'Through the shared Blender — it opens hidden if it is not running.');
        const answer = await api('/api/fbx', { take });
        if (!answer.ok) throw new Error(answer.problem || 'Blender could not write the .fbx.');
      }
    } else if (kind === 'bvh') {
      await putFile(take, 'cermin.bvh', toBVH(trimmedSolved()));
    } else if (kind === 'csv') {
      if (!trimmedSolved().faceAll.some(Boolean)) throw new Error('No face was captured in this part of the take.');
      await putFile(take, 'face.csv', toFaceCSV(trimmedSolved()));
    }
    const file = kind === 'csv' ? 'face.csv' : `cermin.${kind}`;
    say(`Saved ${file} in the take's folder.`);
    listTakes();
  } catch (err) {
    say(err.message || String(err), true);
  } finally {
    working(false);
  }
}

document.querySelectorAll('[data-export]').forEach((b) =>
  b.addEventListener('click', () => exportAs(b.dataset.export)));
$('reveal').addEventListener('click', () => state.take && api('/api/reveal', { take: state.take }));

/* ── next door, inside bengkel ───────────────────────────────────────
 *
 * A take goes to gerak as a .glb - the same file the .glb button writes -
 * because gerak opens files, not other tools' viewports. There every bone's
 * keys are on the timeline, ready to be cleaned up by hand. Behind a check
 * for bengkel, so cermin on its own is unchanged.
 */
if (window.bengkel) {
  const send = $('to-gerak');
  send.hidden = false;
  send.addEventListener('click', async () => {
    if (!state.solved || !state.take) return;
    if (state.characterLoading) { say('Wait for the character to finish loading, then send it.'); return; }
    send.disabled = true;
    try {
      working(true, 'Writing the .glb for gerak', '');
      const saved = await putFile(state.take, 'cermin.glb', await toGLB(man, exportClip()));
      const label = (state.capture && state.capture.source) || state.take;
      await window.bengkel.handOver('gerak', saved.path, label);
      listTakes();
    } catch (err) {
      say(err.message || String(err), true);
    } finally {
      working(false);
      send.disabled = state.mode !== 'take';
    }
  });
}

// --------------------------------------------------------------------------

// Best needs the 134 MB model, which a fresh copy fetches with
// tools/fetch-models.sh. Without it, Best is offered as unavailable.
refinerAvailable().then((ok) => {
  if (ok) return;
  $('q-best').disabled = true;
  $('q-best').classList.remove('is-on');
  document.querySelector('#opt-quality [data-v="accurate"]').classList.add('is-on');
  $('q-hint').textContent = 'Best needs its larger model: run tools/fetch-models.sh once, then reload.';
});

window.cermin = { state, man, solve, captureVideo, openTake, exportAs, renderer, setView, changeCharacter };
listTakes().catch(() => {});
let savedCharacter;
try { savedCharacter = localStorage.getItem(CHARACTER_KEY); } catch (_) { /* optional preference */ }
changeCharacter(savedCharacter === 'standard' || CHARACTERS.includes(savedCharacter) ? savedCharacter : 'standard');
tick();
