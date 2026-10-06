# cermin

**Motion capture from an ordinary video.** *Cermin* is a mirror.

Upload a video of someone moving, or press **Record** and do the move yourself
in front of the camera. cermin finds the person, follows their body, hands and
face frame by frame, and puts the movement on a mannequin you can export.

```bash
python3 server.py          # opens in the browser
```

Nothing to install: the Python that comes with macOS, and a browser. The
tracking runs inside the page with MediaPipe, from models kept in this folder,
so a take never leaves the Mac.

## How a take goes

1. **In.** Upload an `.mp4`, `.mov` or `.webm` (or drop one on the window), or
   press **Record**. While recording, the camera is shown as a mirror with a
   quick tracker on it, so you can see you have been found before you start.
2. **Tracked.** Every frame is visited in turn (not played, so none are
   skipped) and run through three trackers: the body (33 points), the hands
   (21 points each) and the face (51 expression values). The raw points are
   saved.
3. **Solved.** The points become bone rotations on the mannequin: smoothed
   forwards and backwards so nothing lags, the camera levelled, the feet put
   on the floor, a jump kept as a jump. Changing anything under **Clean-up**
   re-solves immediately; nothing is tracked twice.
4. **Out.** `.glb` (mannequin + animation), `.fbx` (made by Blender), `.bvh`
   (skeleton only) and `face.csv` (the 51 face values per frame, ARKit names).
   Inside bengkel, **Send to gerak** hands the take across to be cleaned up by
   hand.

### Tracking: Best, Accurate, Fast

**Best** (the default) looks at every frame twice: MediaPipe, then DWPose -
a much larger model that places legs and feet far better under loose
clothes - folded back into 3D by bone length. About twice as slow as
**Accurate**. Its model is 134 MB and kept out of git:

```bash
tools/fetch-models.sh      # once, on a fresh copy
```

### The virtual floor

While tracking, cermin scans the floor beside the feet in every frame, so it
knows when the camera moves, turns or zooms. The feet stay on the floor, and
the body leaves it only for a real jump: the hips rise, the time in the air
fits gravity, the body is upright. A ring under the feet shows the floor.

### Clean-up

- **Keep planted feet still** - a foot on the floor is pinned to its spot and
  the leg bends to reach it, so feet do not slide.
- **Follow the person** - across the floor and toward or away from the
  camera, with the camera's own movement taken off. **Stay in place** keeps
  only the jumps.
- **Start here / End here** (or `I` / `O`) - trim the take. Playback loops
  inside it, and exports and gerak get only that part, starting on the spot.

Every take lives in `~/Documents/bengkel/cermin/takes/<date>-<name>/` with its
video, its raw capture and whatever was exported from it.

## Character choices

The default is cermin's own **standard mannequin**: 65 bones with Mixamo
names, articulated fingers and a face with 22 ARKit shapes, so an export opens
as a standard humanoid in Blender, Unreal and gerak.

The dropdown also offers a wooden mannequin, a human skeleton, a clothed
stylized man and a clothed stylized woman - downloaded, artist-made models
(see [model credits and licenses](web/characters/README.md)). The motion is
retargeted onto each model's own skeleton, and GLB and FBX then contain that
character with its textures. Those models have no expression shapes (the face
is still in `face.csv`), and the wooden mannequin has solid hands.

## Getting good captures

- The whole body in the picture, if the legs matter. With only the top half
  showing, cermin keeps the torso upright and the legs standing still.
- A camera that moves is fine - the floor scan takes it off - but a floor
  with some texture helps it. On a plain floor, a camera moving in reads as
  the person coming closer.
- Film from the front or the side. From behind, a single camera cannot tell
  how far forward a knee or an elbow is, and the mannequin shows that.
- One person, plain light, clothes that do not hide the joints.
- Hands and face need to be big enough to see: a full-body shot finds the body
  well and the fingers poorly. Film a second, closer take for hands and face.

## Tests

```bash
npm install          # once: playwright-core, for driving Chrome
npm test             # capture checks: upload, solve, export, reopen, record, close-up
node tests/smoke.mjs --fbx   # also make the .fbx through Blender MCP
node tests/characters.mjs   # all four rigs, textures, switches and GLB motion
```

The record test uses Chrome's fake camera, fed a video, so it runs without a
camera or anyone in front of one.

### Test videos

From Wikimedia Commons, trimmed:

- `jumping12.webm` — *Jumping jacks and burpees*, CC BY-SA 4.0
- `squat.webm` — *Squat - exercise demonstration video*, CC BY 3.0
- `signs10.webm` — *Alphabets - Ghanaian Sign Language*, by Uprising Man, CC0

## In bengkel

cermin is on bengkel's rail, between periksa and gerak, and still runs on its
own. It follows bengkel's tool contract - a token per run, an origin check, a
ready line (`@@CERMIN-READY@@`), `--no-open`, `BENGKEL_DATA`, `BENGKEL_PARENT`
- and `.fbx` goes through bengkel's shared Blender MCP. `web/common/` is a
copy of bengkel's shared look, so cermin works without bengkel next to it.
