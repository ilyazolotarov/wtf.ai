"""The parked car drawn on the map (UI-SPEC §6.1): a car seen from straight above, shaded to read as 3D.

    python scripts/map-car.py                     # assets/images/map-car-{light,dark}@{1,2,3}x.png, -x6.png, -x12.png
    python scripts/map-car.py --preview out.png   # and a sheet of it on light and dark map ground

The windscreen and windows in the trusted dot's blue per theme (theme.ts `puck`); the body dark on light ground and
white on dark (as the lessons' car), banded as the dot (a white ring, a dark edge), with a soft shadow. Nose up, centred on the image, `LENGTH_PT` long at 1x: the map rotates and scales it.
"""

import argparse
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "images"

# Sizes in points (1x pixels). The car 56 pt long (puck-style.ts MAP_CAR: CAR_GLYPH's 28 pt at size 2), the image a
# little larger for the mirrors and the shadow.
LENGTH_PT = 56
HALF_LEN = LENGTH_PT / 2
HALF_WIDTH = 13.0
CANVAS_PT = (40, 68)
# Drawn this many times larger, then scaled down: smooth edges. The near images less, at least `SUPERSAMPLE_PX` pixels a
# point drawn.
SUPERSAMPLE = 8
SUPERSAMPLE_PX = 24
# The near images' densities, pixels per point (puck-style.ts MAP_CAR.near): drawn by the map once it is zoomed in so
# far that the screen's own image would be stretched. Written without an @ suffix, so the map takes a pixel a point.
NEAR = (6, 12)

GLASS = {"light": (0x0A, 0x84, 0xFF), "dark": (0x3D, 0x6B, 0xFF)}
# The paint per theme: the body's colour, how much it darkens to its sides, the sheen down its middle, and the colours
# of the mirrors, the creases and the roof's seam, the headlamps.
PAINT = {
    "light": {"body": (0x24, 0x27, 0x2C), "shade": 0.45, "sheen": 0.10, "mirror": (0x1C, 0x1E, 0x22), "line": (0x46, 0x4C, 0x55), "seam": (0x40, 0x45, 0x4E), "lamp": (0xDC, 0xE2, 0xEA)},
    "dark": {"body": (0xF3, 0xF5, 0xF8), "shade": 0.20, "sheen": 0.03, "mirror": (0xE6, 0xE8, 0xEC), "line": (0xB8, 0xBE, 0xC7), "seam": (0xC4, 0xC9, 0xD1), "lamp": (0x9A, 0xA4, 0xB2)},
}
# The dark edge: black round the white car, near black round the black one (puck-style.ts MAP_CAR.edge).
EDGE = {"light": (0x1C, 0x1F, 0x24), "dark": (0x00, 0x00, 0x00)}
# The white ring round the body and the dark edge outside it, points (puck-style.ts MAP_CAR).
RING_PT, EDGE_PT = 0.7, 0.6
WHEEL = (0x16, 0x18, 0x1B)


def half_width(y: float) -> float:
    """The body's half width at `y` (points from the middle, the nose at -HALF_LEN): a rounded box, the nose narrower."""
    t = min(1.0, abs(y) / HALF_LEN)
    taper = 1 - 0.08 * max(0.0, -y / HALF_LEN)
    return HALF_WIDTH * taper * max(0.0, 1 - t**3.2) ** (1 / 3.2)


def outline(inset: float = 0.0, steps: int = 160) -> list[tuple[float, float]]:
    """The body's outline, points, clockwise from the nose; `inset` in from it all round."""
    right = []
    for i in range(steps + 1):
        # Closer together at the nose and the tail, where the side turns across.
        y = -HALF_LEN + inset + (HALF_LEN - inset) * (1 - math.cos(math.pi * i / steps))
        right.append((max(0.0, half_width(y) - inset), y))
    return right + [(-x, y) for x, y in reversed(right[1:-1])]


