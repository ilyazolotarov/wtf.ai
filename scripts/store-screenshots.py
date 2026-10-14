#!/usr/bin/env python3
"""Google Play screenshots and a short video from the Android emulator (docs/STORE-REVIEW.md §7).

Against a running emulator with a Release build installed (a store build: DISTRIBUTION=store, UPDATES_ORIGIN set, so
maps download). It wipes the app's data, goes through first run like a new user, downloads the Kyiv region, puts the
car in Kyiv with emulated GPS, connects the app's emulated OBD adapter (Developer › Show emulated adapters) and drives
the car on its speed cycle, GPS moving with it, and shoots:

  01-guidance   a route being guided at 60 km/h, GPS trusted, the adapter connected
  02-route      the destination card before guidance
  03-search     address search
  04-spoofed    GPS jumps abroad mid-drive: "GPS looks spoofed", the car carries on along the road on its own speed
  05-lesson     the Guide's "Driving through jamming" lesson, mid-drive
  06-maps       Offline maps

At 1080x2160, the tallest Play takes (it refuses a long side more than twice the short one; the emulator's own
1080x2400 is 2.22:1), with
a clean status bar (demo mode). --lang uk shoots the app in Ukrainian from its first screen (Android's per-app language), --dark the dark theme, --video records from the drive to the end for a promo video: on the host
(the emulator's own recorder at VIDEO_FPS; the phone's screenrecord managed ~19 fps with stalls), cropped to the
screen and encoded to MP4 with ffmpeg. Leaves the emulator's size, theme and status bar as they were.

    python scripts/store-screenshots.py out-dir
    python scripts/store-screenshots.py out-dir --lang uk --dark --video

The App Store needs screenshots of the iOS app: take those on an iPhone (docs/STORE-REVIEW.md §7).
"""
import argparse
import math
import os
import re
import shutil
import subprocess
import threading
import time
import xml.etree.ElementTree as ET

PKG = "ai.wtf.navigator"
SIZE = "1080x2160"
# The car drives north towards the destination searched, on the road: the vertices are the route's own, from the Kyiv
# road graph (`npm run route -- --graph …/kyiv-city.graph.bin --from 50.4300,30.5170 --to 50.4466,30.5225
# --geojson …`), starting 30 m past the junction: a car standing on a junction node is planned from the side street
# (docs/ROUTING-SPEC.md §5.1). The emulated adapter's cycle (below) drives ~625 m of it before it stops.
# It must head north: the emulator's GPS always reports a course of 0° (`geo fix` takes none, and it ignores NMEA RMC),
# and the navigator takes its heading from that course before the spoof. A drive any other way starts the demo with a
# wrong heading.
DRIVE = [(50.430200, 30.516064), (50.430426, 30.516064), (50.431139, 30.516067), (50.431956, 30.516070),
         (50.433390, 30.516062), (50.433946, 30.516052), (50.434340, 30.516048), (50.434538, 30.516044),
         (50.435082, 30.516035), (50.435950, 30.516024), (50.436132, 30.516076), (50.436579, 30.516068)]
