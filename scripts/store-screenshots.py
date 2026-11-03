#!/usr/bin/env python3
"""Google Play screenshots and a promo video from the Android emulator.

Against a running emulator with a Release build installed (a store build: DISTRIBUTION=store, UPDATES_ORIGIN set, so
maps download). It wipes the app's data, goes through first run like a new user, downloads the Kyiv region, puts the
car in Kyiv with emulated GPS and drives it along a demo trip with the app's emulated STN adapter (Developer › Show
emulated adapters): its OBD speed, and the car's CAN broadcast with the four wheels turning as the car does, so the
app checks the wheels against OBD and then drives on them (VEHICLE-LINK-SPEC §16). GPS, its speed and the phone's
gyro follow the same drive. It shoots:

  01-guidance   a route being guided, GPS trusted, the speed limit sign
  02-spoofed    GPS jumped abroad: "GPS looks spoofed", the car carries on along the road on its own
  03-camera     a speed camera ahead with the car too fast: "Slow down"
  04-stops      fuel along the route with each one's detour, mid-drive (Route tab › Fuel)
  05-route      the destination card with an alternative route on the map
  06-search     address search
  07-parking    parking near the destination
  08-maps       Offline maps

The demo trip: from START the driver searches Ocean Plaza (DESTINATION), the app finds the route and an alternative,
guidance starts; GPS jumps abroad after the first turn (SPOOF_AT_M) and stays wrong; on the way the driver adds the
Socar station (STOP) from the Route tab, the car pulls in, stands and drives on; it speeds past 70 towards the camera on
the boulevard and slows; the limit drops to 40 and 30 before the destination. The car's path is the trip through the
station, planned before the drive with the app's planner on the released Kyiv graph (tools/replay/route.ts), and
checked against the routes the app plans (logged as `wtf-demo-route` while emulated adapters are shown).

At 1080x2160, the tallest Play takes (it refuses a long side more than twice the short one; the emulator's own
1080x2400 is 2.22:1), with a clean status bar (demo mode). --lang uk shoots the app in Ukrainian from its first screen
(Android's per-app language), --dark the dark theme, --video records it all with its sound for a promo video: on the
host (scripts/emulator-record.py, the emulator's gRPC screen and audio streams, needs the emulator started with
-grpc), cropped to the screen, then cut to the scenes (the drive between them left out, driving at 2x and the rest at
1.5x, crossfading; the emulator's sound dropouts bridged; `promo*.scenes.json` lists them, the whole recording stays as
`*.source.mp4`, and --recut cuts it again). --no-gyro keeps the phone still: the app turns by the wheels alone,
as in the iOS Simulator. Leaves the emulator's size, theme and status bar as they were.

    python scripts/store-screenshots.py out-dir
    python scripts/store-screenshots.py out-dir --lang uk --dark --video
    python scripts/store-screenshots.py out-dir --recut      # the promo cut again from out-dir's recording

The current sets are in store-assets/play/ (Git LFS): light/, dark/, uk-light/, uk-dark/ and promo[-uk][-dark].mp4. The
website's screenshots and videos are made from them (scripts/site-media.sh), so re-run after UI changes.
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import wave
import xml.etree.ElementTree as ET

from emulator_grpc import connect

PKG = "ai.wtf.navigator"
SIZE = "1080x2160"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPDATES = "https://updates.wtf-ai.uk/maps"
# The demo trip: the car stands on a Pechersk street facing along it, the driver goes to Ocean Plaza, adding the Socar
# station on the way (on the right). Ocean Plaza is typed in Latin in both languages (`adb shell input text` types
# ASCII only) and found by that name in both.
START, START_HEADING = (50.42810, 30.54740), 20.0
DESTINATION, DESTINATION_AT = "Ocean Plaza", (50.41234, 30.52230)
STOP, STOP_NAME = (50.423116, 30.554046), "Socar"
# Metres along the trip: the guidance shot (GPS trusted, before the first turn at ~186 m), GPS jumping abroad after it,
# the driver adding the stop (well before the station at ~1.77 km), the spoofed shot, the 40 and 30 zones before the
# destination (the car keeps under them: one speed warning, the camera's, is enough).
GUIDANCE_AT_M, SPOOF_AT_M, STOP_ADD_AT_M, SPOOFED_SHOT_AT_M, SLOW_END_FROM_M = 120, 300, 600, 1250, 4450
# The video's last scene from here: just before the 40 sign (~4.6 km), on to the destination.
ARRIVE_SCENE_FROM_M = 4560
# The car: stands this long after the adapter connects (the app checks the wheels against OBD standing too), then
# drives the trip at these speeds, stands at the station and stops at its end.
STAND_S, STOP_STAND_S, CRUISE_KMH, BEND_KMH, TURN_KMH, END_KMH = 25, 8, 50, 32, 20, 36
ACCEL_MS2, BRAKE_MS2 = 1.3, 1.8
# Before the camera: this fast from this far before it to this near (past a 50 limit's +15 margin: "Slow down"), then
# down to CAMERA_KMH at it.
SPEEDING_KMH, SPEEDING_FROM_M, SPEEDING_TO_M, CAMERA_KMH = 72, 550, 160, 45
GRPC_PORT = 8554
# How long a tap holds the screen: a finger's (a long press is 500 ms).
TAP_MS = 180
# What the scripted taps look for after first run, per app language (src/i18n/en.ts, uk.ts).
LABELS = {
    "en": {
        "locale": "", "get_started": "Get started", "allow": "Allow while using the app", "skip": "Skip for now",
        "done": "Done", "regions": "Regions", "kyiv": "Kyiv", "download": "Download", "map_setup": "Download a map",
        "trusted": "Position trusted", "not_now": "Not now", "fw_skip": "Skip",
        "route": "Route", "search": "Search addresses and places", "finding_alternatives": "Looking for other routes…",
        "start": "Start guidance", "agree": "I'll follow the route", "stop_guidance": "Stop guidance",
        "fuel": "Fuel", "parking": "Parking", "parking_for": "Near {name}",
    },
    "uk": {
        "locale": "uk-UA", "get_started": "Почати", "allow": "Дозволити під час використання", "skip": "Поки що пропустити",
        "done": "Готово", "regions": "Регіони", "kyiv": "Київ", "download": "Завантажити", "map_setup": "Завантажте мапу",
        "trusted": "Позиція надійна", "not_now": "Не зараз", "fw_skip": "Пропустити",
        "route": "Маршрут", "search": "Пошук адрес і місць", "finding_alternatives": "Шукаємо інші маршрути…",
        "start": "Почати навігацію", "agree": "Їхатиму за маршрутом", "stop_guidance": "Зупинити навігацію",
        "fuel": "АЗС", "parking": "Стоянки", "parking_for": "Поруч із «{name}»",
    },
}
ABROAD = (44.0, 35.0)
KNOT_MPS = 1852 / 3600
ADAPTER = "Emulator · OBDLink (STN)"
# The recording: the emulator's frames over gRPC, H.264 on the GPU (scripts/emulator-record.py). 30 fps: the tilted
# moving map draws ~22 fps in the emulator, so 60 only repeated frames.
VIDEO_FPS = 30
# The promo's cut: the drive between scenes left out, driving at twice its speed and the rest (planning, parking,
# adding the stop, whose taps are to be followed, the maps) at 1.5, the scenes crossfading into each other.
DRIVING_SCENES = {"drive-off", "spoof", "pull-in", "camera", "arrive"}
DRIVE_SPEED, OTHER_SPEED = 2.0, 1.5
CROSSFADE_S = 0.4
AUDIO_RATE = 48000

ADB = os.environ.get("ADB") or os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "Sdk", "platform-tools", "adb.exe")
if not os.path.exists(ADB):
    ADB = "adb"
env = dict(os.environ, MSYS_NO_PATHCONV="1")  # Git Bash would rewrite /sdcard paths.
FAIL_DIR = None  # where a timed-out wait leaves a screenshot


def adb(*args, timeout=60):
    try:
        return subprocess.run([ADB, *args], capture_output=True, env=env, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 1, b"", b"timeout")


def shell(*args, timeout=60):
    return adb("shell", *args, timeout=timeout)


def _leg(a, b):
    """(metres, bearing in degrees) from a to b, (lat, lon) pairs."""
    dy = (b[0] - a[0]) * 111_320
    dx = (b[1] - a[1]) * 111_320 * math.cos(math.radians(a[0]))
    return math.hypot(dx, dy), math.degrees(math.atan2(dx, dy)) % 360


def _turn(a, b):
    """Signed degrees from bearing a to bearing b (right positive)."""
    return (b - a + 180) % 360 - 180


def _interp(points, x):
    """Straight between (x, y) points in x order; the ends held."""
    if x <= points[0][0]:
        return points[0][1]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x <= x1:
            return y0 if x1 == x0 else y0 + (x - x0) / (x1 - x0) * (y1 - y0)
    return points[-1][1]


class Drive:
    """The car on its path: a speed profile in time (the emulated adapter drives it, sent in the link that opens it), the
    car's heading in time (its wheels turn by it), and where the car is and which way it faces at any moment of it, from
    the very same profile. `stands`: metres → seconds standing there; `caps`: (from m, to m, km/h) in place of the
    speed the bends allow."""

    def __init__(self, route, stands=(), caps=()):
        self.route = route
        legs = [_leg(a, b) for a, b in zip(route, route[1:])]
        self.cum = [0.0]
        for m, _ in legs:
            self.cum.append(self.cum[-1] + m)
        self.bearings = [b for _, b in legs]
        self.length = self.cum[-1]
        # Speed limit along the route, every 2 m: slower where the heading changes over the next/last 15 m.
        step = 2.0
        grid = [i * step for i in range(int(self.length / step) + 1)] + [self.length]
        limit = []
        for s in grid:
            change = abs(_turn(self.heading_at(max(0.0, s - 15)), self.heading_at(min(self.length, s + 15))))
            kmh = CRUISE_KMH if change < 20 else BEND_KMH if change < 55 else TURN_KMH
            for a, b, cap in caps:
                if a <= s <= b:
                    kmh = min(cap, kmh) if change >= 20 else cap
            limit.append(kmh)
        v = [x / 3.6 for x in limit]
        stand_at = {min(range(len(grid)), key=lambda i: abs(grid[i] - m)): s for m, s in stands}
        v[0] = v[-1] = 0.0
        for i in stand_at:
            v[i] = 0.0
        for i in range(1, len(grid)):  # can't speed up faster than ACCEL
            v[i] = min(v[i], math.sqrt(v[i - 1] ** 2 + 2 * ACCEL_MS2 * (grid[i] - grid[i - 1])))
        for i in range(len(grid) - 2, -1, -1):  # nor brake harder than BRAKE
            v[i] = min(v[i], math.sqrt(v[i + 1] ** 2 + 2 * BRAKE_MS2 * (grid[i + 1] - grid[i])))
        # In time: (s, m/s) at each grid point, a stand as two points at 0; then a point a second, as the adapter reads.
        t, samples = 0.0, [(0.0, 0.0)]
        for i in range(1, len(grid)):
            t += (grid[i] - grid[i - 1]) / max((v[i] + v[i - 1]) / 2, 0.3)
            samples.append((t, v[i]))
            if i in stand_at:
                t += stand_at[i]
                samples.append((t, 0.0))
        self.profile = [(0.0, 0.0), (float(STAND_S), 0.0)]
        for k in range(1, math.ceil(t) + 1):
            self.profile.append((STAND_S + k, round(_interp(samples, k) * 3.6, 1)))
        self.profile.append((STAND_S + math.ceil(t) + 1, 0.0))

    def spec(self):
        """The profile as the link's `cycle`: seconds:km/h, comma-separated."""
        return ",".join(f"{t:g}:{kmh:g}" for t, kmh in self.profile)

    def turn_spec(self):
        """The heading in time as the link's `turn`: seconds:degrees (unwrapped), every 0.5 s where it turns."""
        pts, last, h = [], None, 0.0
        for k in range(int(self.profile[-1][0] * 2) + 1):
            t = k / 2
            b = self.heading_at(self.metres_at(t))
            h = b if last is None else h + _turn(last, b)
            last = b
            pts.append((t, round(h, 1)))
        # Only where the rate changes: straight between the points left.
        kept = [pts[0]] + [p for i, p in enumerate(pts[1:-1], 1)
                           if abs((p[1] - pts[i - 1][1]) - (pts[i + 1][1] - p[1])) > 0.05] + [pts[-1]]
        return ",".join(f"{t:g}:{deg:g}" for t, deg in kept)

    def kmh_at(self, t):
        return _interp(self.profile, t)

    def metres_at(self, t):
        """Distance driven `t` s after the adapter connected: the profile integrated (straight between its points)."""
        d = 0.0
        for (t0, v0), (t1, v1) in zip(self.profile, self.profile[1:]):
            if t <= t0:
                break
            te = min(t, t1)
            ve = v0 + (te - t0) / (t1 - t0) * (v1 - v0)
            d += (v0 + ve) / 2 / 3.6 * (te - t0)
        return min(d, self.length)

    def time_at(self, metres):
        """The first moment the car has driven `metres`."""
        lo, hi = 0.0, self.profile[-1][0]
        for _ in range(40):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if self.metres_at(mid) < metres else (lo, mid)
        return hi

    def point_at(self, metres):
        for i in range(len(self.route) - 1):
            if metres <= self.cum[i + 1]:
                f = (metres - self.cum[i]) / max(self.cum[i + 1] - self.cum[i], 1e-9)
                (lat1, lon1), (lat2, lon2) = self.route[i], self.route[i + 1]
                return lat1 + f * (lat2 - lat1), lon1 + f * (lon2 - lon1)
        return self.route[-1]

    def heading_at(self, metres):
        """The car's heading: the leg's bearing, turning smoothly over 8 m either side of each vertex."""
        i = next((j for j in range(len(self.bearings)) if metres <= self.cum[j + 1]), len(self.bearings) - 1)
        b = self.bearings[i]
        if i + 1 < len(self.bearings) and self.cum[i + 1] - metres < 8:
            f = (8 - (self.cum[i + 1] - metres)) / 16
            return (b + f * _turn(b, self.bearings[i + 1])) % 360
        if i > 0 and metres - self.cum[i] < 8:
            f = (8 - (metres - self.cum[i])) / 16
            return (b - f * _turn(self.bearings[i - 1], b)) % 360
        return b

    def project(self, p):
        """(metres along, metres off) of the path's nearest point to p."""
        best = (0.0, float("inf"))
        kx = 111_320 * math.cos(math.radians(p[0]))
        for i, (a, b) in enumerate(zip(self.route, self.route[1:])):
            ax, ay = (a[1] - p[1]) * kx, (a[0] - p[0]) * 111_320
            bx, by = (b[1] - p[1]) * kx, (b[0] - p[0]) * 111_320
            dx, dy = bx - ax, by - ay
            f = max(0.0, min(1.0, -(ax * dx + ay * dy) / max(dx * dx + dy * dy, 1e-9)))
            off = math.hypot(ax + f * dx, ay + f * dy)
            if off < best[1]:
                best = (self.cum[i] + f * (self.cum[i + 1] - self.cum[i]), off)
        return best


