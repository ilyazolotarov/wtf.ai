"""The website's link previews (og:image): a 1200x630 card per language, from the site's screenshots, so a link to
wtf-ai.uk in a chat or a post shows the app instead of a bare icon. Run by scripts/site-media.sh after the screenshots.

    python scripts/site-share-card.py

Needs Pillow. The font is the site's (Onest), fetched once from the Google Fonts repository into a cache.
"""

import os
import sys
import tempfile
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "site" / "assets"
FONT_URL = "https://github.com/google/fonts/raw/main/ofl/onest/Onest%5Bwght%5D.ttf"

# The landing page's dark theme (site/assets/landing.css).
BG, CARD, TEXT, TEXT2, ACCENT = "#121211", "#232220", "#F2F0EC", "#A6A29B", "#90BAF1"
W, H = 1200, 630

CARDS = {
    "share.png": ("screens/dark/01-guidance.png",
                  "Offline car navigation to help you stay on track when GPS lets you down."),
    "share-uk.png": ("screens/uk/dark/01-guidance.png",
                     "Офлайн-навігатор для авто, який допомагає не загубитися, коли GPS підводить."),
}


def font_file() -> Path:
    path = Path(os.environ.get("RUNNER_TEMP") or tempfile.gettempdir()) / "wtf-site-onest.ttf"
    if not path.exists():
        urllib.request.urlretrieve(FONT_URL, path)
    return path


def font(size: int, weight: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(font_file()), size)
    f.set_variation_by_axes([weight])
    return f


def wrap(draw: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, width: int) -> list[str]:
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if line and draw.textlength(trial, font=f) > width:
            lines.append(line)
            line = word
        else:
            line = trial
    return lines + [line]


def card(screen: Path, lead: str, out: Path) -> None:
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    x, text_w = 72, 640

    # The brand, as in the page's header (the icon is the same word, so not twice).
    draw.text((x, 108), "wtf.ai", font=font(40, 700), fill=ACCENT, anchor="lm")

    # The page's headline and lead.
    y = 196
    for line in ["Where the f*", "am I?"]:
        draw.text((x, y), line, font=font(84, 700), fill=TEXT)
        y += 92
    y += 28
    f = font(30, 400)
    for line in wrap(draw, lead, f, text_w):
        draw.text((x, y), line, font=f, fill=TEXT2)
        y += 42

    # The phone, as in the hero: a frame around the screenshot, running off the bottom edge.
    pw, border, radius = 300, 10, 40
    px, py = W - 72 - pw - 2 * border, 64
    ph = pw * 2
    draw.rounded_rectangle((px, py, px + pw + 2 * border, py + ph + 2 * border), radius=radius, fill=TEXT)
    shot = Image.open(screen).convert("RGB").resize((pw, ph), Image.LANCZOS)
    mask = Image.new("L", shot.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, pw - 1, ph - 1), radius=radius - border, fill=255)
    screen_bg = Image.new("RGB", shot.size, CARD)
    screen_bg.paste(shot, (0, 0), mask)
    img.paste(screen_bg, (px + border, py + border), mask)

    img.save(out, optimize=True)
    print(f"share card: {out}")


def main() -> int:
    for name, (screen, lead) in CARDS.items():
        card(ASSETS / screen, lead, ASSETS / name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
