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
   on the floor, a jump kept as a jump. Changing **Smoothing** or **Moving
   around** re-solves immediately; nothing is tracked twice.
4. **Out.** `.glb` (mannequin + animation), `.fbx` (made by Blender), `.bvh`
   (skeleton only) and `face.csv` (the 51 face values per frame, ARKit names).

Every take lives in `~/Documents/bengkel/cermin/takes/<date>-<name>/` with its
video, its raw capture and whatever was exported from it.

## The mannequin

One standard humanoid, 65 bones, Mixamo names (`Hips`, `Spine`, `LeftArm`,
`LeftHandIndex1`…) so Blender, Unreal's IK Retargeter and gerak recognise it.
T-pose, facing +Z, 1.79 m. Its face has 22 ARKit shape keys - blinks, brows,
jaw, smile, pucker - and the full 51 are in the `.csv` for a character that
has them all.

## Getting good captures

- The whole body in the picture, if the legs matter. With only the top half
  showing, cermin keeps the torso upright and the legs standing still.
- A camera that does not move. cermin follows the person across the picture,
  so a moving camera reads as the person moving.
- One person, plain light, clothes that do not hide the joints.
- Hands and face need to be big enough to see: a full-body shot finds the body
  well and the fingers poorly. Film a second, closer take for hands and face.

## Tests

```bash
npm install          # once: playwright-core, for driving Chrome
npm test             # upload, solve, export, reopen, record, close-up
node tests/smoke.mjs --fbx   # also make the .fbx through Blender MCP
```

The record test uses Chrome's fake camera, fed a video, so it runs without a
camera or anyone in front of one.

### Test videos

From Wikimedia Commons, trimmed:

- `jumping12.webm` — *Jumping jacks and burpees*, CC BY-SA 4.0
- `squat.webm` — *Squat - exercise demonstration video*, CC BY 3.0
- `signs10.webm` — *Alphabets - Ghanaian Sign Language*, by Uprising Man, CC0

## Joining bengkel

cermin is written to the same contract as bengkel's tools — a token per run,
an origin check, a ready line (`@@CERMIN-READY@@`), `--no-open`,
`BENGKEL_DATA` and `BENGKEL_PARENT` — so joining the rail is an entry in
bengkel's `tools.json`. `web/common/` is a copy of bengkel's shared look and
goes away when it moves in. `.fbx` already goes through bengkel's shared
Blender MCP.
