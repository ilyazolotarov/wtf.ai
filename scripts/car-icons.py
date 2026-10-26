"""Android Auto's icons as vector drawables, from the Material Symbols font the app draws its icons with.

The car's screen gets the same turn arrows as the phone's route banner (MANEUVER_ICON in
src/components/route/guidance-text.ts) and a few icons for its buttons and lists. Android Auto takes them as
resources (docs/ANDROID-AUTO-SPEC.md §4), so they are drawn here once: white, 24 dp, one file each in
modules/android-auto/android/src/main/res/drawable/. Run again after changing the list:

    python scripts/car-icons.py

Needs fontTools (`pip install fonttools`) and node_modules (the font comes from @expo-google-fonts/material-symbols,
the codepoints from expo-symbols, as on the phone).
"""

import json
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / "node_modules/@expo-google-fonts/material-symbols/400Regular/MaterialSymbols_400Regular.ttf"
CODEPOINTS = ROOT / "node_modules/expo-symbols/src/android/symbols.json"
OUT = ROOT / "modules/android-auto/android/src/main/res/drawable"

# The maneuvers' icons (MANEUVER_ICON), then the car screen's own.
ICONS = [
    "straight",
    "turn_slight_left",
    "turn_slight_right",
    "turn_left",
    "turn_right",
    "turn_sharp_left",
    "turn_sharp_right",
    "fork_left",
    "fork_right",
    "u_turn_left",
    "roundabout_left",
    "flag",
    "close",
    "location_on",
    "location_off",
    "alt_route",
    "navigation",
    "home",
    "work",
    "star",
    "history",
    "volume_up",
    "volume_off",
]

TEMPLATE = """<?xml version="1.0" encoding="utf-8"?>
<!-- Material Symbols "{name}" (Apache License 2.0), drawn by scripts/car-icons.py: don't edit by hand. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="{em}"
    android:viewportHeight="{em}">
  <path
      android:fillColor="@android:color/white"
      android:pathData="{path}" />
</vector>
"""


def main() -> int:
    font = TTFont(FONT)
    em = font["head"].unitsPerEm
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    codepoints = json.loads(CODEPOINTS.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    for name in ICONS:
        glyph = cmap[codepoints[name]]
        pen = SVGPathPen(glyphs)
        # The font's y goes up from the baseline; a drawable's goes down from the top of the em.
        glyphs[glyph].draw(TransformPen(pen, (1, 0, 0, -1, 0, em)))
        path = pen.getCommands()
        (OUT / f"car_{name}.xml").write_bytes(TEMPLATE.format(name=name, em=em, path=path).encode("utf-8"))
    print(f"{len(ICONS)} icons in {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