def grown(pts, by: float) -> list[tuple[float, float]]:
    """The convex outline `pts` (clockwise on screen) grown `by` points all round, each point out along its normal."""
    p = np.array(pts, dtype=np.float64)
    t = np.roll(p, -1, axis=0) - np.roll(p, 1, axis=0)
    n = np.stack([t[:, 1], -t[:, 0]], axis=1) / np.hypot(t[:, 0], t[:, 1])[:, None]
    return [tuple(v) for v in p + by * n]


def band(y_from: float, y_to: float, frac_from: float, frac_to: float, bulge: float = 0.0, steps: int = 40) -> list[tuple[float, float]]:
    """A band across the car from `y_from` to `y_to`, `frac` of the body's half width at each end, its ends bowed by `bulge`."""

    def edge(y0: float, frac: float, sign: float) -> list[tuple[float, float]]:
        hw = half_width(y0) * frac
        return [(x, y0 + sign * bulge * (1 - (x / hw) ** 2)) for x in np.linspace(-hw, hw, steps)]

    front = edge(y_from, frac_from, -1)
    back = edge(y_to, frac_to, 1)
    return front + list(reversed(back))


class Canvas:
    """A drawing in points, `scale` pixels each, centred on the car."""

    def __init__(self, scale: float):
        self.scale = scale
        self.w = round(CANVAS_PT[0] * scale)
        self.h = round(CANVAS_PT[1] * scale)

    def px(self, pts):
        cx, cy = self.w / 2, self.h / 2
        return [(cx + x * self.scale, cy + y * self.scale) for x, y in pts]

    def mask(self, pts) -> Image.Image:
        m = Image.new("L", (self.w, self.h), 0)
        ImageDraw.Draw(m).polygon(self.px(pts), fill=255)
        return m

    def ellipse_mask(self, cx: float, cy: float, rx: float, ry: float) -> Image.Image:
        m = Image.new("L", (self.w, self.h), 0)
        (x0, y0), (x1, y1) = self.px([(cx - rx, cy - ry), (cx + rx, cy + ry)])
        ImageDraw.Draw(m).ellipse([x0, y0, x1, y1], fill=255)
        return m

    def coords(self):
        """Points of every pixel: x across the car, y along it."""
        ys, xs = np.mgrid[0 : self.h, 0 : self.w].astype(np.float32)
        return (xs - self.w / 2) / self.scale, (ys - self.h / 2) / self.scale


def paint(img: Image.Image, mask: Image.Image, rgb: np.ndarray | tuple, alpha: float = 1.0) -> None:
    """`rgb` (a colour, or an H×W×3 array) over `img` where `mask` is."""
    layer = np.empty((img.height, img.width, 4), dtype=np.uint8)
    layer[..., :3] = np.asarray(rgb, dtype=np.float32).clip(0, 255).astype(np.uint8) if not isinstance(rgb, tuple) else rgb
    layer[..., 3] = (np.asarray(mask, dtype=np.float32) * alpha).astype(np.uint8)
    img.alpha_composite(Image.fromarray(layer, "RGBA"))


def stroke(img: Image.Image, c: Canvas, pts, width_pt: float, rgb: tuple, alpha: float = 1.0) -> None:
    m = Image.new("L", (c.w, c.h), 0)
    ImageDraw.Draw(m).line(c.px(pts + pts[:1]), fill=255, width=max(1, round(width_pt * c.scale)), joint="curve")
    paint(img, m, rgb, alpha)


