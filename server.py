#!/usr/bin/env python3
"""
cermin — a mirror.

Motion capture from an ordinary video. Upload a clip of someone moving, or
stand in front of the camera and record one here, and cermin finds the person,
follows their body, hands and face frame by frame, and puts the movement on a
mannequin you can export to .glb, .bvh or .fbx.

The tracking itself happens in the page, with MediaPipe running in the
browser - nothing is uploaded anywhere. This server is the small part a page
cannot do on its own:

  * keep each take on disk, in ~/Documents/bengkel/cermin/takes/<take>/:
    the video, the raw capture, and whatever was exported from it
  * turn a .glb into an .fbx, through the shared Blender MCP

It is written to the same contract as every bengkel tool - a token per run,
an origin check, a ready line on stdout - so that moving it onto the rail is
one entry in bengkel's tools.json. Until then it runs on its own:

    python3 server.py            # opens in the browser
    python3 server.py --no-open  # for bengkel, or for tests

Nothing here needs installing: it is the Python that comes with macOS.
"""

import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
HOME = os.path.expanduser("~")

NAME = "cermin"
READY = "@@CERMIN-READY@@"

# The same port every run, on purpose. A browser remembers camera permission
# per origin, and the port is part of the origin - so a port chosen at random
# would mean being asked for the camera again every time cermin starts.
PREFERRED_PORT = 8794

DATA = os.environ.get("BENGKEL_DATA") or os.path.join(HOME, "Documents", "bengkel", NAME)
TAKES = os.path.join(DATA, "takes")

# bengkel's shared Blender client. cermin borrows it rather than carrying a
# second copy; if bengkel is not on this Mac, .fbx export says so and the
# other formats carry on working.
BENGKEL_COMMON = os.environ.get(
    "BENGKEL_COMMON", os.path.join(HOME, "Desktop", "projects", "3d", "bengkel", "common"))

# What a take may hold. Anything else is refused, so a page cannot be talked
# into writing a file with an arbitrary name.
TAKE_FILES = {
    "video.mp4", "video.webm", "video.mov", "video.m4v",
    "capture.json", "take.json",
    "cermin.glb", "cermin.bvh", "cermin.fbx", "face.csv", "thumb.jpg",
}

SAFE_TAKE = re.compile(r"^[0-9]{8}-[0-9]{6}(-[a-z0-9-]{1,40})?$")


def log(*parts):
    sys.stderr.write("[%s] %s\n" % (NAME, " ".join(str(p) for p in parts)))
    sys.stderr.flush()


# --------------------------------------------------------------------------
# takes
# --------------------------------------------------------------------------

def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:40]


def new_take(label):
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = stamp + ("-" + slug(label) if slug(label) else "")
    os.makedirs(os.path.join(TAKES, name), exist_ok=True)
    return name


def take_dir(name):
    if not name or not SAFE_TAKE.match(name):
        return None
    path = os.path.join(TAKES, name)
    return path if os.path.isdir(path) else None


def list_takes():
    if not os.path.isdir(TAKES):
        return []
    out = []
    for name in sorted(os.listdir(TAKES), reverse=True):
        folder = take_dir(name)
        if not folder:
            continue
        info = {}
        try:
            with open(os.path.join(folder, "take.json")) as f:
                info = json.load(f)
        except (OSError, ValueError):
            pass
        files = sorted(f for f in os.listdir(folder) if f in TAKE_FILES)
        if "capture.json" not in files:
            continue                        # never finished tracking
        out.append({"name": name, "files": files, **info})
    return out


# --------------------------------------------------------------------------
# .fbx, through the shared Blender
# --------------------------------------------------------------------------

