"""The car screens' icons, from the Material Symbols font the app draws its icons with.

The car's screen gets the same turn arrows as the phone's route banner (MANEUVER_ICON in
src/components/route/guidance-text.ts) and a few icons for its buttons and lists. Android Auto and CarPlay take them as
resources (docs/ANDROID-AUTO-SPEC.md §4, docs/CARPLAY-SPEC.md §4), so they are drawn here once: for Android Auto as
vector drawables, white, 24 dp, one file each in modules/android-auto/android/src/main/res/drawable/; for CarPlay as
SVG template images, 24 pt, in the asset catalog modules/car-play/ios/CarIcons.xcassets. Run again after changing the
lists:

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
IOS_OUT = ROOT / "modules/car-play/ios/CarIcons.xcassets"

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
    "search",
    "add",
    "remove",
    "my_location",
    "map",
]
# CarPlay's own: its map's pan button (Android Auto's is the host's).
IOS_ICONS = ICONS + ["drag_pan"]

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


SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 {em} {em}">
<!-- Material Symbols "{name}" (Apache License 2.0), drawn by scripts/car-icons.py: don't edit by hand. -->
<path d="{path}"/>
</svg>
"""

# A template image: CarPlay tints it for the car's day or night. Kept as a vector, drawn at the size it is shown.
IMAGESET = """{{
  "images" : [
    {{
      "filename" : "car_{name}.svg",
      "idiom" : "universal"
    }}
  ],
  "info" : {{
    "author" : "xcode",
    "version" : 1
  }},
  "properties" : {{
    "preserves-vector-representation" : true,
    "template-rendering-intent" : "template"
  }}
}}
"""

CATALOG = """{
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
"""


def main() -> int:
    font = TTFont(FONT)
    em = font["head"].unitsPerEm
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    codepoints = json.loads(CODEPOINTS.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    def path(name: str) -> str:
        pen = SVGPathPen(glyphs)
        # The font's y goes up from the baseline; a drawable's (and an SVG's) goes down from the top of the em.
        glyphs[cmap[codepoints[name]]].draw(TransformPen(pen, (1, 0, 0, -1, 0, em)))
        return pen.getCommands()

    for name in ICONS:
        (OUT / f"car_{name}.xml").write_bytes(TEMPLATE.format(name=name, em=em, path=path(name)).encode("utf-8"))
    print(f"{len(ICONS)} icons in {OUT.relative_to(ROOT)}")
    IOS_OUT.mkdir(parents=True, exist_ok=True)
    (IOS_OUT / "Contents.json").write_bytes(CATALOG.encode("utf-8"))
    for name in IOS_ICONS:
        imageset = IOS_OUT / f"car_{name}.imageset"
        imageset.mkdir(exist_ok=True)
        (imageset / f"car_{name}.svg").write_bytes(SVG.format(name=name, em=em, path=path(name)).encode("utf-8"))
        (imageset / "Contents.json").write_bytes(IMAGESET.format(name=name).encode("utf-8"))
    print(f"{len(IOS_ICONS)} icons in {IOS_OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