def car(theme: str, px_per_pt: float) -> Image.Image:
    """The car for `theme`, `px_per_pt` pixels per point (1, 2, 3, or a near image's), on a transparent image."""
    c = Canvas(px_per_pt * (SUPERSAMPLE if px_per_pt <= 3 else max(2, math.ceil(SUPERSAMPLE_PX / px_per_pt))))
    paint_ = PAINT[theme]
    body_rgb = np.array(paint_["body"], dtype=np.float32)
    img = Image.new("RGBA", (c.w, c.h), (0, 0, 0, 0))
    x, y = c.coords()
    body = outline()
    body_mask = c.mask(body)

    # A soft shadow under it, a little behind (light from the top of the screen).
    shadow = body_mask.filter(ImageFilter.GaussianBlur(2.2 * c.scale))
    shadow = Image.fromarray(np.roll(np.asarray(shadow), round(1.4 * c.scale), axis=0))
    paint(img, shadow, (0, 0, 0), 0.42)

    # Wheels: a sliver of tyre past the body at each axle.
    for axle in (-16.5, 17.5):
        hw = half_width(axle)
        for side in (-1, 1):
            paint(img, c.ellipse_mask(side * (hw - 0.7), axle, 1.2, 4.2), WHEEL)

    # Side mirrors, at the windscreen's foot, on stalks from the body.
    for side in (-1, 1):
        mx = side * (half_width(-9) + 0.9)
        m = c.ellipse_mask(mx, -8.4, 1.6, 1.15)
        paint(img, m, paint_["mirror"])
        edge = m.filter(ImageFilter.MaxFilter(3)).point(lambda v: 255 if v else 0)
        paint(img, Image.fromarray((np.asarray(edge, np.int16) - np.asarray(m, np.int16)).clip(0, 255).astype(np.uint8)), EDGE[theme], 0.9)

    # Banded as the dot: a white ring round the body and a dark edge outside it, so it stands out on light ground, dark
    # ground and the blue route alike. The outline grown by each, under the body painted next.
    paint(img, c.mask(grown(body, RING_PT + EDGE_PT)), EDGE[theme])
    paint(img, c.mask(grown(body, RING_PT)), (255, 255, 255))

    # The body, darkening towards its sides and ends as a rounded body does, a sheen down its middle.
    hw = np.vectorize(half_width)(y).astype(np.float32)
    across = np.where(hw > 0, np.abs(x) / np.maximum(hw, 1e-3), 1).clip(0, 1)
    along = (np.abs(y) / HALF_LEN).clip(0, 1)
    light = 1 - paint_["shade"] * across**2.6 - 0.06 * along**4 + 0.03 * (y < 0) * (1 - across)
    sheen = paint_["sheen"] * np.exp(-((x / 4.5) ** 2))[..., None]
    shade = body_rgb * light[..., None] * (1 - sheen) + 255 * sheen
    paint(img, body_mask, shade)
    inside = np.asarray(body_mask.filter(ImageFilter.MinFilter(max(3, round(0.6 * c.scale) | 1))), np.float32) / 255

    def on_body(m: Image.Image) -> Image.Image:
        """`m` kept within the body, clear of its edge."""
        return Image.fromarray((np.asarray(m, np.float32) * inside).astype(np.uint8))

    # The hood's two creases, faint.
    for side in (-1, 1):
        crease = [(side * 3.2, -24.5), (side * 4.6, -11.5)]
        m = Image.new("L", (c.w, c.h), 0)
        ImageDraw.Draw(m).line(c.px(crease), fill=255, width=max(1, round(0.45 * c.scale)))
        paint(img, m, paint_["line"], 0.6)

    glass = np.array(GLASS[theme], dtype=np.float32)
    deep = glass * 0.62
    pale = glass + (255 - glass) * 0.45

    def glass_fill(top: float, bottom: float) -> np.ndarray:
        """The glass colour from pale at `top` to deep at `bottom` (y, points), lighter in the middle."""
        t = ((y - top) / (bottom - top)).clip(0, 1)[..., None]
        mid = (1 - (x / HALF_WIDTH) ** 2).clip(0, 1)[..., None]
        return (pale * (1 - t) + deep * t) * (0.9 + 0.1 * mid)

    # Side windows along the roof, darker: the glass seen at a slant.
    for side in (-1, 1):
        strip = [(side * half_width(yy) * f, yy) for yy, f in ((-3.0, 0.72), (10.5, 0.71))]
        strip += [(side * half_width(yy) * f, yy) for yy, f in ((10.5, 0.84), (-3.0, 0.86))]
        paint(img, on_body(c.mask(strip)), tuple(int(v) for v in deep * 0.85))

    # Windscreen, raked: wide at the hood, narrower at the roof, bowed forward.
    screen = band(-10.5, -3.0, 0.86, 0.74, bulge=1.4)
    screen_mask = on_body(c.mask(screen))
    paint(img, screen_mask, glass_fill(-12, -3))
    # Its gloss: a soft diagonal streak.
    streak = np.exp(-(((x * 0.55 + (y + 7.5)) / 1.3) ** 2)) * 0.55
    paint(img, Image.fromarray((np.asarray(screen_mask, np.float32) * streak).astype(np.uint8)), (255, 255, 255))

    # Roof: a panel of the body's paint, brightest in the middle where the light falls.
    roof = band(-3.0, 10.5, 0.72, 0.71, bulge=0.6)
    roof_mask = c.mask(roof)
    r_light = 1.0 - 0.12 * (np.abs(x) / 9.5).clip(0, 1) ** 2 + 0.03 * np.exp(-(((y - 1) / 5) ** 2))
    r_sheen = paint_["sheen"] * 1.2 * np.exp(-((x / 3.5) ** 2) - ((y - 2) / 7) ** 2)[..., None]
    paint(img, roof_mask, (body_rgb * 1.02 * r_light[..., None]) * (1 - r_sheen) + 255 * r_sheen)
    stroke(img, c, roof, 0.35, paint_["seam"], 0.8)

    # Rear window.
    rear = band(10.5, 15.0, 0.71, 0.80, bulge=0.9)
    rear_mask = on_body(c.mask(rear))
    paint(img, rear_mask, glass_fill(10, 16))

    # Lights: headlamps at the nose's corners, tail lamps at the back.
    for side in (-1, 1):
        head = [(side * 4.0, -26.2), (side * 8.6, -24.2), (side * 9.4, -22.4), (side * 4.6, -24.4)]
        paint(img, on_body(c.mask(head)), paint_["lamp"])
        tail = [(side * 4.6, 26.4), (side * 9.2, 24.6), (side * 10.0, 22.8), (side * 5.0, 25.0)]
        paint(img, on_body(c.mask(tail)), (0xE3, 0x2D, 0x3A))

    return img.resize((round(CANVAS_PT[0] * px_per_pt), round(CANVAS_PT[1] * px_per_pt)), Image.LANCZOS)