# Typed in Latin in both languages (`adb shell input text` types ASCII only); results show the UI language's name.
DESTINATION = "Khreshchatyk"
# What the scripted taps look for after first run, per app language (src/i18n/en.ts, uk.ts, guide-*.ts).
LABELS = {
    "en": {
        "locale": "", "get_started": "Get started", "allow": "Allow while using the app", "skip": "Skip for now",
        "done": "Done", "regions": "Regions", "kyiv": "Kyiv", "download": "Download", "map_setup": "Download a map",
        "trusted": "Position trusted", "not_now": "Not now",
        "route": "Route", "search": "Search addresses and places", "street": "Khreshchatyk Street",
        "start": "Start guidance", "agree": "I'll follow the route", "lesson": "Driving through jamming",
        "play": "Play the drive",
    },
    "uk": {
        "locale": "uk-UA", "get_started": "Почати", "allow": "Дозволити під час використання", "skip": "Поки що пропустити",
        "done": "Готово", "regions": "Регіони", "kyiv": "Київ", "download": "Завантажити", "map_setup": "Завантажте мапу",
        "trusted": "Позиція надійна", "not_now": "Не зараз",
        "route": "Маршрут", "search": "Пошук адрес і місць", "street": "вулиця Хрещатик",
        "start": "Почати навігацію", "agree": "Їхатиму за маршрутом", "lesson": "Поїздка без сигналу GPS",
        "play": "Програти поїздку",
    },
}
ABROAD = (44.0, 35.0)
ADAPTER = "Emulator · ELM327 v1.5"
# Seconds since the adapter connected: guidance at cruise, GPS jumps abroad, the spoofed shot while still at 60 km/h.
GUIDANCE_AT_S, SPOOF_AT_S, SPOOFED_SHOT_AT_S = 32, 34, 42
# The emulator's recorder takes up to 60; the moving map drew ~21 frames a second on a 4-core AVD (8 cores now).
VIDEO_FPS = 60

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


def adapter_kmh(t):
    """The emulated adapter's speed `t` s after it connected (src/services/vehicle-link/driving-emulator.ts), first
    lap: standing, up to 60 km/h, cruising, braking to a stop."""
    if t < 10:
        return 0.0
    if t < 25:
        return (t - 10) / 15 * 60
    if t < 50:
        return 60 + 3 * math.sin(t)
    if t < 60:
        return 60 * (1 - (t - 50) / 10)
    return 0.0


def adapter_m(t, step=0.05):
    """Metres the emulated adapter's car has gone `t` s after it connected."""
    n = int(t / step)
    return sum(adapter_kmh(i * step) for i in range(n)) * step / 3.6


class Gps:
    """Sends the emulator a satellite fix every second (the app refuses fixes without satellites): at the start of
    DRIVE until `follow(t0)`, then along it as the emulated adapter connected at t0 drives; `pos` when set."""

    def __init__(self):
        self.pos = None
        self.t0 = None
        self.stopped = threading.Event()
        threading.Thread(target=self.run, daemon=True).start()

    def follow(self, t0):
        self.t0 = t0

    def run(self):
        while not self.stopped.is_set():
            if self.pos:
                (lat, lon), knots = self.pos, 0
            elif self.t0 is None:
                (lat, lon), knots = DRIVE[0], 0
            else:
                t = time.time() - self.t0
                (lat, lon), knots = along(DRIVE, adapter_m(t)), adapter_kmh(t) / 1.852
            adb("emu", "geo", "fix", str(lon), str(lat), "170", "9", f"{knots:.1f}", timeout=10)
            time.sleep(1)


def along(path, metres):
    """The point `metres` along `path` (lat, lon pairs); its end beyond."""
    for (lat1, lon1), (lat2, lon2) in zip(path, path[1:]):
        dy = (lat2 - lat1) * 111_320
        dx = (lon2 - lon1) * 111_320 * math.cos(math.radians(lat1))
        leg = math.hypot(dx, dy)
        if metres <= leg:
            f = metres / leg
            return lat1 + f * (lat2 - lat1), lon1 + f * (lon2 - lon1)
        metres -= leg
    return path[-1]


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


