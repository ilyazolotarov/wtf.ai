#!/usr/bin/env python3
"""Google Play screenshots and a short video from the Android emulator (docs/STORE-REVIEW.md §7).

Against a running emulator with a Release build installed (a store build: DISTRIBUTION=store, UPDATES_ORIGIN set, so
maps download). It wipes the app's data, goes through first run like a new user, downloads the Kyiv region, puts the
car in Kyiv with emulated GPS, connects the app's emulated OBD adapter (Developer › Show emulated adapters) and drives
the car along the route the app plans (GPS, its speed and the phone's gyro following it), and shoots:

  01-guidance   a route being guided, GPS trusted, the adapter connected
  02-route      the destination card before guidance
  03-search     address search
  04-spoofed    GPS jumps abroad mid-drive: "GPS looks spoofed", the car carries on along the road on its own speed
  05-lesson     the Guide's "Driving through jamming" lesson, mid-drive
  06-maps       Offline maps

At 1080x2160, the tallest Play takes (it refuses a long side more than twice the short one; the emulator's own
1080x2400 is 2.22:1), with
a clean status bar (demo mode). --lang uk shoots the app in Ukrainian from its first screen (Android's per-app language), --dark the dark theme, --video records from the drive to the end for a promo video: on the host
(scripts/emulator-record.py, the emulator's gRPC screen stream at VIDEO_FPS, needs the emulator started with -grpc),
cropped to the screen and encoded to MP4 on the GPU. Leaves the emulator's size, theme and status bar as they were.

    python scripts/store-screenshots.py out-dir
    python scripts/store-screenshots.py out-dir --lang uk --dark --video

The App Store needs screenshots of the iOS app: take those on an iPhone (docs/STORE-REVIEW.md §7).
"""
import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import xml.etree.ElementTree as ET

from emulator_grpc import connect

PKG = "ai.wtf.navigator"
SIZE = "1080x2160"
# The demo drive: the car stands at START facing west, the driver asks for Sofiivska Street (DESTINATION), and the
# car drives the route the app plans, read from logcat (`wtf-demo-route`, logged while emulated adapters are shown):
# right onto the avenue north, then bends and turns through the old town to its end. Any other route would leave the
# app's mid-demo (it plans with its own start matching and rush hours, so it is read, not predicted). GPS goes wrong
# right after the first turn (SPOOF_AT_M): every other turn is driven on the car's speed and the gyro alone.
START, START_HEADING = (50.42992, 30.51700), 270.0
# Metres along the route: the guidance shot (GPS still trusted, just before the first turn, ~65 m in), GPS jumps abroad
# once the car is out of that turn, the spoofed shot. Nearly the whole drive, the square at ~1.15 km included (a bend
# right into a sharp turn back among close roads), is driven on the car's speed and the gyro alone.
GUIDANCE_AT_M, SPOOF_AT_M, SPOOFED_SHOT_AT_M = 40, 150, 1650
# The car: stands this long after the adapter connects, then drives the route at these speeds and stops at its end.
STAND_S, CRUISE_KMH, BEND_KMH, TURN_KMH = 10, 50, 32, 20
ACCEL_MS2, BRAKE_MS2 = 1.3, 1.8
GRPC_PORT = 8554
# Typed in Latin in both languages (`adb shell input text` types ASCII only). The street has no English name in the
# map data: its result reads "Софіївська" in both languages ("Sofiivska Street" is another one, across the city).
DESTINATION = "Sofiivska"
# What the scripted taps look for after first run, per app language (src/i18n/en.ts, uk.ts, guide-*.ts).
LABELS = {
    "en": {
        "locale": "", "get_started": "Get started", "allow": "Allow while using the app", "skip": "Skip for now",
        "done": "Done", "regions": "Regions", "kyiv": "Kyiv", "download": "Download", "map_setup": "Download a map",
        "trusted": "Position trusted", "not_now": "Not now",
        "route": "Route", "search": "Search addresses and places", "street": "Софіївська",
        "start": "Start guidance", "agree": "I'll follow the route", "lesson": "Driving through jamming",
        "play": "Play the drive",
    },
    "uk": {
        "locale": "uk-UA", "get_started": "Почати", "allow": "Дозволити під час використання", "skip": "Поки що пропустити",
        "done": "Готово", "regions": "Регіони", "kyiv": "Київ", "download": "Завантажити", "map_setup": "Завантажте мапу",
        "trusted": "Позиція надійна", "not_now": "Не зараз",
        "route": "Маршрут", "search": "Пошук адрес і місць", "street": "Софіївська",
        "start": "Почати навігацію", "agree": "Їхатиму за маршрутом", "lesson": "Поїздка без сигналу GPS",
        "play": "Програти поїздку",
    },
}
ABROAD = (44.0, 35.0)
ADAPTER = "Emulator · ELM327 v1.5"
# The recording: the emulator's frames over gRPC, H.264 on the GPU (scripts/emulator-record.py). 30 fps: the tilted
# moving map draws ~22 fps in the emulator, so 60 only repeated frames.
VIDEO_FPS = 30
# The promo plays this many times faster than it was recorded: the drive, the lesson, all of it (a 6 min recording
# becomes ~2 min, and the emulator's lag doesn't show). The recording as it was stays next to it, `*.source.mp4`.
VIDEO_SPEEDUP = 3

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


