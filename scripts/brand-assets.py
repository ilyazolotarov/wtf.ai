"""Render the "wtf." brand bitmaps (claude.ai/design "wtf.ai Redesign", options 2c–2f).

    python scripts/brand-assets.py

Needs Pillow and node_modules (for the Onest TTF). assets/images/icon.png is the
1024 px master exported from the design itself; everything else is drawn here so
it shares exact geometry with src/components/animated-splash.tsx. Prints that
geometry; paste it into SPLASH there if the layout constants change.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / "node_modules/@expo-google-fonts/onest/600SemiBold/Onest_600SemiBold.ttf"
OUT = ROOT / "assets/images"

BG_LIGHT, BG_DARK = "#F5F4F1", "#121211"
TEXT_LIGHT, TEXT_DARK = "#1D1C1A", "#F2F0EC"
ACCENT_LIGHT, ACCENT_DARK = "#4371B7", "#90BAF1"  # oklch(.55 .12 258) / (.78 .09 255)

# Splash wordmark, in points (2d/2e): 64 px Onest 600, -0.02em tracking,
# 10 px flex gap, 19 px puck sitting on the baseline.
FS, TRACK, GAP, PUCK = 64, -0.02, 10, 19
# First keyframe of wtfTight: a wide, faint uncertainty disc around the puck.
HALO = ((50, 0.35), (52, 0.06))  # (spread, alpha), bottom to top
CANVAS_W, CANVAS_H = 300, 160  # points; centred on the row's line box
SCALE = 3


def rgba(hex_color: str, alpha: float = 1.0) -> tuple[int, int, int, int]:
    h = hex_color.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), round(alpha * 255))


def run_width(font: ImageFont.FreeTypeFont, text: str, tracking: float) -> float:
    # CSS letter-spacing is added after every glyph, including the last one.
    return sum(font.getlength(ch) + tracking for ch in text)


def draw_run(draw, font, x, baseline, text, tracking, fill):
    for ch in text:
        draw.text((x, baseline), ch, font=font, fill=fill, anchor="ls")
        x += font.getlength(ch) + tracking


def blend(base: Image.Image, layer: Image.Image) -> Image.Image:
    return Image.alpha_composite(base, layer)


def disc(size, cx, cy, r, fill) -> Image.Image:
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse((cx - r, cy - r, cx + r, cy + r), fill=fill)
    return layer


def splash_layout():
    """Row geometry in points, relative to the canvas top-left."""
    font = ImageFont.truetype(str(FONT), FS)
    ascent, descent = font.getmetrics()
    tracking = TRACK * FS
    w_wtf = run_width(font, "wtf", tracking)
    w_ai = run_width(font, "ai", tracking)
    row_w = w_wtf + GAP + PUCK + GAP + w_ai
    # line-height: 1 → half-leading splits the gap between FS and the content area.
    row_top = (CANVAS_H - FS) / 2
    baseline = row_top + (FS - (ascent + descent)) / 2 + ascent
    x0 = (CANVAS_W - row_w) / 2
    return {
        "wtfX": x0,
        "aiX": x0 + w_wtf + GAP + PUCK + GAP,
        "baseline": baseline,
        "puckCx": x0 + w_wtf + GAP + PUCK / 2,
        "puckCy": baseline - PUCK / 2,
        "rowBottom": row_top + FS,
    }


def render_splash(text_color, accent, with_halo):
    g = splash_layout()
    s = SCALE
    size = (CANVAS_W * s, CANVAS_H * s)
    font = ImageFont.truetype(str(FONT), FS * s)
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    cx, cy = g["puckCx"] * s, g["puckCy"] * s
    if with_halo:
        for spread, alpha in HALO:
            img = blend(img, disc(size, cx, cy, (PUCK / 2 + spread) * s, rgba(accent, alpha)))
        img = blend(img, disc(size, cx, cy, PUCK / 2 * s, rgba(accent)))
    text = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(text)
    draw_run(d, font, g["wtfX"] * s, g["baseline"] * s, "wtf", TRACK * FS * s, rgba(text_color))
    draw_run(d, font, g["aiX"] * s, g["baseline"] * s, "ai", TRACK * FS * s, rgba(text_color))
    return blend(img, text)


def render_mark(size: int, text_color, accent, bg=None, content=1.0) -> Image.Image:
    """The 2f icon master ("wtf" + puck), scaled so it spans `content` of 256-px design units."""
    k = size / 256 * content
    fs, tracking, gap, puck, ring = 94 * k, -0.02 * 94 * k, 14 * k, 28 * k, 10 * k
    ss = 4  # supersample
    big = (size * ss, size * ss)
    font = ImageFont.truetype(str(FONT), round(fs * ss))
    ascent, descent = font.getmetrics()
    w_wtf = run_width(font, "wtf", tracking * ss)
    row_w = w_wtf + gap * ss + puck * ss
    x0 = (big[0] - row_w) / 2 - 2 * k * ss
    # Flex row of a line box (height = content area) and the puck, centred vertically.
    baseline = big[1] / 2 - (ascent + descent) / 2 + ascent
    img = Image.new("RGBA", big, rgba(bg) if bg else (0, 0, 0, 0))
    cx, cy = x0 + w_wtf + gap * ss + puck * ss / 2, baseline - puck * ss / 2
    img = blend(img, disc(big, cx, cy, (puck / 2 + ring) * ss, rgba(accent, 0.22)))
    img = blend(img, disc(big, cx, cy, puck / 2 * ss, rgba(accent)))
    d = ImageDraw.Draw(img)
    draw_run(d, font, x0, baseline, "wtf", tracking * ss, rgba(text_color))
    return img.resize((size, size), Image.LANCZOS)


def main():
    # Native splash: first animation frame. JS overlay: text only, rings are live views.
    render_splash(TEXT_LIGHT, ACCENT_LIGHT, True).save(OUT / "splash-light.png")
    render_splash(TEXT_DARK, ACCENT_DARK, True).save(OUT / "splash-dark.png")
    render_splash(TEXT_LIGHT, ACCENT_LIGHT, False).save(OUT / "splash-wordmark-light.png")
    render_splash(TEXT_DARK, ACCENT_DARK, False).save(OUT / "splash-wordmark-dark.png")

    # Android adaptive icon: keep the mark inside the 66 % safe zone.
    render_mark(512, TEXT_DARK, ACCENT_DARK, content=0.72).save(OUT / "android-icon-foreground.png")
    Image.new("RGBA", (512, 512), rgba(BG_DARK)).save(OUT / "android-icon-background.png")
    render_mark(432, "#FFFFFF", "#FFFFFF", content=0.72).save(OUT / "android-icon-monochrome.png")
    render_mark(48, TEXT_DARK, ACCENT_DARK, bg=BG_DARK, content=1.15).save(OUT / "favicon.png")

    g = splash_layout()
    print("SPLASH = {")
    print(f"  width: {CANVAS_W}, height: {CANVAS_H}, puck: {PUCK},")
    for key in ("puckCx", "puckCy", "rowBottom"):
        print(f"  {key}: {g[key]:.2f},")
    print("}")


if __name__ == "__main__":
    main()
