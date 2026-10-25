#!/usr/bin/env bash
# Opens the app on the Simulator's CarPlay screen the way a driver does: a tap on its icon (docs/CARPLAY-SPEC.md §6.2).
# Finds the icon's label with Vision's OCR in a screenshot of the CarPlay display, maps it onto the CarPlay window,
# clicks there, and waits for the app's "CarPlay scene connected" log line. Three tries: the Simulator's CarPlay
# window is known to ignore clicks at times.
# Usage: open-app.sh <simulator udid> <label> <out dir>
set -euo pipefail
UDID=$1
LABEL=$2
OUT=$3
HERE=$(cd "$(dirname "$0")" && pwd)
FIND_TEXT="${RUNNER_TEMP:-/tmp}/find-text"
swiftc -O "$HERE/find-text.swift" -o "$FIND_TEXT"

connected() {
  xcrun simctl spawn "$UDID" log show --last 3m --style compact \
    --predicate 'subsystem == "ai.wtf.navigator" AND category == "carplay"' 2>/dev/null |
    grep -q "CarPlay scene connected"
}

for TRY in 1 2 3; do
  SHOT="$OUT/carplay-home-$TRY.png"
  xcrun simctl io "$UDID" screenshot --display=external "$SHOT"
  if ! AT=$("$FIND_TEXT" "$SHOT" "$LABEL" 2> "$OUT/ocr-$TRY.txt"); then
    echo "Try $TRY: no \"$LABEL\" on the CarPlay screen (read: $(grep -c read "$OUT/ocr-$TRY.txt") texts, ocr-$TRY.txt)"
    sleep 5
    continue
  fi
  read -r PX PY <<< "$AT"
  read -r IW IH <<< "$(sips -g pixelWidth -g pixelHeight "$SHOT" | awk '/pixelWidth/ {w = $2} /pixelHeight/ {h = $2} END {print w, h}')"
  read -r WX WY WW WH <<< "$(osascript "$HERE/window-frame.applescript")"
  # The screen fills the window's width; what is left above it is the title bar.
  read -r X Y <<< "$(awk -v px="$PX" -v py="$PY" -v iw="$IW" -v ih="$IH" -v wx="$WX" -v wy="$WY" -v ww="$WW" -v wh="$WH" \
    'BEGIN { ch = ww * ih / iw; printf "%d %d\n", wx + px * ww / iw, wy + (wh - ch) + py * ch / ih }')"
  echo "Try $TRY: \"$LABEL\" at pixel $PX,$PY of ${IW}x$IH; window $WX,$WY ${WW}x$WH; click at $X,$Y"
  osascript -l JavaScript "$HERE/click.js" "$X" "$Y" ||
    osascript -e "tell application \"System Events\" to tell process \"Simulator\" to click at {$X, $Y}"
  sleep 8
  screencapture -x "$OUT/desktop-after-click-$TRY.png" || true
  if connected; then
    echo "The app's CarPlay scene connected (try $TRY)"
    exit 0
  fi
done
echo "::error::The app's CarPlay scene never connected"
exit 1