class Drive:
    """The car on a route: a speed profile in time (the emulated adapter drives it, sent in the link that opens it) and
    where the car is and which way it faces at any moment of it, from the very same profile."""

    def __init__(self, route):
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
            limit.append(CRUISE_KMH if change < 20 else BEND_KMH if change < 55 else TURN_KMH)
        v = [x / 3.6 for x in limit]
        v[0] = v[-1] = 0.0
        for i in range(1, len(grid)):  # can't speed up faster than ACCEL
            v[i] = min(v[i], math.sqrt(v[i - 1] ** 2 + 2 * ACCEL_MS2 * (grid[i] - grid[i - 1])))
        for i in range(len(grid) - 2, -1, -1):  # nor brake harder than BRAKE
            v[i] = min(v[i], math.sqrt(v[i + 1] ** 2 + 2 * BRAKE_MS2 * (grid[i + 1] - grid[i])))
        # In time: a point a second (seconds:km/h), straight between, as the adapter reads it.
        t, times = 0.0, [0.0]
        for i in range(1, len(grid)):
            t += (grid[i] - grid[i - 1]) / max((v[i] + v[i - 1]) / 2, 0.3)
            times.append(t)
        self.profile = [(0.0, 0.0), (float(STAND_S), 0.0)]
        for k in range(1, int(times[-1]) + 1):
            i = next(j for j, tj in enumerate(times) if tj >= k)
            self.profile.append((STAND_S + k, round(v[i] * 3.6, 1)))
        self.profile.append((STAND_S + math.ceil(times[-1]) + 1, 0.0))

    def spec(self):
        """The profile as the link's `cycle`: seconds:km/h, comma-separated."""
        return ",".join(f"{t:g}:{kmh:g}" for t, kmh in self.profile)

    def kmh_at(self, t):
        p = self.profile
        if t <= p[0][0]:
            return p[0][1]
        for (t0, v0), (t1, v1) in zip(p, p[1:]):
            if t <= t1:
                return v0 + (t - t0) / (t1 - t0) * (v1 - v0)
        return p[-1][1]

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


