#!/usr/bin/env python3
"""App Store screenshots and app previews from the iOS Simulator.

The same demo trip and the same eight moments as the Google Play set (scripts/store-screenshots.py, whose trip, car,
labels and scene names this imports): first run like a new user, the Kyiv region downloaded, then the drive to Ocean
Plaza on the app's emulated STN adapter, the stop at the Socar station added on the way, GPS jumping abroad after the
first turn. The Simulator has no gyroscope, so the app turns by the wheels alone, as `--no-gyro` does on Android. It
shoots 01-guidance … 08-maps (see store-screenshots.py) at 1320x2868, the 6.9" iPhone's native size (an iPhone 17 Pro
Max on iOS 26.3, the runtime whose CarPlay works), flattened to RGB (App Store Connect refuses an alpha channel).

How it drives the Simulator:
- Taps, typing and the UI tree through AXe (`brew install cameroncooke/axe/axe`): HID events into the Simulator, so
  the Mac's screen may be locked. The device gets the run's keyboard alone (two would bring iOS's "Type both
  languages" sheet); see LOCALES for how the search is typed. Back is the edge swipe.
- GPS: `simctl location start` once a second, from where the car is to where it will be, at its speed. Its fixes carry
  a speed (`simctl location set` fixes don't, and the app never trusts a fix without one), but every fix of a scenario
  carries the scenario's start time, so each second starts a new one (its interval longer than the second, so none
  repeats an old time). The Simulator flags all its fixes as simulated; on a simulator the app takes them as GPS
  (sensor-service.ts), on a phone it refuses them.
- The device: language, region and keyboard set and rebooted into, the theme, the status bar at 9:41 with full
  signal and battery; the app reinstalled (its data wiped) with location allowed ahead, as a driver would. Headless:
  quit Simulator.app first (its window puts the Mac's keyboard layout into the device). Deep links are opened as from
  another app, iOS's "Open in “wtf.ai”?" answered.
- Release builds log no JS, so the Android run's check of the app's routes against the trip (`wtf-demo-route`) is not
  made here: look at 05-route and 02-spoofed.

- The app's clock: launched in a time zone where it is 11 o'clock (APP_HOUR), so the router's rush hour (17:00-19:00)
  never changes the route, whatever the time on the Mac.

--video records the screen (`simctl io recordVideo`) and the Mac's sound, which the Simulator plays through
(scripts/mac-audio-record.swift: ScreenCaptureKit, no loopback driver; the process running this needs Screen
Recording permission, and anything else the Mac plays is recorded too). It cuts them into app previews, each 15-30 s
at 886x1920 and 30 fps, H.264 with AAC stereo: PREVIEWS lists their scenes, sped up as the Play promo's (driving 2x,
the rest 1.5x) and fitted into App Store Connect's 15-30 s. The recordings and the scenes stay in --work for --recut.
Record with the Mac awake and idle (no builds, no replays): stalls show.

Build first (a store build, the JS bundle embedded, maps from UPDATES_ORIGIN in .env.local; expo-updates off so this
checkout's JS is what runs):

    DISTRIBUTION=store CARPLAY_ENTITLEMENT=1 npx expo prebuild -p ios --clean && git checkout -- package.json
    /usr/libexec/PlistBuddy -c "Set :EXUpdatesEnabled false" ios/wtfai/Supporting/Expo.plist
    xcodebuild -workspace ios/wtfai.xcworkspace -scheme wtfai -configuration Release \\
      -destination "platform=iOS Simulator,name=iPhone 17 Pro Max,OS=26.3" -derivedDataPath build CODE_SIGN_IDENTITY=- build

    python3 scripts/app-store-screenshots.py store-assets/app-store/dark --dark --video
    python3 scripts/app-store-screenshots.py store-assets/app-store/uk-light --lang uk --video
    python3 scripts/app-store-screenshots.py store-assets/app-store/dark --dark --recut   # the previews cut again
    python3 scripts/app-store-screenshots.py OUT --medium-from store-assets/app-store/dark  # 6.3" copies, 1206x2622

The sets are in store-assets/app-store/ (Git LFS): light/, dark/, uk-light/, uk-dark/, each with its
preview[-uk][-dark]-N-*.mp4.

--carplay shoots the car's screen on the same trip instead, for the website and the listing (the App Store has no
CarPlay slot): 01-guidance, 02-spoofed, 03-camera as the phone's, and 04-stop standing at the station. It needs
Simulator.app open (its CarPlay window is the car's screen; I/O › External Displays › CarPlay at the size last set
there: 1920x720, scale 3, the wide screen) and the Mac unlocked (the app is opened from CarPlay's dock by a click on the Mac's screen). The
destination comes by link, as the window puts the Mac's keyboard in the device. The Simulator's car is always at
night: without --dark the app is launched with `-CarPlayDay YES`, which in a Simulator build draws the car by day (its
map, bar and buttons; CarPlay's own dock and cards stay dark). The sets are store-assets/carplay/{light,dark,uk-light,
uk-dark}/, for the website's light and dark modes.

    python3 scripts/app-store-screenshots.py store-assets/carplay/uk-light --carplay --lang uk
"""
import argparse
import importlib.util
import json
import os
import select
import signal
import subprocess
import tempfile
import threading
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def _play():
    spec = importlib.util.spec_from_file_location("store_screenshots", os.path.join(HERE, "store-screenshots.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


play = _play()

BUNDLE = "ai.wtf.navigator"
APP = os.path.join(ROOT, "build", "Build", "Products", "Release-iphonesimulator", "wtfai.app")
DEVICE, RUNTIME = "iPhone 17 Pro Max", "com.apple.CoreSimulator.SimRuntime.iOS-26-3"
SIZE, POINTS = (1320, 2868), (440, 956)
# App previews for the 6.9" (and 6.5") iPhones; screenshots for the 6.3" ones (--medium-from): the same picture
# within 0.3 % (a few rows trimmed, never stretched further).
PREVIEW_SIZE, MEDIUM_SIZE = (886, 1920), (1206, 2622)
PREVIEW_MIN_S, PREVIEW_MAX_S = 15.5, 29.5
# The previews: each a few of the recording's scenes (store-screenshots.py's names; "arrive-end" the arrival's last
# ARRIVE_END_S, as the whole one is too long to share a preview), in order.
PREVIEWS = [
    ("spoofed", ["plan", "drive-off", "spoof"]),
    ("stop", ["add-stop", "pull-in"]),
    ("camera", ["camera", "arrive-end"]),
]
ARRIVE_END_S = 26
DRIVING_SCENES = play.DRIVING_SCENES | {"arrive-end"}
# iOS hands the app a link of up to about 2 KB (longer, the app got it without its query: the emulator drove its own
# cycle): the drive's profiles are thinned to fit, straight lines between the points kept within these.
LINK_MAX = 2000
SPEED_TOL_KMH, HEADING_TOLS_DEG = 0.3, (0.5, 1.0, 1.5, 2.0, 2.5, 3.0)
# The device per app language: its language, region (24-hour clock, metric) and its one keyboard. The search: "Ocean
# Plaza" in both, as the Play takes (the map knows it by no Ukrainian spelling). In English typed on the on-screen
# keyboard's keys; the Ukrainian one has no Latin keys, so there it is typed as from a hardware keyboard with a US layout
# (`hid`), and iOS hides the on-screen keyboard, as Play's Ukrainian shot has none. The camera card's warning (src/i18n).
LOCALES = {
    "en": {"language": "en", "locale": "en_GB", "keyboard": "en_GB@sw=QWERTY;hw=Automatic", "hid": False,
           "slow_down": "Slow down"},
    "uk": {"language": "uk", "locale": "uk_UA", "keyboard": "uk_UA@sw=Ukrainian;hw=US", "hid": True,
           "slow_down": "Зменште швидкість"},
}
# The app's clock: launched in the time zone where it is APP_HOUR o'clock now, whatever the Mac's. From 17:00 to 19:00
# the router slows a big city's main roads (×1.4): the demo route took 11 min instead of 9, found no alternative, and
# 05-route showed the zoomed-in map instead of the overview. Arrival times read as the Play set's.
APP_HOUR = 11
TAP_S = 0.18  # a finger's tap: the button's pressed look shows on the recording
KEY_S, KEY_GAP_S = 0.07, 0.12

UDID = None
FAIL_DIR = None
CARPLAY = False  # --carplay: the car's screen is shot, not the phone's
CAR_DAY = False  # --carplay without --dark: the car drawn by day (the app's `-CarPlayDay`, Simulator builds only)
# The car's shots, at the phone shots' moments of the same names, and at the station.
CAR_SHOTS = ("01-guidance", "02-spoofed", "03-camera")
# The app's icon in CarPlay's side dock, in pixels of a 720 px high car display (the dock's width is fixed: the
# same place at 1200 and 1920 wide).
CAR_DOCK_ICON = (77, 303)
CAR_HEIGHT_PX = 720


def run(*args, check=False, timeout=120):
    return subprocess.run(args, capture_output=True, text=True, check=check, timeout=timeout)


def simctl(*args, **kw):
    return run("xcrun", "simctl", *args, **kw)


def find_device():
    """The UDID of an iPhone 17 Pro Max on iOS 26.3, made if there is none."""
    devices = json.loads(simctl("list", "devices", "-j", check=True).stdout)["devices"].get(RUNTIME, [])
    for d in devices:
        if d["name"] == DEVICE and d.get("isAvailable", True):
            return d["udid"]
    return simctl("create", DEVICE, DEVICE, RUNTIME, check=True).stdout.strip()


def prepare_device(lang, dark):
    """The device in the run's language, region and keyboard (read at boot: rebooted into), theme and status bar."""
    if not CARPLAY and run("pgrep", "-x", "Simulator").returncode == 0:
        # Its window, attaching to the device, adds the Mac's keyboard layout to the device's keyboards (a German Mac's
        # QWERTZ in an English take, the "Type both languages" sheet over the search). The run is headless.
        raise SystemExit("quit Simulator.app first: it brings the Mac's keyboard into the device")
    loc = LOCALES[lang]
    simctl("boot", UDID)
    simctl("bootstatus", UDID, "-b", timeout=300)
    write = lambda domain, *kv: simctl("spawn", UDID, "defaults", "write", domain, *kv)
    write("-g", "AppleLanguages", "-array", loc["language"])
    write("-g", "AppleLocale", loc["locale"])
    write("-g", "AppleKeyboards", "-array", loc["keyboard"])
    write("-g", "AppleKeyboardsExpanded", "-int", "1")
    # The keyboard's own introductions (slide to type, the predictions bar's tips), as if seen.
    for key in ("DidShowContinuousPathIntroduction", "DidShowGestureKeyboardIntroduction"):
        write("com.apple.keyboard.preferences", key, "-bool", "true")
    # No hardware keyboard: a Ukrainian run's typing leaves it "seen" and the on-screen keyboard minimized, below the
    # screen (the next English run tapped keys that weren't there).
    write("com.apple.keyboard.preferences", "HardwareKeyboardLastSeen", "-bool", "false")
    write("com.apple.keyboard.preferences", "AutomaticMinimizationEnabled", "-bool", "false")
    simctl("shutdown", UDID)
    simctl("boot", UDID)
    simctl("bootstatus", UDID, "-b", timeout=300)
    # The clock (APP_HOUR) for every process started from here on, CarPlay's host too (it draws the car's arrival time);
    # the app gets it at its launch as well.
    simctl("spawn", UDID, "launchctl", "setenv", "TZ", app_time_zone())
    simctl("ui", UDID, "appearance", "dark" if dark else "light")
    simctl("status_bar", UDID, "override", "--time", "9:41", "--dataNetwork", "5g", "--wifiMode", "active",
           "--wifiBars", "3", "--cellularMode", "active", "--cellularBars", "4", "--operatorName", "",
           "--batteryState", "discharging", "--batteryLevel", "100", check=True)


def install(app):
    simctl("terminate", UDID, BUNDLE)
    simctl("uninstall", UDID, BUNDLE)
    simctl("install", UDID, app, check=True, timeout=300)
    simctl("privacy", UDID, "grant", "location", BUNDLE)


class Car:
    """The car's GPS: a fix a second where the car is, with its speed (a new `simctl location start` each second, see
    the docstring). Before `follow(drive, t0)` it stands at START; with `pos` set, GPS reports there, standing (a
    spoof)."""

    def __init__(self):
        self.drive = None
        self.t0 = None
        self.pos = None
        self.stopped = threading.Event()
        threading.Thread(target=self.run, daemon=True).start()

    def follow(self, drive, t0):
        self.drive, self.t0 = drive, t0

    def run(self):
        while not self.stopped.is_set():
            now = time.time()
            drive = self.drive
            t = now - self.t0 if drive else 0.0
            # A standing car moves at a crawl: a scenario needs a speed, and the app reads 0 km/h.
            v = max(drive.kmh_at(t) / 3.6 if drive and not self.pos else 0.0, 0.05)
            if self.pos or not drive:
                lat, lon = self.pos or play.START
                ahead = v * 6 / 111_320
                points = [(lat, lon), (lat + ahead, lon)]
            else:
                m = drive.metres_at(t)
                points = [drive.point_at(min(m + v * k, drive.length)) for k in (0, 2, 4, 6)]
                if drive.length - m < 1:  # arrived: standing at the end
                    lat, lon = points[0]
                    points = [(lat, lon), (lat + v * 6 / 111_320, lon)]
            simctl("location", UDID, "start", f"--speed={v:.2f}", "--interval=5",
                   *[f"{lat:.7f},{lon:.7f}" for lat, lon in points])
            self.stopped.wait(max(0.0, 1.0 - (time.time() - now)))
        simctl("location", UDID, "clear")


def nodes():
    """The screen's labelled elements: (label, type, x, y) at their middle, in points."""
    out = run("axe", "describe-ui", "--udid", UDID).stdout
    if "[" not in out:
        return []
    found = []

    def walk(n):
        label = (n.get("AXLabel") or n.get("title") or n.get("AXValue") or "").replace("\xa0", " ")
        f = n.get("frame") or {}
        if label and f:
            found.append((label, n.get("type"), f["x"] + f["width"] / 2, f["y"] + f["height"] / 2))
        for c in n.get("children") or []:
            walk(c)

    for n in json.loads(out[out.index("["):]):
        walk(n)
    return found


def matches(label, text, exact):
    """`text` is the label, or one of its comma-separated parts (iOS joins an icon's name and the text: "divide,
    Route"); not exact: within it."""
    if exact:
        return label == text or text in label.split(", ")
    return text.lower() in label.lower()


def find(text, exact=True, kind=None):
    for label, typ, x, y in nodes():
        if matches(label, text, exact) and (kind is None or typ == kind) and 0 < y < POINTS[1]:
            return x, y
    return None


def screenshot(path):
    simctl("io", UDID, "screenshot", "--type=png", path, check=True)


def wait_for(text, seconds=60, exact=True, kind=None):
    end = time.time() + seconds
    while time.time() < end:
        at = find(text, exact, kind)
        if at:
            return at
        time.sleep(1)
    if FAIL_DIR:
        screenshot(os.path.join(FAIL_DIR, "timeout.png"))
    raise SystemExit(f"timed out waiting for {text!r} (screen: timeout.png)")


def wait_gone(text, seconds=30, exact=False):
    end = time.time() + seconds
    while time.time() < end and find(text, exact):
        time.sleep(1)


def tap(x, y, hold=TAP_S):
    run("axe", "touch", "-x", str(round(x)), "-y", str(round(y)), "--down", "--up", "--delay", str(hold), "--udid", UDID)


def tap_text(text, seconds=30, exact=True, kind=None):
    tap(*wait_for(text, seconds, exact, kind))
    time.sleep(1.5)


def tap_if(text):
    at = find(text)
    if at:
        tap(*at)
        time.sleep(1.5)


def tap_when(text, seconds):
    """Taps `text` if it shows within `seconds` (a card that comes a moment after the screen)."""
    end = time.time() + seconds
    while time.time() < end:
        at = find(text)
        if at:
            tap(*at)
            time.sleep(1.5)
            return True
        time.sleep(1)
    return False


def back():
    """iOS's back: the swipe in from the screen's left edge."""
    run("axe", "gesture", "swipe-from-left-edge", "--screen-width", str(POINTS[0]), "--screen-height", str(POINTS[1]),
        "--udid", UDID)
    time.sleep(1.5)


def on_map():
    """The map shows: only it has the tab bar (its links: Route, Vehicle, More)."""
    return any(typ == "Link" for label, typ, x, y in nodes())


def back_to_map():
    """Back until the map shows: a link opens its screen over whatever was open (the close button at the top right, if
    it has one, goes all the way)."""
    for _ in range(4):
        if on_map():
            return
        close = next(((x, y) for label, typ, x, y in nodes() if typ == "Button" and x > 380 and y < 130), None)
        if close:
            tap(*close)
            time.sleep(1.5)
        else:
            back()
    if not on_map():
        raise SystemExit("couldn't get back to the map")


def connected(seconds=20):
    """When the adapter tapped in the list connects: the moment its name heads the Vehicle screen (the emulator's
    profile counts from there; it came up to 8 s after the tap)."""
    end = time.time() + seconds
    while time.time() < end:
        before = time.time()
        if any(label == play.ADAPTER and typ == "StaticText" for label, typ, x, y in nodes()):
            return (before + time.time()) / 2
        time.sleep(0.2)
    raise SystemExit(f"{play.ADAPTER} didn't connect")


def swipe_up():
    """A short, slow scroll up (250 pt, no fling): a long one carried Ukrainian Kyiv's row, higher in the list, past the
    top."""
    run("axe", "swipe", "--start-x", "220", "--start-y", "700", "--end-x", "220", "--end-y", "450", "--duration", "1.0",
        "--udid", UDID)
    time.sleep(1.5)


def open_link(path):
    """Opens a deep link, as from another app. The first after an install, iOS asks "Open in “wtf.ai”?": answered by
    the sheet's right-hand button (Open; Cancel is on the left), in whatever language the device is."""
    simctl("openurl", UDID, f"wtfai://{path}")
    end = time.time() + 5
    while time.time() < end:
        found = nodes()
        sheet = next((y for label, typ, x, y in found if typ == "Sheet"), None)
        if sheet is not None:
            buttons = [(x, y) for label, typ, x, y in found if typ == "Button" and abs(y - sheet) < 80]
            if buttons:
                tap(*max(buttons))
                break
        time.sleep(0.5)
    time.sleep(1.5)


def type_keys(text):
    """Types `text` by tapping the on-screen keyboard's keys, as a finger does. A capital takes shift, unless the
    keyboard shows capitals already (the field's first letter). False when the keyboard isn't on the screen."""
    keys, caps = {}, False
    for _ in range(6):  # it rises after the field takes focus
        found = [(label, x, y) for label, typ, x, y in nodes()
                 if typ == "Button" and (len(label) == 1 or label == "shift") and y < POINTS[1]]
        if len(found) > 20:
            break
        time.sleep(0.5)
    else:
        return False
    for label, x, y in found:
        keys[label.lower()] = (x, y)
        caps = caps or (len(label) == 1 and label.isalpha() and label.isupper())
    for ch in text:
        if ch.lower() not in keys:
            raise SystemExit(f"no {ch!r} key on the keyboard: is the device's keyboard the run's language?")
        if ch.isupper() and not caps:
            tap(*keys["shift"], hold=KEY_S)
        tap(*keys[ch.lower()], hold=KEY_S)
        caps = False
        time.sleep(KEY_GAP_S)
    return True


def search(query, field, hid):
    """Types into the search field until a result with the query in it shows below the field; returns where it is.
    `hid`: typed as from a hardware keyboard, a lone Shift first, so the on-screen one doesn't show up and vanish. For
    the car's screen, searched by link (Simulator.app's window has put the Mac's keyboard in the device)."""
    if CARPLAY:
        open_link("route?q=" + urllib.parse.quote(query))
        return wait_for(query, 20, kind="Button")
    if hid:
        run("axe", "key", "225", "--udid", UDID)
    for _ in range(2):
        tap_text(field, exact=False)
        time.sleep(1.5)
        if hid:
            run("axe", "type", query, "--udid", UDID)
        elif not type_keys(query):
            print("the on-screen keyboard didn't come up: the field tapped again", flush=True)
            continue
        end = time.time() + 15
        while time.time() < end:
            found = sorted((y, x) for label, typ, x, y in nodes() if typ == "Button" and query.lower() in label.lower())
            if found:
                return found[0][1], found[0][0]
            time.sleep(1)
    raise SystemExit(f"search for {query!r} found nothing")


def osascript(script):
    return run("osascript", "-e", script, timeout=60).stdout.strip()


CAR_WINDOW = '(first window whose name ends with "CarPlay")'


def carplay_display(on):
    """The Simulator's CarPlay display connected (I/O › External Displays › CarPlay…, Run in its setup window, at the
    size it was last set to) or not."""
    if on:
        osascript('''tell application "Simulator" to activate
delay 1
tell application "System Events" to tell process "Simulator"
  set displays to menu 1 of menu item "External Displays" of menu 1 of menu bar item "I/O" of menu bar 1
  repeat with entry in menu items of displays
    if name of entry is not missing value and name of entry starts with "CarPlay" then
      click entry
      exit repeat
    end if
  end repeat
  delay 2
  repeat with w in windows
    try
      click button "Run" of w
    end try
  end repeat
end tell''')
    else:
        osascript('''tell application "Simulator" to activate
delay 1
tell application "System Events" to tell process "Simulator" to click menu item "Disabled" of menu 1 of \
  menu item "External Displays" of menu 1 of menu bar item "I/O" of menu bar 1''')
    time.sleep(8)


def car_screenshot(path):
    simctl("io", UDID, "screenshot", "--display=external", "--type=png", path, check=True)


def mean_level(png):
    """The picture's mean brightness, 0-255."""
    return subprocess.run(["ffmpeg", "-v", "error", "-i", png, "-vf", "scale=1:1,format=gray", "-f", "rawvideo", "-"],
                          capture_output=True, check=True).stdout[0]


def click(x, y):
    """A click at a point of the Mac's screen (CGEvents: the screen must be unlocked)."""
    run("osascript", "-l", "JavaScript", "-e", f'''ObjC.import("CoreGraphics");
const p = $.CGPointMake({x}, {y});
for (const t of [$.kCGEventMouseMoved, $.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) {{
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, t, p, $.kCGMouseButtonLeft));
  delay(0.08);
}}''')


def open_on_car():
    """The CarPlay display connected (once the phone's app has loaded: connected at its launch, it crashed) and the
    app opened from CarPlay's dock. A display connected soon after boot can stay black: then off and on again."""
    raw = os.path.join(tempfile.gettempdir(), "wtf-car.png")
    for _ in range(3):
        carplay_display(True)
        car_screenshot(raw)
        if mean_level(raw) > 8:
            break
        carplay_display(False)
        time.sleep(5)
    else:
        raise SystemExit("the CarPlay display stays black")
    # Where the car's picture sits on the Mac's screen; the first click on the window only brings it forward.
    frame = osascript(f'tell application "System Events" to tell process "Simulator" to get {{position, size}} of '
                      f'group 1 of {CAR_WINDOW}')
    gx, gy, gw, gh = (float(v) for v in frame.split(", "))
    title = osascript(f'tell application "System Events" to tell process "Simulator" to get position of {CAR_WINDOW}')
    tx, ty = (float(v) for v in title.split(", "))
    click(tx + gw / 2, ty + 12)
    time.sleep(1)
    pt = gh / CAR_HEIGHT_PX  # the window's points per car pixel
    click(gx + CAR_DOCK_ICON[0] * pt, gy + CAR_DOCK_ICON[1] * pt)
    time.sleep(6)


def car_shot(out_dir, name):
    """The car's screen as an RGB PNG at the display's size."""
    raw = os.path.join(tempfile.gettempdir(), f"wtf-car-{name}.png")
    car_screenshot(raw)
    run("ffmpeg", "-v", "error", "-y", "-i", raw, "-pix_fmt", "rgb24", os.path.join(out_dir, f"{name}.png"), check=True)
    os.remove(raw)
    print("car shot", name, flush=True)


def snap(out_dir, name):
    """The phone's screen; for the car (--carplay), the car's at its moments (CAR_SHOTS), nothing at the others."""
    if not CARPLAY:
        shot(out_dir, name)
    elif name in CAR_SHOTS:
        time.sleep(1.5)
        car_shot(out_dir, name)


def shot(out_dir, name):
    """The screen as an RGB PNG (no alpha) at the device's native size."""
    time.sleep(1.5)
    raw = os.path.join(tempfile.gettempdir(), f"wtf-app-store-{name}.png")
    screenshot(raw)
    path = os.path.join(out_dir, f"{name}.png")
    run("ffmpeg", "-v", "error", "-y", "-i", raw, "-pix_fmt", "rgb24", path, check=True)
    os.remove(raw)
    print("shot", name, flush=True)


def sound_recorder():
    """scripts/mac-audio-record.swift, compiled (once per change of it)."""
    src = os.path.join(HERE, "mac-audio-record.swift")
    exe = os.path.join(tempfile.gettempdir(), "wtf-mac-audio-record")
    if not os.path.exists(exe) or os.path.getmtime(exe) < os.path.getmtime(src):
        run("swiftc", "-O", src, "-o", exe, check=True, timeout=600)
    return exe


class Recorder:
    """`simctl io recordVideo` of the whole run (the device's native size, as fast as frames change) and the Mac's
    sound beside it (scripts/mac-audio-record.swift: the Simulator plays through the Mac); cut into the previews when
    it stops. The sound's start against the picture's is kept with the scenes."""

    def __init__(self, work, name):
        self.source = os.path.join(work, f"{name}.source.mov")
        self.sound = os.path.join(work, f"{name}.sound.wav")
        self.scenes_json = os.path.join(work, f"{name}.scenes.json")
        self.sound_proc = subprocess.Popen([sound_recorder(), self.sound], stdout=subprocess.PIPE,
                                           stderr=subprocess.STDOUT, text=True)
        ready, _, _ = select.select([self.sound_proc.stdout], [], [], 15)
        line = self.sound_proc.stdout.readline() if ready else ""
        if not line.startswith("started "):
            self.sound_proc.kill()
            raise SystemExit(f"mac-audio-record didn't start ({line.strip() or 'nothing in 15 s'}): does the process "
                             "running this have Screen Recording permission?")
        self.sound_t0 = float(line.split()[1])
        self.proc = subprocess.Popen(["xcrun", "simctl", "io", UDID, "recordVideo", "--codec=h264", "--force",
                                      self.source], stderr=subprocess.PIPE, text=True)
        for line in self.proc.stderr:  # its start: what the scenes' times count from
            if "Recording started" in line:
                break
        else:
            raise SystemExit("simctl recordVideo didn't start")
        self.t0 = time.time()
        self.scenes = []

    def scene(self, name, start, end):
        self.scenes.append((name, max(0.0, start - self.t0), max(0.0, end - self.t0)))

    def stop(self):
        for proc in (self.proc, self.sound_proc):
            proc.send_signal(signal.SIGINT)
        for proc in (self.proc, self.sound_proc):
            proc.wait(timeout=120)
        scenes = [{"scene": n, "from_s": round(a, 2), "to_s": round(b, 2)} for n, a, b in sorted(self.scenes, key=lambda s: s[1])]
        with open(self.scenes_json, "w", encoding="utf-8") as f:
            json.dump({"sound_offset_s": round(self.t0 - self.sound_t0, 3), "scenes": scenes}, f, indent=1)


def clean_video(source):
    """The recording as AVFoundation reads it (avconvert), once: ffmpeg decoding simctl's own file through got frames
    up to 20 s later than their times (its B-frames' decode times ran 19 s behind), so cuts missed their scenes."""
    clean = source.replace(".source.mov", ".clean.mov")
    if not os.path.exists(clean) or os.path.getmtime(clean) < os.path.getmtime(source):
        run("avconvert", "-s", source, "-p", "PresetHighestQuality", "-o", clean, "--replace", check=True, timeout=1800)
    return clean


def cut_previews(source, sound, cut, out_dir, suffix):
    """The previews from the whole recording: each one's scenes trimmed, sped up as the Play promo's (driving
    DRIVE_SPEED, the rest OTHER_SPEED; the voice keeps its pitch), all faster still or slower (never under real time) to
    fit 15-30 s, crossfading into each other, picture and sound alike; scaled to 886 wide and two rows trimmed off the
    top, three off the bottom (1925 → 1920 rows). The sound as App Store Connect asks: AAC stereo, 256 kbps, 48 kHz.
    `cut`: the scenes and where the sound starts against the picture (Recorder.stop)."""
    by_name = {s["scene"]: s for s in cut["scenes"]}
    lead = cut["sound_offset_s"]  # the sound began this long before the picture
    w, h = PREVIEW_SIZE
    scaled_h = round(SIZE[1] * w / SIZE[0])
    for n, (name, wanted) in enumerate(PREVIEWS, 1):
        parts = [by_name[s] for s in wanted if s in by_name]
        if not parts:
            print(f"preview {name}: none of its scenes {wanted} recorded", flush=True)
            continue
        base = [play.DRIVE_SPEED if p["scene"] in DRIVING_SCENES else play.OTHER_SPEED for p in parts]
        spans = [p["to_s"] - p["from_s"] for p in parts]
        length = lambda f: sum(s / (k * f) for s, k in zip(spans, base)) - play.CROSSFADE_S * (len(parts) - 1)
        f = 1.0
        if length(1.0) > PREVIEW_MAX_S:
            f = (length(1.0) + play.CROSSFADE_S * (len(parts) - 1)) / (PREVIEW_MAX_S + play.CROSSFADE_S * (len(parts) - 1))
        elif length(1.0) < PREVIEW_MIN_S:
            f = max(1.0 / min(base), (sum(s / k for s, k in zip(spans, base))) / (PREVIEW_MIN_S + play.CROSSFADE_S * (len(parts) - 1)))
        speeds = [k * f for k in base]
        total = length(f)
        pad = max(0.0, PREVIEW_MIN_S - total)  # still short at real time: the last frame held
        graph = []
        for i, (p, k) in enumerate(zip(parts, speeds)):
            graph.append(f"[0:v]trim=start={p['from_s']:.3f}:end={p['to_s']:.3f},setpts=(PTS-STARTPTS)/{k:.4f},"
                         f"fps={play.VIDEO_FPS},scale={w}:{scaled_h}:flags=lanczos,crop={w}:{h}:0:2,setsar=1,"
                         f"format=yuv420p,settb=AVTB[v{i}]")
        v, acc = "v0", spans[0] / speeds[0]
        for i in range(1, len(parts)):
            graph.append(f"[{v}][v{i}]xfade=transition=fade:duration={play.CROSSFADE_S}:"
                         f"offset={acc - play.CROSSFADE_S:.3f}[x{i}]")
            v = f"x{i}"
            acc += spans[i] / speeds[i] - play.CROSSFADE_S
        for i, (p, k) in enumerate(zip(parts, speeds)):
            graph.append(f"[1:a]atrim=start={p['from_s'] + lead:.3f}:end={p['to_s'] + lead:.3f},asetpts=PTS-STARTPTS,"
                         f"atempo={k:.4f}[a{i}]")
        a = "a0"
        for i in range(1, len(parts)):
            graph.append(f"[{a}][a{i}]acrossfade=d={play.CROSSFADE_S}[ax{i}]")
            a = f"ax{i}"
        if pad:
            graph.append(f"[{v}]tpad=stop_mode=clone:stop_duration={pad:.3f}[vp]")
            v = "vp"
        graph.append(f"[{a}]apad[ap]")  # the held last frame silent
        out = os.path.join(out_dir, f"preview{suffix}-{n}-{name}.mp4")
        run("ffmpeg", "-v", "error", "-y", "-i", clean_video(source), "-i", sound, "-filter_complex", ";".join(graph), "-map", f"[{v}]", "-map", "[ap]", "-t", f"{total + pad:.3f}",
            "-r", str(play.VIDEO_FPS), "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-level", "4.0",
            "-b:v", "10M", "-maxrate", "12M", "-bufsize", "24M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k",
            "-ar", "48000", "-movflags", "+faststart", out, check=True, timeout=900)
        print(f"preview {out}: {total + pad:.1f} s, {'+'.join(p['scene'] for p in parts)} at "
              f"{', '.join(f'{k:.2f}x' for k in speeds)}" + (f", last frame held {pad:.1f} s" if pad else ""), flush=True)


def thinned(points, tol):
    """`points` (t, value) with those dropped that a straight line between their neighbours kept give within `tol`
    (Douglas-Peucker): the emulator reads its profiles straight between points."""
    if len(points) < 3:
        return list(points)
    (t0, v0), (t1, v1) = points[0], points[-1]
    worst, at = -1.0, 0
    for i in range(1, len(points) - 1):
        t, v = points[i]
        off = abs(v - (v0 + (t - t0) / (t1 - t0) * (v1 - v0)))
        if off > worst:
            worst, at = off, i
    if worst <= tol:
        return [points[0], points[-1]]
    return thinned(points[:at + 1], tol)[:-1] + thinned(points[at:], tol)


def drive_link(drive):
    """The emulated adapter's link for `drive`, its speed and heading profiles thinned to fit iOS's link length. The
    drive's own speed profile becomes the thinned one: GPS moves by exactly what the wheels turn by."""
    drive.profile = thinned(drive.profile, SPEED_TOL_KMH)
    cycle = ",".join(f"{t:g}:{kmh:g}" for t, kmh in drive.profile)
    heading = [tuple(map(float, p.split(":"))) for p in drive.turn_spec().split(",")]
    for tol in HEADING_TOLS_DEG:
        turn = ",".join(f"{t:g}:{deg:.0f}" for t, deg in thinned(heading, tol))
        link = f"vehicle?emulators=1&cycle={cycle}&turn={turn}"
        if len(link) <= LINK_MAX:
            print(f"adapter link {len(link)} characters: speed within {SPEED_TOL_KMH} km/h, heading within {tol}°",
                  flush=True)
            return link
    raise SystemExit(f"the drive's link is {len(link)} characters even with its heading within {tol}°: iOS cuts it")


def medium_copies(src_dir, out_dir):
    """The 6.3" iPhones' screenshots from a 6.9" set: 1206x2622 (the aspect within 0.07 %)."""
    os.makedirs(out_dir, exist_ok=True)
    for name in sorted(f for f in os.listdir(src_dir) if f.endswith(".png")):
        run("ffmpeg", "-v", "error", "-y", "-i", os.path.join(src_dir, name), "-vf",
            f"scale={MEDIUM_SIZE[0]}:{MEDIUM_SIZE[1]}:flags=lanczos", "-pix_fmt", "rgb24", os.path.join(out_dir, name),
            check=True)
        print("6.3\"", name, flush=True)


def app_time_zone():
    """The zone where it is APP_HOUR o'clock now (Etc/GMT-3 is UTC+3)."""
    off = (APP_HOUR - time.gmtime().tm_hour + 12) % 24 - 12
    return "Etc/GMT" if off == 0 else f"Etc/GMT{-off:+d}"


def first_run(say):
    zone = app_time_zone()
    print(f"the app's time zone {zone}", flush=True)
    day = ["-CarPlayDay", "YES"] if CAR_DAY else []
    subprocess.run(["xcrun", "simctl", "launch", UDID, BUNDLE, *day], env=dict(os.environ, SIMCTL_CHILD_TZ=zone),
                   capture_output=True, check=True)
    tap_text(say["get_started"], 120)
    tap_text(say["allow"])
    tap_text(say["skip"])
    tap_text(say["not_now"])  # automatic launch: not for the demo, which starts the drive itself
    tap_text(say["done"])


def download_kyiv(say):
    wait_for(say["regions"], 60, exact=False)
    for _ in range(16):
        found = nodes()
        row = next((y for label, typ, x, y in found if label.endswith(": " + say["kyiv"]) and 150 < y < POINTS[1] - 120), None)
        if row:
            button = [(x, y) for label, typ, x, y in found if label == say["download"] and abs(y - row) < 15]
            if button:
                tap(*button[0])
                # The map replaces the region list once the region is installed.
                wait_for(say["trusted"], 600)
                return
        swipe_up()
    raise SystemExit("Kyiv not found in the region list")


def maps_only(args):
    """08-maps alone, as the full run shoots it: the device set up, the app new, Kyiv downloaded, Offline maps."""
    prepare_device(args.lang, args.dark)
    install(args.app)
    car = Car()
    say = play.LABELS[args.lang]
    try:
        first_run(say)
        download_kyiv(say)
        tap_when(say["not_now"], 10)  # the map tour
        open_link("more/downloads")
        shot(args.out_dir, "08-maps")
    finally:
        car.stopped.set()
        time.sleep(1.5)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out_dir")
    ap.add_argument("--lang", choices=sorted(LOCALES), default="en", help="the app's and the device's language")
    ap.add_argument("--dark", action="store_true", help="dark theme")
    ap.add_argument("--video", action="store_true", help="also record the run and cut the app previews from it")
    ap.add_argument("--app", default=APP, help="the Release .app to install")
    ap.add_argument("--udid", help="the simulator (default: an iPhone 17 Pro Max on iOS 26.3, made if missing)")
    ap.add_argument("--work", help="where the recording and its scenes stay (default: a folder in the temp dir)")
    ap.add_argument("--recut", action="store_true", help="only cut the previews again from --work's recording")
    ap.add_argument("--medium-from", metavar="SET_DIR", help="only write 6.3\" copies of SET_DIR's shots into out_dir")
    ap.add_argument("--carplay", action="store_true",
                    help="shoot the car's screen instead (CarPlay; by day unless --dark): Simulator.app open, the Mac "
                         "unlocked")
    ap.add_argument("--maps-only", action="store_true",
                    help="only shoot 08-maps again (first run and the Kyiv download, no drive, no video)")
    args = ap.parse_args()
    suffix = ("" if args.lang == "en" else f"-{args.lang}") + ("-dark" if args.dark else "")
    work = args.work or os.path.join(tempfile.gettempdir(), "wtf-app-store", f"run{suffix or '-en'}")
    os.makedirs(args.out_dir, exist_ok=True)
    os.makedirs(work, exist_ok=True)
    if args.medium_from:
        medium_copies(args.medium_from, args.out_dir)
        return
    name = f"preview{suffix}"
    if args.recut:
        with open(os.path.join(work, f"{name}.scenes.json"), encoding="utf-8") as f:
            cut_previews(os.path.join(work, f"{name}.source.mov"), os.path.join(work, f"{name}.sound.wav"), json.load(f),
                         args.out_dir, suffix)
        return

    global UDID, FAIL_DIR, CARPLAY, CAR_DAY
    UDID = args.udid or find_device()
    FAIL_DIR = args.out_dir
    CARPLAY = args.carplay
    CAR_DAY = CARPLAY and not args.dark
    if CARPLAY:
        if run("pgrep", "-x", "Simulator").returncode != 0:
            raise SystemExit("--carplay: open Simulator.app (its CarPlay window is the car's screen)")
        args.video = False
        carplay_display(False)  # installing with a car connected wedged CarPlay
    if args.maps_only:
        maps_only(args)
        return
    # The trip, before touching the device: a release that lost the camera or the station stops here.
    graph, cameras = play.release_files(os.path.join(tempfile.gettempdir(), "wtf-store-maps"))
    path, stop_at = play.plan_trip(graph, work)
    probe = play.Drive(path)
    stop_m, stop_off = probe.project(stop_at)
    camera_m = play.camera_on(probe, cameras)
    print(f"trip {probe.length:.0f} m: the station at {stop_m:.0f} m ({stop_off:.0f} m off), the camera at {camera_m:.0f} m",
          flush=True)
    drive = play.Drive(path, stands=[(stop_m, play.STOP_STAND_S)], caps=[
        (camera_m - play.SPEEDING_FROM_M, camera_m - play.SPEEDING_TO_M, play.SPEEDING_KMH),
        (camera_m - play.SPEEDING_TO_M, camera_m + 30, play.CAMERA_KMH),
        (play.SLOW_END_FROM_M, probe.length, play.END_KMH),
    ])
    link = drive_link(drive)

    # The Mac awake for the whole run: a sleeping display stalls the Simulator's frames.
    awake = subprocess.Popen(["caffeinate", "-dimsu", "-w", str(os.getpid())])
    prepare_device(args.lang, args.dark)
    install(args.app)
    car = Car()
    say = play.LABELS[args.lang]
    out = args.out_dir
    video = None
    try:
        first_run(say)
        download_kyiv(say)
        tap_when(say["not_now"], 10)  # the map tour
        # Emulated adapters on before the drive (the store build hides the Developer screen).
        open_link("vehicle?emulators=1")
        back_to_map()
        tap_when(say["not_now"], 10)  # "Practise before your first drive" comes a moment after the map
        if CARPLAY:
            open_on_car()

        video = Recorder(work, name) if args.video else None
        rec_from = time.time()
        route_tab = wait_for(say["route"], kind="Link")
        tap(*route_tab)
        time.sleep(1.5)
        result = search(play.DESTINATION, say["search"], LOCALES[args.lang]["hid"])
        snap(out, "06-search")
        tap(*result)
        tap_text(say["start"], 20)
        tap_if(say["agree"])
        # The route on the map, and the other ways found after it, one by one.
        time.sleep(2)
        wait_gone(say["finding_alternatives"], 30)
        time.sleep(2)
        snap(out, "05-route")
        if video:
            video.scene("plan", rec_from, time.time())

        # Standing, from the Route tab's tiles: the fuel along the route, then parking near the destination.
        tap(*route_tab)
        fuel_tile = wait_for(say["fuel"], 20)
        tap(*fuel_tile)
        wait_for(play.STOP_NAME, 20)
        time.sleep(2)
        back()
        t_parking = time.time()
        tap_text(say["parking"])
        wait_for(say["parking_for"].format(name=play.DESTINATION), 20, exact=False)
        time.sleep(2)
        snap(out, "07-parking")
        back()
        back()
        if video:
            video.scene("parking", t_parking - 0.5, time.time() - 1.5)

        # The adapter: it drives the trip's speed profile from connecting, its wheels turning as the car's heading
        # does; GPS follows the same drive.
        open_link(link)
        tap(*wait_for(play.ADAPTER + ", ", 30, exact=False, kind="Button"))  # its row in the list
        t0 = connected()
        car.follow(drive, t0)
        tap_when(say["fw_skip"], 10)  # an STN connecting for the first time: the firmware notice
        back_to_map()
        wall = lambda s: t0 + s
        at = lambda s: time.sleep(max(0.0, wall(s) - time.time()))
        t_move = drive.time_at(1)
        at(drive.time_at(play.GUIDANCE_AT_M))
        snap(out, "01-guidance")
        at(drive.time_at(play.SPOOF_AT_M))
        car.pos = play.ABROAD
        if video:
            video.scene("drive-off", wall(t_move - 1), wall(t_move + 8))
            video.scene("spoof", wall(drive.time_at(play.SPOOF_AT_M) - 3), wall(drive.time_at(play.SPOOF_AT_M) + 8))

        # The stop, added from the Route tab while driving: Fuel, the station's row (its detour), added with Undo.
        at(drive.time_at(play.STOP_ADD_AT_M))
        t_add = time.time()
        tap(*route_tab)
        time.sleep(2)
        tap(*fuel_tile)
        time.sleep(4)  # the detours counted
        snap(out, "04-stops")
        tap(*wait_for(play.STOP_NAME, 10))
        time.sleep(2)
        back_to_map()  # the trip → the map, the Undo card over it
        if video:
            video.scene("add-stop", t_add - 1, time.time() + 4)
        if time.time() > wall(drive.time_at(play.SPOOFED_SHOT_AT_M)):
            print("the stop took past the spoofed shot's place: shot late", flush=True)
        at(drive.time_at(play.SPOOFED_SHOT_AT_M))
        snap(out, "02-spoofed")
        if CARPLAY:  # at the station, standing: the stop reached
            at(drive.time_at(stop_m) + play.STOP_STAND_S / 2)
            car_shot(out, "04-stop")
        if video:
            video.scene("pull-in", wall(drive.time_at(stop_m - 120)), wall(drive.time_at(stop_m + 1) + 3))
            video.scene("camera", wall(drive.time_at(camera_m - 450)), wall(drive.time_at(camera_m + 30)))
        # Shot once "Slow down" shows: the speed bubble crosses the limit's margin a moment after the wheels do (at the
        # Play shot's time it still read 61 here, the camera card not yet red).
        at(drive.time_at(camera_m - play.SPEEDING_TO_M - 120))
        wait_for(LOCALES[args.lang]["slow_down"], 10, exact=False)
        snap(out, "03-camera")
        if CARPLAY:  # the car's last shot: no need to drive on
            return
        end_s = drive.profile[-1][0] + 4
        at(end_s)  # through the 40 and 30 zones to the destination
        if video:
            video.scene("arrive", wall(drive.time_at(play.ARRIVE_SCENE_FROM_M)), wall(end_s - 1))
            video.scene("arrive-end", wall(end_s - 1 - ARRIVE_END_S), wall(end_s - 1))
        tap_if(say["stop_guidance"])

        t_maps = time.time()
        open_link("more/downloads")
        shot(out, "08-maps")
        if video:
            video.scene("maps", t_maps, time.time() + 1)
            video.stop()
            video = None
            with open(os.path.join(work, f"{name}.scenes.json"), encoding="utf-8") as f:
                cut_previews(os.path.join(work, f"{name}.source.mov"), os.path.join(work, f"{name}.sound.wav"),
                             json.load(f), out, suffix)
    finally:
        if video:
            video.proc.send_signal(signal.SIGINT)
            video.sound_proc.send_signal(signal.SIGINT)
        car.stopped.set()
        time.sleep(1.5)
        if CARPLAY:
            carplay_display(False)
        awake.terminate()


if __name__ == "__main__":
    main()