def fetch(url):
    # The update server refuses urllib's own User-Agent.
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "wtf.ai store-screenshots"})).read()


def release_files(cache_dir):
    """The released Kyiv graph and camera list (the ones the store build downloads): their paths."""
    date = json.loads(fetch(f"{UPDATES}/latest.json"))["osm_date"]
    index = json.loads(fetch(f"{UPDATES}/{date}/index.json"))
    region = next(r for r in index["regions"] if r["name"]["en"] == "Kyiv")
    out = os.path.join(cache_dir, date)
    os.makedirs(out, exist_ok=True)
    paths = []
    for asset in (region["graph"]["asset"], "cameras.json"):
        path = os.path.join(out, asset)
        if not os.path.exists(path):
            with open(path + ".part", "wb") as f:
                f.write(fetch(f"{UPDATES}/{date}/{asset}"))
            os.replace(path + ".part", path)
        paths.append(path)
    return paths


def plan_trip(graph, out_dir):
    """The trip START → STOP → DESTINATION as the app plans it (its router on the released graph): the path as (lat,
    lon) points, and the station's point on it."""
    geojson = os.path.join(out_dir, "demo-trip.geojson")
    subprocess.run(
        ["node", "--experimental-transform-types", "--no-warnings", "--import", "./tools/replay/register.mjs",
         "tools/replay/route.ts", "--from", f"{START[0]},{START[1]},{START_HEADING:g}", "--via", f"{STOP[0]},{STOP[1]}",
         "--to", f"{DESTINATION_AT[0]},{DESTINATION_AT[1]}", "--graph", graph, "--geojson", geojson],
        cwd=ROOT, check=True, capture_output=True)
    features = json.load(open(geojson, encoding="utf-8"))["features"]
    line = next(f for f in features if f["geometry"]["type"] == "LineString")["geometry"]["coordinates"]
    stop = next(f for f in features if f["geometry"]["type"] == "Point" and f["properties"]["kind"] == "stop")
    lon, lat = stop["geometry"]["coordinates"]
    return [(la, lo) for lo, la in line], (lat, lon)