class Car:
    """Moves the emulator's phone with the car, over its gRPC interface (emulator -grpc GRPC_PORT): a GPS fix with
    the car's course and speed every second, and the phone turned with the car 20 times a second, so its gyroscope
    feels each turn as in a car (the navigator steers on it with GPS gone). Before `follow(drive, t0)` the car stands
    at START facing START_HEADING; with `pos` set, GPS reports there, standing (a spoof)."""

    def __init__(self, port=GRPC_PORT):
        self.drive = None
        self.pb, self.stub = connect(port)
        model = self.pb.PhysicalModelValue
        rot = self.stub.getPhysicalModel(model(target=model.ROTATION)).value.data
        self.rot0 = list(rot)  # the phone upright in its mount: y is the vertical axis
        self.heading0 = START_HEADING
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
                # The app refuses fixes without satellites.
                self.stub.setGps(self.pb.GpsState(passiveUpdate=False, latitude=lat, longitude=lon, speed=speed,
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


def tap(x, y):
    shell("input", "tap", str(x), str(y))


def tap_text(text, seconds=30, exact=True):
    tap(*wait_for(text, seconds, exact))
    time.sleep(1.5)


def tap_if(text):
    at = find(text)
    if at:
        tap(*at)
        time.sleep(1.5)


def swipe_up():
    shell("input", "swipe", "540", "1500", "540", "700", "400")
    time.sleep(1)


def swipe_down():
    shell("input", "swipe", "540", "700", "540", "1500", "400")
    time.sleep(1)


def planned_route(seconds=20):
    """The route the app planned (its `wtf-demo-route` line in logcat): (lat, lon) points."""
    end = time.time() + seconds
    while time.time() < end:
        for line in adb("logcat", "-d", "-s", "ReactNativeJS:I").stdout.decode("utf-8", "replace").splitlines():
            if "wtf-demo-route " in line:
                return [tuple(p) for p in json.loads(line.split("wtf-demo-route ", 1)[1])]
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
    print("shot", name)


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
    """scripts/emulator-record.py: frames from the emulator's gRPC stream (shared memory), H.264 on the GPU at VIDEO_FPS,
    cropped to the `wm size` area. Smooth and sharp where the emulator's own recorder must trade one for the other."""

    def __init__(self, out_dir, name, port):
        physical = re.search(rb"Physical size: (\d+)x(\d+)", shell("wm", "size").stdout)
        width, height = map(int, SIZE.split("x"))
        top = (int(physical.group(2)) - height) // 2 if physical else 0
        self.mp4 = os.path.abspath(os.path.join(out_dir, f"{name}.mp4"))
        self.source = os.path.abspath(os.path.join(out_dir, f"{name}.source.mp4"))
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "emulator-record.py")
        self.proc = subprocess.Popen(
            [sys.executable, script, self.source, "--port", str(port), "--crop", f"{width}:{height}:0:{top}", "--fps", str(VIDEO_FPS)])
        time.sleep(2)  # connected and streaming before the drive starts
        if self.proc.poll() is not None:
            raise SystemExit("emulator-record.py stopped: is the emulator running with -grpc, and grpcio installed?")

    def stop(self, out_dir):
        open(self.source + ".stop", "w").close()
        self.proc.wait(timeout=120)
        # Every VIDEO_SPEEDUP-th frame at the same frame rate. x264 at CRF 23 looks the same as the recording's near-lossless
        # GPU encode at a quarter of its size (~90 MB for 2 min instead of 360): the store set lives in Git LFS.
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", self.source, "-vf", f"setpts=PTS/{VIDEO_SPEEDUP},fps={VIDEO_FPS}",
             "-c:v", "libx264", "-preset", "slow", "-tune", "film", "-crf", "23", "-x264-params", "aq-mode=3",
             "-g", str(VIDEO_FPS), "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", self.mp4],
            check=True)
        print(f"video {self.mp4}: {VIDEO_SPEEDUP}x")


def search(query, expect, field):
    """Types into the search field once it has focus (typing before that is lost), until `expect` shows."""
    for _ in range(3):
        tap_text(field, exact=False)
        time.sleep(1.5)
        shell("input", "text", query.replace(" ", "%s"))
        try:
            return wait_for(expect, 15, exact=False)
        except SystemExit:
            shell("input", "keyevent", "111")
            time.sleep(1)
    raise SystemExit(f"search for {query!r} found no {expect!r}")


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
    tap_text(say["get_started"], 90)
    tap_if(say["allow"])
    tap_text(say["skip"])
    tap_text(say["done"])