def open_link(path):
    shell("am", "start", "-a", "android.intent.action.VIEW", "-d", f"wtfai://{path}", PKG)
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
    """The emulator's own recorder, on the host: it records the whole display (the `wm size` area letterboxed in it),
    so `stop` crops to the screen shot and encodes H.264."""

    def __init__(self, out_dir, name):
        self.raw = os.path.abspath(os.path.join(out_dir, f"{name}.webm"))
        self.name = name
        if os.path.exists(self.raw):
            os.remove(self.raw)
        adb("emu", "screenrecord", "start", "--fps", str(VIDEO_FPS), self.raw)

    def stop(self, out_dir):
        adb("emu", "screenrecord", "stop")
        time.sleep(3)
        physical = re.search(rb"Physical size: (\d+)x(\d+)", shell("wm", "size").stdout)
        width, height = map(int, SIZE.split("x"))
        top = (int(physical.group(2)) - height) // 2 if physical else 0
        mp4 = os.path.join(out_dir, f"{self.name}.mp4")
        made = subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", self.raw, "-vf", f"crop={width}:{height}:0:{top}", "-r", str(VIDEO_FPS),
             "-c:v", "libx264", "-crf", "20", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4],
            capture_output=True,
        ) if shutil.which("ffmpeg") else None
        if made and made.returncode == 0:
            os.remove(self.raw)
            print("video", mp4)
        else:
            print("video", self.raw, "(no ffmpeg: not cropped)")


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


def first_run(say):
    shell("pm", "clear", PKG)
    # The app in the run's language from its first screen, as on a phone set to it (Android's per-app language: the
    # system language can only be changed through the Settings app).
    shell("cmd", "locale", "set-app-locales", PKG, "--locales", say["locale"])
    # Granted ahead, as a driver would: the system's asks (in the emulator's English) would stop the scripted taps.
    for permission in ("POST_NOTIFICATIONS", "BLUETOOTH_SCAN", "BLUETOOTH_CONNECT", "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION"):
        shell("pm", "grant", PKG, f"android.permission.{permission}")
    shell("monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
    tap_text(say["get_started"], 60)
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
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    global FAIL_DIR
    FAIL_DIR = args.out_dir
    if b"device" not in adb("get-state").stdout:
        raise SystemExit("no emulator: start one (emulator -avd wtf_phone)")

    gps = Gps()
    # `input tap` comes as a stylus to Gboard, whose "Try out your stylus" sheet then swallows the typed search.
    handwriting = shell("settings", "get", "secure", "stylus_handwriting_enabled").stdout.decode().strip()
    shell("settings", "put", "secure", "stylus_handwriting_enabled", "0")
    shell("wm", "size", SIZE)
    shell("cmd", "uimode", "night", "yes" if args.dark else "no")
    demo_status_bar(True)
    suffix = ("" if args.lang == "en" else f"-{args.lang}") + ("-dark" if args.dark else "")
    say = LABELS[args.lang]
    try:
        first_run(say)
        download_kyiv(say)
        wait_for(say["trusted"], 60)
        tap_if(say["not_now"])  # the map tour

        tap_text(say["route"])
        search(DESTINATION, say["street"], say["search"])
        shell("input", "keyevent", "111")  # Escape: hide the keyboard
        time.sleep(1)
        shot(args.out_dir, f"03-search{suffix}")
        tap_text(say["street"], exact=False)
        wait_for(say["start"], 20)
        shot(args.out_dir, f"02-route{suffix}")
        tap_text(say["start"])
        tap_if(say["agree"])

        # The adapter: its speed cycle starts on connecting, and GPS follows it so the two agree.
        open_link("vehicle?emulators=1")
        tap_text(ADAPTER, 30)
        t0 = time.time()
        gps.follow(t0)
        shell("input", "keyevent", "4")  # back to the map
        video = Recorder(args.out_dir, f"promo{suffix}") if args.video else None
        # The map follows a moving car from here: no UI tree (uiautomator waits for an idle screen), shots on a clock.
        at = lambda s: time.sleep(max(0.0, t0 + s - time.time()))
        at(GUIDANCE_AT_S)
        shot(args.out_dir, f"01-guidance{suffix}")
        at(SPOOF_AT_S)
        gps.pos = ABROAD
        at(SPOOFED_SHOT_AT_S)
        shot(args.out_dir, f"04-spoofed{suffix}")
        time.sleep(25)  # the car stops; on video, the dot carrying on without GPS
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
        gps.stopped.set()
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