def to_fbx(folder):
    """Convert a take's cermin.glb to cermin.fbx inside the shared Blender."""
    source = os.path.join(folder, "cermin.glb")
    target = os.path.join(folder, "cermin.fbx")
    if not os.path.isfile(source):
        return {"ok": False, "problem": "Export the .glb first - the .fbx is made from it."}
    if not os.path.isfile(os.path.join(BENGKEL_COMMON, "mcp.py")):
        return {"ok": False, "problem": "The .fbx is made in Blender through bengkel, "
                                        "and bengkel's common folder was not found."}
    sys.path.insert(0, BENGKEL_COMMON)
    try:
        import mcp                                      # noqa: E402
    finally:
        sys.path.remove(BENGKEL_COMMON)

    fps = 30
    try:
        with open(os.path.join(folder, "capture.json")) as f:
            fps = json.load(f).get("fps", 30)
    except (OSError, ValueError):
        pass
    job = os.path.join(folder, ".fbx-job.json")
    with open(job, "w") as f:
        json.dump({"source": source, "target": target, "fps": fps}, f)
    started = time.time()
    try:
        printed = mcp.run_job(os.path.join(HERE, "blender", "to_fbx.py"), [job],
                              label=NAME, timeout=300)
    except mcp.BlenderError as exc:
        return {"ok": False, "problem": str(exc)}
    finally:
        try:
            os.remove(job)
        except OSError:
            pass
    for line in printed.splitlines():
        if line.startswith("@@JOB@@"):
            answer = json.loads(line[len("@@JOB@@"):])
            answer["seconds"] = round(time.time() - started, 1)
            return answer
    return {"ok": False, "problem": "Blender said nothing back. " +
            " / ".join(printed.strip().splitlines()[-3:])}