def camera_on(drive, cameras_json):
    """Metres along the path of the first camera on it facing the way the car goes (within 30 m, ±45°)."""
    for lat, lon, bearing, _limit, _flags in json.load(open(cameras_json, encoding="utf-8"))["cameras"]:
        m, off = drive.project((lat, lon))
        if off <= 30 and (bearing < 0 or abs(_turn(drive.heading_at(m), bearing)) <= 45):
            return m
    raise SystemExit("no camera on the demo trip: has the released camera list changed?")


def max_off(drive, points, from_m=0.0, skip_near=None):
    """How far (m) the furthest of `points` lies from the path: those from `from_m` on, none within 250 m of
    `skip_near` (a route without the stop passes the station's forecourt by on the road)."""
    offs = []
    for p in points:
        if skip_near and _leg(p, skip_near)[0] < 250:
            continue
        m, off = drive.project(p)
        if m >= from_m - 50:
            offs.append(off)
    return max(offs, default=0.0)


ROW = re.compile(r"^(?P<name>[^,]+), .*?(?P<d>\d+(?:\.\d+)?)\xa0(?P<u>km|m|км|м)(?:,|$)")


def place_rows():
    """The rows of a list of places along the route: (name, metres ahead, y) from the top, read from their labels
    ("Socar, right · diesel, 95 · 24/7, 545 m, +1 min")."""
    rows = []
    for label, _x, y in nodes():
        m = ROW.match(label)
        if m:
            rows.append((m["name"], float(m["d"]) * (1000 if m["u"] in ("km", "км") else 1), y))
    return sorted(rows, key=lambda r: r[2])


