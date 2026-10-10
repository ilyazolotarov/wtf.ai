#!/usr/bin/env python3
"""Large-text sweep on the Android emulator (docs/UI-SPEC.md §8): every page at the largest text and display sizes.

Against a running emulator with the app installed (and, for a debug build, Metro up and the app opened from it once):
for each text/display size it opens each page by deep link, scrolls it to the end screen by screen, saves the
screenshots, and checks the UI tree:

  - under-nav-bar: at the end of a page (and anywhere on the map), text or a button reaches into the navigation bar;
  - spills-out:    a text overflows the button or chip it labels.

Exit code 1 when a check fails. What a check can't see (a label shrunk too far, a layout that merely looks wrong) is
in the screenshots: look through them, in both languages (Settings → Language; the sweep keeps the app's language).

    python scripts/android-ui-sweep.py out-dir
    python scripts/android-ui-sweep.py out-dir --sizes 2.0:560 --pages vehicle more/settings

Leaves the emulator at its default text and display size. Pillow, when installed, adds contact sheets (4 shots each).
"""
import argparse
import io
import os
import re
import subprocess
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET

PKG = "ai.wtf.navigator"
SCHEME = "wtfai://"
# Every page and lesson; "" is the map. Onboarding and map-setup change what the app does next, so they're left out:
# open them by hand (Guide → "Show the first-run screens again"; map-setup with no map installed).
PAGES = [
    "",
    "route",
    "vehicle",
    "more",
    "more/settings",
    "more/downloads",
    "more/update",
    "more/recorder",
    "more/position",
    "more/developer",
    "more/ui-gallery",
    "guide",
    *(f"guide/lesson?id={lesson}" for lesson in ["before", "dot", "car", "jamming", "place", "pose", "route", "voice", "maps"]),
    "trips",
]
# font scale : display density (the emulator's default density is the phone's; 560 is about "Largest" on a 420 dpi phone).
SIZES = ["1.0:0", "1.3:504", "2.0:560"]

ADB = os.environ.get("ADB") or "adb"
env = dict(os.environ, MSYS_NO_PATHCONV="1")  # Git Bash would rewrite /sdcard paths.


def adb(*args, timeout=30):
    """Never waits forever: `uiautomator dump` can stall while something animates."""
    try:
        return subprocess.run([ADB, *args], capture_output=True, env=env, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 1, b"", b"timeout")


def screenshot():
    return adb("exec-out", "screencap", "-p").stdout


def ui_tree():
    for _ in range(3):
        adb("shell", "uiautomator", "dump", "/sdcard/wtf-ui.xml")
        xml = adb("exec-out", "cat", "/sdcard/wtf-ui.xml").stdout
        if xml.startswith(b"<?xml"):
            return ET.fromstring(xml)
        time.sleep(1)  # Fails while something animates; try again.
    return None


def bounds(node):
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
    return tuple(map(int, m.groups())) if m else None


def nav_bar_top():
    """Top of the navigation bar in px (the screen's height without one)."""
    out = adb("shell", "dumpsys", "window").stdout.decode(errors="replace")
    m = re.search(r"type=navigationBars frame=\[\d+,(\d+)\]\[\d+,(\d+)\] visible=true", out)
    if m and int(m.group(1)) < int(m.group(2)):
        return int(m.group(1))
    size = adb("shell", "wm", "size").stdout.decode()
    return int(re.findall(r"(\d+)x(\d+)", size)[-1][1])


def check_tree(root, nav_top, at_end):
    """The failures on one screen, as text."""
    problems = []

    def label(node):
        return (node.get("text") or node.get("content-desc") or "").strip()

    def walk(node, button):
        b = bounds(node)
        own = node.get("package") == PKG
        clickable = node.get("clickable") == "true"
        text = label(node) if node.get("class") == "android.widget.TextView" else ""
        # Not the full-screen views (the map itself is clickable): they run under the bar by design.
        tall = b is not None and b[3] - b[1] > nav_top / 2
        if own and b and at_end and (text or clickable) and not tall and b[3] > nav_top + 2 and b[1] < nav_top:
            problems.append(f"under-nav-bar: {text or node.get('class')!r} {b} (bar at y={nav_top})")
        if own and b and text and button is not None:
            bb = bounds(button)
            if bb and (b[0] < bb[0] - 2 or b[2] > bb[2] + 2 or b[1] < bb[1] - 2 or b[3] > bb[3] + 2):
                problems.append(f"spills-out: {text!r} {b} outside its button {bb}")
        for child in node:
            walk(child, node if clickable and own else button)

    walk(root, None)
    return problems