# --------------------------------------------------------------------------
# the server
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    token = ""
    bound = 0

    def log_message(self, fmt, *args):
        pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError):
            self.close_connection = True

    # -- guards ------------------------------------------------------------

    def authorised(self):
        # A server on localhost is reachable by every page in the browser, so
        # it answers only its own page, and only with this run's token.
        origin = self.headers.get("Origin")
        if origin and origin not in ("http://127.0.0.1:%d" % self.bound,
                                     "http://localhost:%d" % self.bound):
            return False
        query = parse_qs(urlparse(self.path).query)
        given = self.headers.get("X-Bengkel-Token") or (query.get("t") or [""])[0]
        return secrets.compare_digest(given, self.token)

    # -- replies -----------------------------------------------------------

    def end_headers(self):
        # Cross-origin isolated, so the refining model may use several threads
        # (SharedArrayBuffer). Everything the page loads is its own, so nothing
        # is lost by it.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def send_bytes(self, body, ctype, status=200):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, status=200):
        self.send_bytes(json.dumps(obj).encode("utf-8"), "application/json", status)

    def send_file(self, path):
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if path.endswith((".js", ".mjs")):
            ctype = "text/javascript; charset=utf-8"
        elif path.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif path.endswith(".wasm"):
            ctype = "application/wasm"
        elif path.endswith(".webm"):
            ctype = "video/webm"
        try:
            size = os.path.getsize(path)
        except OSError:
            return self.send_json({"error": "cannot read that file"}, 404)

        # Videos are asked for in ranges - a <video> will not seek without it.
        wanted = self.headers.get("Range")
        start, end = 0, size - 1
        if wanted and wanted.startswith("bytes="):
            a, _, b = wanted[6:].partition("-")
            try:
                start = int(a) if a else max(0, size - int(b))
                end = int(b) if (a and b) else size - 1
            except ValueError:
                start, end = 0, size - 1
            end = min(end, size - 1)
        length = max(0, end - start + 1)
        self.send_response(206 if wanted else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if wanted:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def under(self, base, rest):
        full = os.path.realpath(os.path.join(base, rest))
        if not full.startswith(os.path.realpath(base) + os.sep):
            return None
        return full

    def read_raw(self, limit=2 << 30):
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise ValueError("too large")
        data = bytearray()
        while len(data) < length:
            chunk = self.rfile.read(min(1 << 20, length - len(data)))
            if not chunk:
                break
            data += chunk
        return bytes(data)

    def read_json(self):
        try:
            return json.loads(self.read_raw(64 << 20).decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            return {}

    # -- GET ---------------------------------------------------------------

    def do_GET(self):
        url = urlparse(self.path)
        path, query = url.path, parse_qs(url.query)

        if path in ("/", "/index.html"):
            with open(os.path.join(WEB, "index.html")) as f:
                page = f.read()
            page = (page.replace("__BENGKEL_TOKEN__", self.token)
                        .replace("__BENGKEL_TOOL__", NAME))
            return self.send_bytes(page.encode("utf-8"), "text/html; charset=utf-8")

        # The page's own files, and the shared bengkel look (a copy, in
        # web/common/, until cermin moves onto the rail).
        for prefix, base in (("/web/", WEB), ("/common/", os.path.join(WEB, "common"))):
            if path.startswith(prefix):
                full = self.under(base, path[len(prefix):])
                return self.send_file(full) if full else self.send_json({"error": "no"}, 403)

        if path == "/favicon.ico":
            return self.send_bytes(b"", "image/x-icon", 204)

        if not self.authorised():
            return self.send_json({"error": "not authorised"}, 403)

        if path == "/api/takes":
            return self.send_json({"takes": list_takes(), "folder": TAKES.replace(HOME, "~")})

        if path == "/api/take-file":
            folder = take_dir((query.get("take") or [""])[0])
            name = unquote((query.get("name") or [""])[0])
            if not folder or name not in TAKE_FILES:
                return self.send_json({"error": "no such take file"}, 404)
            return self.send_file(os.path.join(folder, name))

        return self.send_json({"error": "unknown"}, 404)

    # -- POST --------------------------------------------------------------

    def do_POST(self):
        url = urlparse(self.path)
        path, query = url.path, parse_qs(url.query)
        if not self.authorised():
            return self.send_json({"error": "not authorised"}, 403)

        if path == "/api/take":
            body = self.read_json()
            name = new_take(body.get("label", ""))
            log("new take", name)
            return self.send_json({"take": name})

        if path == "/api/take-file":
            # Raw bytes in the body, so a 200 MB video is not base64'd into JSON.
            folder = take_dir((query.get("take") or [""])[0])
            name = (query.get("name") or [""])[0]
            if not folder or name not in TAKE_FILES:
                return self.send_json({"error": "no such take file"}, 400)
            try:
                data = self.read_raw()
            except ValueError:
                return self.send_json({"error": "that file is over 2 GB"}, 413)
            with open(os.path.join(folder, name + ".part"), "wb") as f:
                f.write(data)
            os.replace(os.path.join(folder, name + ".part"), os.path.join(folder, name))
            return self.send_json({"ok": True, "bytes": len(data),
                                   "path": os.path.join(folder, name)})

        if path == "/api/fbx":
            folder = take_dir(self.read_json().get("take", ""))
            if not folder:
                return self.send_json({"error": "no such take"}, 404)
            answer = to_fbx(folder)
            log("fbx:", "ok" if answer.get("ok") else answer.get("problem"))
            return self.send_json(answer)

        if path == "/api/reveal":
            folder = take_dir(self.read_json().get("take", ""))
            if not folder:
                return self.send_json({"error": "no such take"}, 404)
            subprocess.Popen(["open", folder])
            return self.send_json({"ok": True})

        if path == "/api/delete-take":
            folder = take_dir(self.read_json().get("take", ""))
            if not folder:
                return self.send_json({"error": "no such take"}, 404)
            # To the Trash rather than gone, so a slip can be undone in Finder.
            trash = os.path.join(HOME, ".Trash", os.path.basename(folder))
            shutil.move(folder, trash if not os.path.exists(trash)
                        else trash + "-" + secrets.token_hex(3))
            return self.send_json({"ok": True})

        return self.send_json({"error": "unknown"}, 404)


def watch_parent():
    """Leave when bengkel goes, so a force-quit does not leave a port held."""
    if not os.environ.get("BENGKEL_PARENT"):
        return
    started_under = os.getppid()

    def watch():
        while True:
            time.sleep(1)
            if os.getppid() != started_under:
                os._exit(0)
    threading.Thread(target=watch, daemon=True).start()


def main(argv):
    os.makedirs(TAKES, exist_ok=True)
    Handler.token = secrets.token_urlsafe(18)

    wanted = os.environ.get("CERMIN_PORT")
    ports = [int(wanted)] if wanted else [PREFERRED_PORT, 0]
    server = None
    for port in ports:
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError as err:
            if err.errno != 48:
                raise
            log("port %d is already in use" % port)
    if not server:
        return 1

    Handler.bound = server.server_address[1]
    url = "http://127.0.0.1:%d/?t=%s" % (Handler.bound, Handler.token)
    log("cermin is running")
    log(url)
    print("%s%s" % (READY, json.dumps({"url": url, "port": Handler.bound,
                                       "token": Handler.token, "data": DATA})), flush=True)
    watch_parent()
    if "--no-open" not in argv:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
