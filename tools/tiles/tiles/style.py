"""Turn the pinned Liberty snapshot into an offline style.

URLs use two placeholders the app replaces at load time: `{common}` (the directory holding
the shared style, sprites and glyphs) and `{tiles}` (the active region's .pmtiles file URL). Font stacks are
renamed to space-free slugs so glyph URLs never need percent-encoding.
"""

from __future__ import annotations

import copy
import re
from typing import Any

COMMON = "{common}"
TILES = "{tiles}"
VECTOR_SOURCE = "openmaptiles"
DROPPED_SOURCES = {"ne2_shaded"}  # low-zoom shaded relief raster, online only
SPRITE_NAME = "ofm"


def font_slug(font: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", font.lower()).strip("-")


def _text_fonts(layer: dict[str, Any]) -> list[str] | None:
    fonts = layer.get("layout", {}).get("text-font")
    if fonts is None:
        return None
    if not (isinstance(fonts, list) and all(isinstance(f, str) for f in fonts)):
        raise ValueError(f"layer {layer['id']}: text-font must be a plain list of names, got {fonts!r}")
    return fonts


def collect_fonts(style: dict[str, Any]) -> list[str]:
    return sorted({f for layer in style["layers"] for f in _text_fonts(layer) or []})


def offline_style(liberty: dict[str, Any], name: str) -> dict[str, Any]:
    style = copy.deepcopy(liberty)
    style["name"] = name
    style["sources"] = {
        VECTOR_SOURCE: {"type": "vector", "url": f"pmtiles://{TILES}"},
    }
    style["layers"] = [l for l in style["layers"] if l.get("source") not in DROPPED_SOURCES]
    style["glyphs"] = f"{COMMON}/fonts/{{fontstack}}/{{range}}.pbf"
    style["sprite"] = f"{COMMON}/sprites/{SPRITE_NAME}"
    for layer in style["layers"]:
        fonts = _text_fonts(layer)
        if fonts is not None:
            layer["layout"]["text-font"] = [font_slug(f) for f in fonts]
    return style
