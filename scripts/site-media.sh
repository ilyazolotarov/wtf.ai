#!/usr/bin/env bash
# The website's screenshots (and the link preview cards made from them, scripts/site-share-card.py) and demo videos,
# made from the store set in store-assets/play/ (scripts/store-screenshots.py) so there is one copy of each in the repo, and
# the CarPlay stills from store-assets/carplay/ (scripts/app-store-screenshots.py --carplay). The site's are smaller:
# screenshots 720x1440, CarPlay 1280x480 JPEG, videos 540x1080 at 30 fps. Run by
# .github/workflows/pages.yml; locally before a preview.
#
#   bash scripts/site-media.sh            # screenshots and videos
#   bash scripts/site-media.sh screens    # screenshots only (seconds)
#   bash scripts/site-media.sh videos     # videos only (minutes)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
play="$root/store-assets/play"
carplay="$root/store-assets/carplay"
out="$root/site/assets"
what=${1:-all}

# A store set → the site's directory for it.
sets=("light:screens" "dark:screens/dark" "uk-light:screens/uk" "uk-dark:screens/uk/dark")
# A promo video → the site's.
videos=("promo:demo" "promo-dark:demo-dark" "promo-uk:demo-uk" "promo-uk-dark:demo-uk-dark")

if [ "$what" = all ] || [ "$what" = screens ]; then
  for pair in "${sets[@]}"; do
    src="$play/${pair%%:*}" dst="$out/${pair#*:}"
    mkdir -p "$dst"
    for png in "$src"/*.png; do
      ffmpeg -v error -y -i "$png" -vf "scale=720:1440:flags=lanczos" "$dst/$(basename "$png")"
    done
  done
  echo "screens: $out/screens"
  for pair in "${sets[@]}"; do
    src="$carplay/${pair%%:*}" dst="$out/carplay/${pair#*:screens}"
    mkdir -p "$dst"
    # JPEG: the wide map shots are ~130 KB each, a quarter of the PNG.
    for png in "$src"/*.png; do
      ffmpeg -v error -y -i "$png" -vf "scale=1280:480:flags=lanczos" -q:v 3 "$dst/$(basename "$png" .png).jpg"
    done
  done
  echo "carplay: $out/carplay"
  # The link previews (og:image) show a screenshot.
  python3 "$root/scripts/site-share-card.py" 2>/dev/null || python "$root/scripts/site-share-card.py"
fi

if [ "$what" = all ] || [ "$what" = videos ]; then
  for pair in "${videos[@]}"; do
    src="$play/${pair%%:*}.mp4" dst="$out/${pair#*:}.mp4"
    # The hero plays it by itself on every visit, in a phone frame 280 px wide: 540x1080 at CRF 27 is sharp there at
    # ~15 MB for the 2 min drive (720x1440 at CRF 20 was ~57 MB). CRF, not a bitrate: a fixed low bitrate blocks up the
    # dark map and the blurred cards over it; film tuning and aq-mode 3 keep the dark texture. The index up front
    # (faststart), so it starts playing before the whole file is in.
    ffmpeg -v error -y -i "$src" -vf "scale=540:1080:flags=lanczos,fps=30" -c:v libx264 -preset veryslow \
      -tune film -crf 27 -g 60 -x264-params aq-mode=3:aq-strength=1.2 -pix_fmt yuv420p -an -movflags +faststart "$dst"
    echo "video: $dst"
  done
fi