def row_when_ahead(rows, name, driven_m):
    """Where `name`'s row will be once the car has driven `driven_m` from where `rows` were read: the rows of places
    it has passed by then are gone, the rest move up (one row's height each)."""
    i = next((k for k, r in enumerate(rows) if r[0] == name), None)
    if i is None or len(rows) < 2:
        raise SystemExit(f"no {name} among the places along the route: {[r[0] for r in rows]}")
    pitch = rows[1][2] - rows[0][2]
    if any(driven_m - 50 <= d <= driven_m + 250 for _, d, _ in rows[:i]):
        print(f"a place near where the stop is added ({driven_m:.0f} m): {name}'s row may be off by one", flush=True)
    gone = sum(1 for _, d, _ in rows[:i] if d < driven_m + 100)
    return rows[i][2] - gone * pitch


class Car:
    """Moves the emulator's phone with the car, over its gRPC interface (emulator -grpc GRPC_PORT): a GPS fix with
    the car's course and speed every second, and the phone turned with the car 20 times a second, so its gyroscope
    feels each turn as in a car (`rotate` False: it stays still, the wheels alone tell the turns). Before
    `follow(drive, t0)` the car stands at START facing START_HEADING; with `pos` set, GPS reports there, standing (a
    spoof)."""

    def __init__(self, port=GRPC_PORT, rotate=True):
        self.drive = None
        self.rotate = rotate
        self.pb, self.stub = connect(port)
        model = self.pb.PhysicalModelValue
        rot = self.stub.getPhysicalModel(model(target=model.ROTATION)).value.data
        self.rot0 = list(rot)  # the phone upright in its mount: y is the vertical axis
        # The emulator's phone at rest faces north (its compass reads 0°): turned by the car's whole heading it faces
        # the way the car goes, as a phone in a holder does, its compass with it. (Turned only by the change from
        # START_HEADING, its compass read 20° left of the car all drive.)
        self.heading0 = 0.0
        self.pos = None
        self.t0 = None
        self.stopped = threading.Event()
        threading.Thread(target=self.run, daemon=True).start()

    def follow(self, drive, t0):
        self.drive, self.t0 = drive, t0

    def upright(self):
        """The phone as it was: facing the way it started."""
        model = self.pb.PhysicalModelValue
        self.stub.setPhysicalModel(model(target=model.ROTATION, value=self.pb.ParameterValue(data=self.rot0)))

    def run(self):
        model = self.pb.PhysicalModelValue
        next_fix = 0.0
        while not self.stopped.is_set():
            now = time.time()
            drive = self.drive
            t = now - self.t0 if drive else 0.0
            m = drive.metres_at(t) if drive else 0.0
            heading = drive.heading_at(m) if drive else START_HEADING
            if self.rotate:
                # A right turn is clockwise seen from above: negative about the phone's vertical axis.
                yaw = -_turn(self.heading0, heading)
                self.stub.setPhysicalModel(model(target=model.ROTATION, value=self.pb.ParameterValue(
                    data=[self.rot0[0], self.rot0[1] + yaw, self.rot0[2]])))
            if now >= next_fix:
                next_fix = now + 1
                if self.pos:
                    (lat, lon), speed, course = self.pos, 0.0, 0.0
                else:
                    (lat, lon) = drive.point_at(m) if drive else START
                    speed, course = (drive.kmh_at(t) / 3.6 if drive else 0.0), heading
                # The app refuses fixes without satellites. The emulator takes the speed in knots: in m/s the phone read
                # half the car's speed, and the app, trusting GPS, learned that the wheels read 20 % fast.
                self.stub.setGps(self.pb.GpsState(passiveUpdate=False, latitude=lat, longitude=lon, speed=speed / KNOT_MPS,
                                                  bearing=course, altitude=170, satellites=9))
            time.sleep(0.05)


