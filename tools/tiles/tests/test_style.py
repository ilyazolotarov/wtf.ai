import json
from pathlib import Path

from tiles.style import COMMON, TILES, collect_fonts, font_slug, offline_style

LIBERTY = json.loads((Path(__file__).parent.parent / "style" / "liberty.json").read_text(encoding="utf-8"))


def test_font_slug():
    assert font_slug("Noto Sans Regular") == "noto-sans-regular"


def test_offline_style_has_no_network_urls():
    style = offline_style(LIBERTY, "test")
    text = json.dumps(style)
    assert "http://" not in text and "https://" not in text
    assert style["sources"] == {"openmaptiles": {"type": "vector", "url": f"pmtiles://{TILES}"}}
    assert style["glyphs"] == f"{COMMON}/fonts/{{fontstack}}/{{range}}.pbf"
    assert style["sprite"] == f"{COMMON}/sprites/ofm"


def test_offline_style_layers_use_existing_sources_and_slug_fonts():
    style = offline_style(LIBERTY, "test")
    assert all(l.get("source", "openmaptiles") in style["sources"] for l in style["layers"])
    slugs = {font_slug(f) for f in collect_fonts(LIBERTY)}
    used = {f for l in style["layers"] for f in l.get("layout", {}).get("text-font", [])}
    assert used and used <= slugs


def test_snapshot_untouched():
    offline_style(LIBERTY, "test")
    assert "ne2_shaded" in LIBERTY["sources"]