def blank(png):
    """A screen of one colour (the app still starting); without Pillow, never."""
    try:
        from PIL import Image, ImageStat
    except ImportError:
        return False
    im = Image.open(io.BytesIO(png)).convert("L")
    w, h = im.size
    # Without the status and navigation bars: their icons are there on a blank app too.
    return ImageStat.Stat(im.crop((0, h * 8 // 100, w, h * 85 // 100))).stddev[0] < 3


def wait_for_app(seconds=90):
    """Until the app draws something (a restart after a density change, a debug build loading its JS)."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        if not blank(screenshot()):
            time.sleep(2)  # The first frame; let it settle.
            return True
        time.sleep(2)
    return False


# Swipes run down the page's left margin (the pages' 16 dp gutter): in the middle they would move a slider instead.
SWIPE_X = "30"


def opened(before, seconds=10):
    """Whether the screen changed into a page: unlike the map under it, a page holds still between two shots."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        time.sleep(1.5)
        a = screenshot()
        if same_screen(a, before):
            continue
        time.sleep(1)
        if same_screen(a, screenshot()):
            return True
    return False


def scroll_to_top():
    for _ in range(25):
        adb("shell", "input", "swipe", SWIPE_X, "500", SWIPE_X, "2000", "60")
    time.sleep(1.2)


def same_screen(a, b):
    """True when two screenshots barely differ (the scroll reached the end; an animation may move a few pixels)."""
    try:
        from PIL import Image, ImageChops, ImageStat
    except ImportError:
        return a == b
    small = lambda png: Image.open(io.BytesIO(png)).convert("L").resize((108, 240))  # noqa: E731
    return ImageStat.Stat(ImageChops.difference(small(a), small(b))).mean[0] < 0.15


def sweep_page(page, out_dir, name, nav_top):
    before = screenshot()
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", SCHEME + page, PKG)
    time.sleep(3)
    if not wait_for_app(30):
        return [], ["blank: the app shows nothing"]
    if page and not opened(before):
        # A link sent while the app was still starting is dropped: once more.
        adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", SCHEME + page, PKG)
        if not opened(before):
            return [], [f"not opened: {SCHEME + page} left the screen as it was"]
    if page:
        scroll_to_top()
    shots, problems, last, tree = [], [], None, None
    # Screens whose UI tree couldn't be read: uiautomator waits for the UI to go idle, and a moving map never does
    # (an emulated adapter driving). Their screenshots are still saved.
    unchecked = []
    at_end = not page  # The map doesn't scroll.
    for i in range(40):
        png = screenshot()
        if last is not None and same_screen(png, last):
            at_end = True
            break
        last = png
        tree = ui_tree()
        if tree is not None:
            problems += check_tree(tree, nav_top, at_end=False)
        else:
            unchecked.append(i)
        path = os.path.join(out_dir, f"{name}-{i:02d}.png")
        with open(path, "wb") as f:
            f.write(png)
        shots.append(path)
        if not page:
            break  # The map doesn't scroll.
        adb("shell", "input", "swipe", SWIPE_X, "1800", SWIPE_X, "500", "900")
        time.sleep(0.8)
    # The end of the page (or the map): nothing may sit under the navigation bar. A page longer than 40 screens is
    # left unchecked there.
    if tree is not None and at_end:
        problems += [p for p in check_tree(tree, nav_top, at_end=True) if p.startswith("under-nav-bar")]
    if page:
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(1)
    if unchecked:
        print(f"     (screens {unchecked} not checked: the UI never went idle; see their screenshots)")
    return shots, sorted(set(problems))


def contact_sheets(shots, out_dir, name):
    try:
        from PIL import Image
    except ImportError:
        return
    for k in range(0, len(shots), 4):
        ims = [Image.open(p).resize((432, 960)) for p in shots[k : k + 4]]
        sheet = Image.new("RGB", (440 * len(ims) - 8, 960), "red")
        for j, im in enumerate(ims):
            sheet.paste(im, (j * 440, 0))
        sheet.save(os.path.join(out_dir, f"{name}-sheet-{k // 4}.png"))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out", help="directory for screenshots and the report")
    parser.add_argument("--sizes", nargs="+", default=SIZES, help="font_scale:density pairs (density 0 = the default)")
    parser.add_argument("--pages", nargs="+", default=PAGES, help='deep-link paths ("" is the map)')
    parser.add_argument(
        "--dev-url",
        help="a debug build's Metro (e.g. http://127.0.0.1:8081, with adb reverse): reopened after each density change",
    )
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Ukrainian labels on a Windows console.

    failures = []
    try:
        for size in args.sizes:
            font, density = size.split(":")
            adb("shell", "settings", "put", "system", "font_scale", font)
            adb("shell", "wm", "density", "reset" if density == "0" else density)
            # A new density restarts the activity: let the app come back before the first page.
            time.sleep(3)
            if args.dev_url:
                # From a cold start: the dev launcher crashes when given its URL while the activity restarts.
                adb("shell", "am", "force-stop", PKG)
                url = "exp+wtf-ai://expo-development-client/?url=" + urllib.parse.quote(args.dev_url, safe="")
                adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, PKG)
            else:
                adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
            if not wait_for_app():
                failures.append(f"font {font}, density {density}: the app didn't come back after the size change")
                print(f"FAIL font {font}, density {density}: the app shows nothing")
                continue
            nav_top = nav_bar_top()
            for page in args.pages:
                name = f"font{font}-dpi{density}-" + (re.sub(r"[^a-z0-9]+", "-", page).strip("-") or "map")
                shots, problems = sweep_page(page, args.out, name, nav_top)
                contact_sheets(shots, args.out, name)
                status = "FAIL" if problems else "ok"
                print(f"{status:4} {name} ({len(shots)} screens)")
                for p in problems:
                    print(f"     {p}")
                failures += [f"{name}: {p}" for p in problems]
    finally:
        adb("shell", "settings", "put", "system", "font_scale", "1.0")
        adb("shell", "wm", "density", "reset")

    with open(os.path.join(args.out, "report.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(failures) + "\n" if failures else "no failures\n")
    print(f"\n{len(failures)} problem(s); screenshots in {args.out}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