def nodes():
    """The screen's labelled nodes; [] while it never goes idle (an animating map), never an old dump."""
    for _ in range(4):
        shell("rm", "-f", "/sdcard/wtf-ui.xml")
        dumped = shell("uiautomator", "dump", "/sdcard/wtf-ui.xml").stdout
        xml = adb("exec-out", "cat", "/sdcard/wtf-ui.xml").stdout if b"dumped" in dumped else b""
        if xml.startswith(b"<?xml"):
            break
        time.sleep(1)
    else:
        return []
    out = []
    for n in ET.fromstring(xml).iter("node"):
        label = n.get("text") or n.get("content-desc") or ""
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", n.get("bounds", ""))
        if label and m:
            x1, y1, x2, y2 = map(int, m.groups())
            out.append((label, (x1 + x2) // 2, (y1 + y2) // 2))
    return out


def find(text, exact=True):
    for label, x, y in nodes():
        if label == text or (not exact and text.lower() in label.lower()):
            return x, y
    return None


def wait_for(text, seconds=60, exact=True):
    end = time.time() + seconds
    while time.time() < end:
        at = find(text, exact)
        if at:
            return at
        time.sleep(1)
    if FAIL_DIR:
        with open(os.path.join(FAIL_DIR, "timeout.png"), "wb") as f:
            f.write(adb("exec-out", "screencap", "-p").stdout)
    raise SystemExit(f"timed out waiting for {text!r} (screen: timeout.png)")


def wait_gone(text, seconds=30, exact=False):
    end = time.time() + seconds
    while time.time() < end and find(text, exact):
        time.sleep(1)


def tap(x, y):
    """A finger's tap: held TAP_MS, so the button's pressed look shows on the recording before the screen answers (an
    `input tap` lets go at once, and the next screen came before the press could be seen)."""
    shell("input", "touchscreen", "swipe", str(x), str(y), str(x), str(y), str(TAP_MS))


def tap_text(text, seconds=30, exact=True):
    tap(*wait_for(text, seconds, exact))
    time.sleep(1.5)


def tap_if(text):
    at = find(text)
    if at:
        tap(*at)
        time.sleep(1.5)


def tap_when(text, seconds):
    """Taps `text` if it shows within `seconds` (a prompt that comes a moment after the screen)."""
    end = time.time() + seconds
    while time.time() < end:
        at = find(text)
        if at:
            tap(*at)
            time.sleep(1.5)
            return True
        time.sleep(1)
    return False


def keyboard_language(lang):
    """Gboard typing in `lang` (one of its enabled languages): the selected subtype, as Settings › Languages would set
    it. Returns the one it replaced, to put back. (Gboard keeps the language it was last switched to: the English video
    showed a Ukrainian keyboard after a Ukrainian run.)"""
    was = shell("settings", "get", "secure", "selected_input_method_subtype").stdout.decode().strip()
    enabled = shell("settings", "get", "secure", "enabled_input_methods").stdout.decode().strip()
    gboard = next((m for m in enabled.split(":") if m.startswith("com.google.android.inputmethod.latin/")), "")
    hashes = set(gboard.split(";")[1:])
    dump = shell("dumpsys", "input_method").stdout.decode(errors="replace")
    for tag, code in re.findall(r"mSubtypeLanguageTag=(\S+) .*?mSubtypeHashCode=(-?\d+)", dump):
        if code in hashes and tag.split("-")[0] == lang:
            shell("settings", "put", "secure", "selected_input_method_subtype", code)
            # Gboard reads it when it starts: a running one kept its language (a Ukrainian take typed in English).
            shell("am", "force-stop", "com.google.android.inputmethod.latin")
            shell("ime", "set", gboard.split(";")[0])
            break
    else:
        print(f"Gboard has no {lang} keyboard enabled: typing in its current one", flush=True)
    return was


def back():
    shell("input", "keyevent", "4")
    time.sleep(1.5)


def swipe_up():
    shell("input", "swipe", "540", "1500", "540", "700", "400")
    time.sleep(1)


def planned_route(seconds=20):
    """The route the app planned last (its `wtf-demo-route` line in logcat): (lat, lon) points."""
    end = time.time() + seconds
    while time.time() < end:
        lines = [l for l in adb("logcat", "-d", "-s", "ReactNativeJS:I").stdout.decode("utf-8", "replace").splitlines()
                 if "wtf-demo-route " in l]
        if lines:
            return [tuple(p) for p in json.loads(lines[-1].split("wtf-demo-route ", 1)[1])]
        time.sleep(1)
    raise SystemExit("no route in logcat: did the app plan one, with emulated adapters shown?")


def open_link(path):
    # Quoted: adb runs this through the phone's shell, where a `&` in the link would end the command.
    shell("am", "start", "-a", "android.intent.action.VIEW", "-d", f"'wtfai://{path}'", PKG)
    time.sleep(3)


def shot(out_dir, name):
    time.sleep(1.5)
    with open(os.path.join(out_dir, f"{name}.png"), "wb") as f:
        f.write(adb("exec-out", "screencap", "-p").stdout)
    print("shot", name, flush=True)


def demo_status_bar(on):
    if not on:
        shell("am", "broadcast", "-a", "com.android.systemui.demo", "-e", "command", "exit")
        return
    shell("settings", "put", "global", "sysui_demo_allowed", "1")
    for extra in (
        ["-e", "command", "clock", "-e", "hhmm", "0941"],
        ["-e", "command", "battery", "-e", "level", "100", "-e", "plugged", "false"],
        ["-e", "command", "network", "-e", "wifi", "show", "-e", "level", "4"],
        ["-e", "command", "network", "-e", "mobile", "show", "-e", "level", "4", "-e", "datatype", "none"],
        ["-e", "command", "notifications", "-e", "visible", "false"],
    ):
        shell("am", "broadcast", "-a", "com.android.systemui.demo", *extra)


class Recorder:
    """scripts/emulator-record.py: frames and sound from the emulator's gRPC streams, H.264 on the GPU at VIDEO_FPS,
    cropped to the `wm size` area; cut to the scenes when it stops."""

    def __init__(self, out_dir, name, port):
        # The `wm size` area sits in the middle of the emulator's frame. Asked until adb answers: a take whose answer
        # got lost was cropped from the frame's top, a black band over the app and its bottom cut off.
        for _ in range(5):
            physical = re.search(rb"Physical size: (\d+)x(\d+)", shell("wm", "size").stdout)
            if physical:
                break
            time.sleep(1)
        else:
            raise SystemExit("wm size gave no physical size: the video's crop would be wrong")
        width, height = map(int, SIZE.split("x"))
        top = (int(physical.group(2)) - height) // 2
        self.mp4 = os.path.abspath(os.path.join(out_dir, f"{name}.mp4"))
        self.source = os.path.abspath(os.path.join(out_dir, f"{name}.source.mp4"))
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "emulator-record.py")
        self.proc = subprocess.Popen(
            [sys.executable, script, self.source, "--port", str(port), "--crop", f"{width}:{height}:0:{top}",
             "--fps", str(VIDEO_FPS), "--audio"])
        time.sleep(2)  # connected and streaming before anything happens
        if self.proc.poll() is not None:
            raise SystemExit("emulator-record.py stopped: is the emulator running with -grpc, and grpcio installed?")
        self.t0 = time.time()
        self.scenes = []

    def scene(self, name, start, end):
        """Keep `start`…`end` (wall clock, time.time()) in the cut."""
        self.scenes.append((name, max(0.0, start - self.t0), max(0.0, end - self.t0)))

    def stop(self):
        open(self.source + ".stop", "w").close()
        self.proc.wait(timeout=180)
        spans = []
        for name, a, b in sorted(self.scenes, key=lambda s: s[1]):
            if spans and a <= spans[-1][2] + 1.0:  # overlapping or a second apart: one span
                spans[-1] = (spans[-1][0] + "+" + name, spans[-1][1], max(spans[-1][2], b))
            else:
                spans.append((name, a, b))
        scenes = [{"scene": n, "from_s": round(a, 2), "to_s": round(b, 2)} for n, a, b in spans]
        with open(self.mp4[:-4] + ".scenes.json", "w", encoding="utf-8") as f:
            json.dump(scenes, f, indent=1)
        cut_promo(self.source, scenes, self.mp4)


def repaired_sound(source):
    """The recording's sound with the emulator's dropouts bridged, as a WAV path (a temporary file) and how many. Its
    audio card runs dry now and then: for about a millisecond the sound falls to nothing in the middle of a voice (zeros
    in the stream, near-zero noise after AAC), which clicks. A dropout: 5 samples to 5 ms under a tenth of the level
    before it, the sound back after it; it is bridged by a cubic through clean samples on both sides, its edges (AAC
    smears each over a few samples) taken in. Nothing is cut, so the sound stays with the picture."""
    import numpy as np  # only for the video
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", source, "-vn", "-ac", "2", "-ar", str(AUDIO_RATE), "-f",
                          "s16le", "-"], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.int16).reshape(-1, 2).astype(float)
    m = np.abs(x).max(axis=1)
    level = np.convolve(m, np.ones(96) / 96, "same")  # over 2 ms
    longest, edge = AUDIO_RATE // 200, 4
    bridged, n, i = 0, len(x), 96
    while i < n - 200:
        before = level[i - 48]
        if before < 300 or m[i] >= 0.1 * before:
            i += 1
            continue
        b = i
        while b < n - 100 and b - i <= longest and m[b] < 0.1 * before:
            b += 1
        if 5 <= b - i <= longest and np.abs(x[b:b + 96]).max(axis=1).mean() > 0.5 * before:
            p0, p1 = i - edge, b + edge
            t = np.r_[np.arange(p0 - 8, p0), np.arange(p1, p1 + 8)]
            for ch in range(2):
                x[p0:p1, ch] = np.polyval(np.polyfit(t - p0, x[t, ch], 3), np.arange(p0, p1) - p0)
            bridged += 1
        i = max(b, i + 1)
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(AUDIO_RATE)
        w.writeframes(np.clip(x, -32768, 32767).astype(np.int16).tobytes())
    return path, bridged