def preview(path: Path) -> None:
    """The car on light and dark map ground, at its size and zoomed in, straight and turned."""
    density = 3
    tiles = []
    for theme, ground, road in (("light", (0xF2, 0xEF, 0xE9), (0xFF, 0xFF, 0xFF)), ("dark", (0x15, 0x17, 0x1B), (0x3A, 0x3F, 0x48))):
        tile = Image.new("RGBA", (300 * density, 220 * density), ground + (255,))
        d = ImageDraw.Draw(tile)
        d.line([(0, 150 * density), (300 * density, 40 * density)], fill=road, width=18 * density)
        for k, (scale, angle, at) in enumerate(((1.0, 0, (60, 110)), (1.0, -35, (150, 100)), (2.0, -70, (235, 105)))):
            icon = car(theme, density * scale).rotate(angle, resample=Image.BICUBIC, expand=True)
            tile.alpha_composite(icon, (at[0] * density - icon.width // 2, at[1] * density - icon.height // 2))
        tiles.append(tile)
    sheet = Image.new("RGBA", (tiles[0].width, sum(t.height for t in tiles)))
    y0 = 0
    for t in tiles:
        sheet.paste(t, (0, y0))
        y0 += t.height
    sheet.convert("RGB").save(path)
    print(f"preview: {path}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--preview", type=Path, help="also write a sheet of the car on map ground here")
    ap.add_argument("--no-assets", action="store_true", help="only the preview")
    a = ap.parse_args()
    if not a.no_assets:
        for theme in ("light", "dark"):
            for k in (1, 2, 3):
                name = f"map-car-{theme}@{k}x.png" if k > 1 else f"map-car-{theme}.png"
                car(theme, k).save(OUT / name, optimize=True)
                print(f"wrote {OUT / name}")
            for k in NEAR:
                name = f"map-car-{theme}-x{k}.png"
                car(theme, k).save(OUT / name, optimize=True)
                print(f"wrote {OUT / name}")
    if a.preview:
        preview(a.preview)


if __name__ == "__main__":
    main()