def download_kyiv(say):
    wait_for(say["regions"], 60, exact=False)
    for _ in range(8):
        for label, x, y in nodes():
            # Inside the screen, clear of the navigation bar: a row at the edge is listed but can't be tapped.
            if label == say["kyiv"] and 300 < y < int(SIZE.split("x")[1]) - 400:
                row = y
                download = [(lx, ly) for l, lx, ly in nodes() if l == say["download"] and abs(ly - row) < 80]
                if download:
                    tap(*download[0])
                    # The map replaces the region list once the region is installed.
                    end = time.time() + 600
                    while time.time() < end and find(say["map_setup"]):
                        time.sleep(3)
                    time.sleep(5)
                    return
        swipe_up()
    raise SystemExit("Kyiv not found in the region list")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out_dir")
    ap.add_argument("--lang", choices=sorted(LABELS), default="en", help="the app's language")
    ap.add_argument("--dark", action="store_true", help="dark theme")
    ap.add_argument("--video", action="store_true", help="also record the spoofing and the lesson")
    ap.add_argument("--grpc-port", type=int, default=GRPC_PORT, help="the emulator's gRPC port (emulator -grpc PORT)")
    ap.add_argument("--dev-url", help="a debug build's Metro, e.g. http://127.0.0.1:8081: for trying the drive with fast "
                                      "refresh (the store video itself comes from a Release build)")
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    global FAIL_DIR
    FAIL_DIR = args.out_dir
    if b"device" not in adb("get-state").stdout:
        raise SystemExit("no emulator: start one (emulator -avd wtf_phone)")

    car = Car(args.grpc_port)
    # `input tap` comes as a stylus to Gboard, whose "Try out your stylus" sheet then swallows the typed search.
    handwriting = shell("settings", "get", "secure", "stylus_handwriting_enabled").stdout.decode().strip()
    shell("settings", "put", "secure", "stylus_handwriting_enabled", "0")
    shell("wm", "size", SIZE)
    shell("cmd", "uimode", "night", "yes" if args.dark else "no")
    demo_status_bar(True)
    suffix = ("" if args.lang == "en" else f"-{args.lang}") + ("-dark" if args.dark else "")
    say = LABELS[args.lang]
    try:
        first_run(say, args.dev_url)
        download_kyiv(say)
        wait_for(say["trusted"], 60)
        tap_if(say["not_now"])  # the map tour
        # Emulated adapters on before the route is planned: the app logs its route for the drive while they are.
        open_link("vehicle?emulators=1")
        shell("input", "keyevent", "4")

        tap_text(say["route"])
        search(DESTINATION, say["street"], say["search"])
        shell("input", "keyevent", "111")  # Escape: hide the keyboard
        time.sleep(1)
        shot(args.out_dir, f"03-search{suffix}")
        tap_text(say["street"], exact=False)
        wait_for(say["start"], 20)
        shot(args.out_dir, f"02-route{suffix}")
        adb("logcat", "-c")
        tap_text(say["start"])
        tap_if(say["agree"])
        drive = Drive(planned_route())

        # The adapter: it drives the route's speed profile from connecting, and GPS and the gyro follow it.
        open_link(f"vehicle?emulators=1&cycle={drive.spec()}")
        tap_text(ADAPTER, 30)
        t0 = time.time()
        car.follow(drive, t0)
        shell("input", "keyevent", "4")  # back to the map
        if args.video:
            time.sleep(1)  # the video starts on the map, not on the Vehicle sheet sliding away
        video = Recorder(args.out_dir, f"promo{suffix}", args.grpc_port) if args.video else None
        # The map follows a moving car from here: no UI tree (uiautomator waits for an idle screen), shots on a clock.
        at = lambda s: time.sleep(max(0.0, t0 + s - time.time()))
        at(drive.time_at(GUIDANCE_AT_M))
        shot(args.out_dir, f"01-guidance{suffix}")
        at(drive.time_at(SPOOF_AT_M))
        car.pos = ABROAD
        at(drive.time_at(SPOOFED_SHOT_AT_M))
        shot(args.out_dir, f"04-spoofed{suffix}")
        at(drive.profile[-1][0] + 4)  # on video, the car on its own through the turns to the destination
        tap_if("Stop guidance")

        open_link("guide/lesson?id=jamming")
        wait_for(say["lesson"], 30)
        swipe_up()
        tap_text(say["play"], 30)
        swipe_down()
        time.sleep(7)
        shot(args.out_dir, f"05-lesson{suffix}")
        time.sleep(8)

        open_link("more/downloads")
        shot(args.out_dir, f"06-maps{suffix}")
        if video:
            video.stop(args.out_dir)
    finally:
        car.stopped.set()
        car.upright()
        shell("cmd", "locale", "set-app-locales", PKG, "--locales", "")
        if handwriting in ("0", "1"):
            shell("settings", "put", "secure", "stylus_handwriting_enabled", handwriting)
        else:
            shell("settings", "delete", "secure", "stylus_handwriting_enabled")
        demo_status_bar(False)
        shell("wm", "size", "reset")
        shell("cmd", "uimode", "night", "no")


if __name__ == "__main__":
    main()