def cut_promo(source, scenes, out):
    """The promo from the whole recording: each scene trimmed, sped up (driving `DRIVE_SPEED`, the rest `OTHER_SPEED`;
    the voice keeps its pitch), the next crossfading in over `CROSSFADE_S`, picture and sound alike. The sound: the
    dropouts bridged (`repaired_sound`), what clicks are left taken out (adeclick). x264 at CRF 23 looks the same as the
    recording's near-lossless GPU encode at a quarter of its size: the store set lives in Git LFS."""
    sound, bridged = repaired_sound(source)
    spans = [(s["from_s"], s["to_s"], DRIVE_SPEED if set(s["scene"].split("+")) <= DRIVING_SCENES else OTHER_SPEED)
             for s in scenes]
    graph = []
    for i, (a, b, k) in enumerate(spans):
        graph.append(f"[0:v]trim=start={a:.3f}:end={b:.3f},setpts=(PTS-STARTPTS)/{k},fps={VIDEO_FPS},format=yuv420p[v{i}]")
        graph.append(f"[1:a]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS,adeclick,atempo={k}[a{i}]")
    v, a, length = "v0", "a0", (spans[0][1] - spans[0][0]) / spans[0][2]
    for i in range(1, len(spans)):
        graph.append(f"[{v}][v{i}]xfade=transition=fade:duration={CROSSFADE_S}:offset={length - CROSSFADE_S:.3f}[vx{i}]")
        graph.append(f"[{a}][a{i}]acrossfade=d={CROSSFADE_S}[ax{i}]")
        v, a = f"vx{i}", f"ax{i}"
        length += (spans[i][1] - spans[i][0]) / spans[i][2] - CROSSFADE_S
    try:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", source, "-i", sound, "-filter_complex", ";".join(graph), "-map",
             f"[{v}]", "-map", f"[{a}]", "-r", str(VIDEO_FPS), "-c:v", "libx264", "-preset", "slow", "-tune", "film",
             "-crf", "23", "-x264-params", "aq-mode=3", "-g", str(VIDEO_FPS), "-pix_fmt", "yuv420p", "-c:a", "aac",
             "-b:a", "160k", "-movflags", "+faststart", out],
            check=True)
    finally:
        os.remove(sound)
    print(f"video {out}: {length:.0f} s of {len(spans)} scenes, {bridged} sound dropouts bridged", flush=True)


def search(query, field):
    """Types into the search field once it has focus (typing before that is lost), until a result with the query in it
    shows below the field (which reads the query too); returns where that result is."""
    for _ in range(3):
        tap_text(field, exact=False)
        time.sleep(1.5)
        shell("input", "text", query.replace(" ", "%s"))
        end = time.time() + 15
        while time.time() < end:
            found = sorted((y, x) for label, x, y in nodes() if query.lower() in label.lower())
            if len(found) >= 2:
                return found[1][1], found[1][0]
            time.sleep(1)
        shell("input", "keyevent", "111")
        time.sleep(1)
    raise SystemExit(f"search for {query!r} found nothing")


