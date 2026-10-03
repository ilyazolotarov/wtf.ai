"""Turn the pinned Liberty snapshot into an offline style.

Every URL points into the pack directory through the `{pack}` placeholder, which
the app replaces with the pack's `file://` URL at load time. Font stacks are
renamed to space-free slugs so glyph URLs never need percent-encoding.
"""

from __future__ import annotations

import copy
import re
from typing import Any

PACK = "{pack}"
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
        VECTOR_SOURCE: {"type": "vector", "url": f"pmtiles://{PACK}/map.pmtiles"},
    }
    style["layers"] = [l for l in style["layers"] if l.get("source") not in DROPPED_SOURCES]
    style["glyphs"] = f"{PACK}/fonts/{{fontstack}}/{{range}}.pbf"
    style["sprite"] = f"{PACK}/sprites/{SPRITE_NAME}"
    for layer in style["layers"]:
        fonts = _text_fonts(layer)
        if fonts is not None:
            layer["layout"]["text-font"] = [font_slug(f) for f in fonts]
    return style