def first_run(say, dev_url=None):
    shell("pm", "clear", PKG)
    # The app in the run's language from its first screen, as on a phone set to it (Android's per-app language: the
    # system language can only be changed through the Settings app).
    shell("cmd", "locale", "set-app-locales", PKG, "--locales", say["locale"])
    # Granted ahead, as a driver would: the system's asks (in the emulator's English) would stop the scripted taps.
    for permission in ("POST_NOTIFICATIONS", "BLUETOOTH_SCAN", "BLUETOOTH_CONNECT", "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION"):
        shell("pm", "grant", PKG, f"android.permission.{permission}")
    if dev_url:
        # A debug build loads its JS from Metro (with `adb reverse tcp:8081 tcp:8081`): the dev launcher opens it.
        url = "exp+wtf-ai://expo-development-client/?url=" + urllib.parse.quote(dev_url, safe="")
        shell("am", "start", "-a", "android.intent.action.VIEW", "-d", f"'{url}'", PKG)
    else:
        shell("monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
    # A debug build's first start after the wipe loads its JS from Metro: well over a minute.
    tap_text(say["get_started"], 180)
    tap_if(say["allow"])
    tap_text(say["skip"])
    # Automatic launch (Android 12+), before the last step: not for the demo, which starts the drive itself.
    time.sleep(2)
    tap_if(say["not_now"])
    tap_text(say["done"])


def download_kyiv(say):
    wait_for(say["regions"], 60, exact=False)
    height = int(SIZE.split("x")[1])
    for _ in range(8):
        for label, x, y in nodes():
            # Inside the screen, clear of the navigation bar: a row at the edge is listed but can't be tapped.
            if label == say["kyiv"] and 300 < y < height - 400:
                row = y
                download = [(lx, ly) for l, lx, ly in nodes() if l == say["download"] and abs(ly - row) < 80]
                if download:
                    tap(*download[0])
                    # The map replaces the region list once the region is installed (the list's own titles may have
                    # scrolled away meanwhile: not a sign it is done).
                    wait_for(say["trusted"], 600)
                    return
        swipe_up()
    raise SystemExit("Kyiv not found in the region list")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out_dir")
    ap.add_argument("--lang", choices=sorted(LABELS), default="en", help="the app's language")
    ap.add_argument("--dark", action="store_true", help="dark theme")
    ap.add_argument("--video", action="store_true", help="also record a promo video, with sound")
    ap.add_argument("--no-gyro", action="store_true", help="keep the phone still: the app turns by the wheels alone")
    ap.add_argument("--grpc-port", type=int, default=GRPC_PORT, help="the emulator's gRPC port (emulator -grpc PORT)")
    ap.add_argument("--dev-url", help="a debug build's Metro, e.g. http://127.0.0.1:8081: for trying the drive with fast "
                                      "refresh (the store video itself comes from a Release build)")
    ap.add_argument("--recut", action="store_true",
                    help="only cut the promo again from out_dir's recording (promo*.source.mp4 and its scenes.json)")
    args = ap.parse_args()
    if args.recut:
        for source in sorted(f for f in os.listdir(args.out_dir) if f.endswith(".source.mp4")):
            stem = os.path.join(args.out_dir, source[: -len(".source.mp4")])
            with open(stem + ".scenes.json", encoding="utf-8") as f:
                cut_promo(os.path.join(args.out_dir, source), json.load(f), stem + ".mp4")
        return
    os.makedirs(args.out_dir, exist_ok=True)
    global FAIL_DIR
    FAIL_DIR = args.out_dir
    if b"device" not in adb("get-state").stdout:
        raise SystemExit("no emulator: start one (emulator -avd wtf_phone)")

    # The trip, before touching the emulator: a release that lost the camera or the station stops here.
    graph, cameras = release_files(os.path.join(tempfile.gettempdir(), "wtf-store-maps"))
    path, stop_at = plan_trip(graph, args.out_dir)
    probe = Drive(path)
    stop_m, stop_off = probe.project(stop_at)
    camera_m = camera_on(probe, cameras)
    print(f"trip {probe.length:.0f} m: the station at {stop_m:.0f} m ({stop_off:.0f} m off), the camera at {camera_m:.0f} m",
          flush=True)
    drive = Drive(path, stands=[(stop_m, STOP_STAND_S)], caps=[
        (camera_m - SPEEDING_FROM_M, camera_m - SPEEDING_TO_M, SPEEDING_KMH),
        (camera_m - SPEEDING_TO_M, camera_m + 30, CAMERA_KMH),
        (SLOW_END_FROM_M, probe.length, END_KMH),
    ])

    car = Car(args.grpc_port, rotate=not args.no_gyro)
    # `input tap` comes as a stylus to Gboard, whose "Try out your stylus" sheet then swallows the typed search.
    handwriting = shell("settings", "get", "secure", "stylus_handwriting_enabled").stdout.decode().strip()
    shell("settings", "put", "secure", "stylus_handwriting_enabled", "0")
    subtype = keyboard_language(args.lang)
    shell("wm", "size", SIZE)
    shell("cmd", "uimode", "night", "yes" if args.dark else "no")
    demo_status_bar(True)
    suffix = ("" if args.lang == "en" else f"-{args.lang}") + ("-dark" if args.dark else "")
    say = LABELS[args.lang]
    out = args.out_dir
    video = None
    try:
        first_run(say, args.dev_url)
        download_kyiv(say)
        wait_for(say["trusted"], 60)
        tap_if(say["not_now"])  # the map tour
        # Emulated adapters on before the route is planned: the app logs its routes for the drive while they are.
        open_link("vehicle?emulators=1")
        back()
        tap_when(say["not_now"], 10)  # "Practise before your first drive" comes a moment after the map

        video = Recorder(out, f"promo{suffix}", args.grpc_port) if args.video else None
        rec_from = time.time()
        route_tab = wait_for(say["route"])
        tap(*route_tab)
        time.sleep(1.5)
        adb("logcat", "-c")
        # The emulator shares the host's clipboard, and Gboard offers what was copied last over the keys: a path of
        # this PC showed in a take. Emptied right before the keyboard opens.
        car.stub.setClipboard(car.pb.ClipData(text=""))
        result = search(DESTINATION, say["search"])
        shell("input", "keyevent", "111")  # Escape: hide the keyboard
        time.sleep(1)
        shot(out, f"06-search{suffix}")
        tap(*result)
        tap_text(say["start"], 20)
        tap_if(say["agree"])
        # The route on the map, and the other ways found after it, one by one.
        time.sleep(2)
        wait_gone(say["finding_alternatives"], 30)
        time.sleep(2)
        shot(out, f"05-route{suffix}")
        if video:
            video.scene("plan", rec_from, time.time())
        off = max_off(drive, planned_route(), skip_near=STOP)
        print(f"the app's route: {off:.0f} m off the trip at most" + ("  ← NOT the planned trip" if off > 30 else ""),
              flush=True)

        # Standing, from the Route tab's tiles: the fuel along the route (where the station's row will be once the
        # stop is added mid-drive, when the moving map leaves no UI tree to find it in), then parking near the
        # destination.
        tap(*route_tab)
        fuel_tile = wait_for(say["fuel"], 20)
        tap(*fuel_tile)
        wait_for(STOP_NAME, 20, exact=False)
        time.sleep(3)  # the detours counted
        stop_row = (540, row_when_ahead(place_rows(), STOP_NAME, STOP_ADD_AT_M))
        back()
        t_parking = time.time()
        tap_text(say["parking"])
        wait_for(say["parking_for"].format(name=DESTINATION), 20, exact=False)
        time.sleep(2)
        shot(out, f"07-parking{suffix}")
        back()
        back()
        if video:
            video.scene("parking", t_parking - 0.5, time.time() - 1.5)

        # The adapter: it drives the trip's speed profile from connecting, its wheels turning as the car's heading does;
        # GPS and the gyro follow the same drive.
        open_link(f"vehicle?emulators=1&cycle={drive.spec()}&turn={drive.turn_spec()}")
        # The drive starts as the adapter connects, at the tap: stamped after the tap's pause, the phone turned 1.25 s
        # after the wheels.
        tap(*wait_for(ADAPTER, 30))
        t0 = time.time()
        car.follow(drive, t0)
        time.sleep(1.5)
        # An STN connecting for the first time: the firmware notice, skipped.
        try:
            tap(*wait_for(say["fw_skip"], 10))
            time.sleep(1.5)
        except SystemExit:
            pass
        back()  # to the map
        wall = lambda s: t0 + s
        at = lambda s: time.sleep(max(0.0, wall(s) - time.time()))
        t_move = drive.time_at(1)
        # The map follows a moving car from here: no UI tree on the map (uiautomator waits for an idle screen), shots on a
        # clock.
        at(drive.time_at(GUIDANCE_AT_M))
        shot(out, f"01-guidance{suffix}")
        at(drive.time_at(SPOOF_AT_M))
        car.pos = ABROAD
        if video:
            video.scene("drive-off", wall(t_move - 1), wall(t_move + 8))
            video.scene("spoof", wall(drive.time_at(SPOOF_AT_M) - 3), wall(drive.time_at(SPOOF_AT_M) + 8))

        # The stop, added from the Route tab while driving: Fuel, the station's row (its detour), added with Undo.
        at(drive.time_at(STOP_ADD_AT_M))
        t_add = time.time()
        tap(*route_tab)
        time.sleep(2)
        tap(*fuel_tile)
        time.sleep(4)  # the detours counted
        shot(out, f"04-stops{suffix}")
        adb("logcat", "-c")
        tap(*stop_row)
        time.sleep(2)
        back()  # the trip → the map, the Undo card over it
        off = max_off(drive, planned_route(), drive.metres_at(time.time() - t0))
        print(f"the app's trip with the stop: {off:.0f} m off the planned one at most"
              + ("  ← NOT through the station: the wrong row?" if off > 30 else ""), flush=True)
        if video:
            video.scene("add-stop", t_add - 1, time.time() + 4)
        if time.time() > wall(drive.time_at(SPOOFED_SHOT_AT_M)):
            print("the stop took past the spoofed shot's place: shot late", flush=True)
        at(drive.time_at(SPOOFED_SHOT_AT_M))
        shot(out, f"02-spoofed{suffix}")
        if video:
            video.scene("pull-in", wall(drive.time_at(stop_m - 120)), wall(drive.time_at(stop_m + 1) + 3))
            video.scene("camera", wall(drive.time_at(camera_m - 450)), wall(drive.time_at(camera_m + 30)))
        at(drive.time_at(camera_m - SPEEDING_TO_M - 60))
        shot(out, f"03-camera{suffix}")
        end_s = drive.profile[-1][0] + 4
        at(end_s)  # through the 40 and 30 zones to the destination
        if video:
            video.scene("arrive", wall(drive.time_at(ARRIVE_SCENE_FROM_M)), wall(end_s - 1))
        tap_if(say["stop_guidance"])

        t_maps = time.time()
        open_link("more/downloads")
        shot(out, f"08-maps{suffix}")
        if video:
            video.scene("maps", t_maps, time.time() + 1)
            video.stop()
            video = None
    finally:
        if video:
            open(video.source + ".stop", "w").close()
        car.stopped.set()
        car.upright()
        shell("cmd", "locale", "set-app-locales", PKG, "--locales", "")
        if handwriting in ("0", "1"):
            shell("settings", "put", "secure", "stylus_handwriting_enabled", handwriting)
        else:
            shell("settings", "delete", "secure", "stylus_handwriting_enabled")
        if re.fullmatch(r"-?\d+", subtype):
            shell("settings", "put", "secure", "selected_input_method_subtype", subtype)
        demo_status_bar(False)
        shell("wm", "size", "reset")
        shell("cmd", "uimode", "night", "no")


if __name__ == "__main__":
    main()
