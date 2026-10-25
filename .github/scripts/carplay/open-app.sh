#!/usr/bin/env bash
# Opens the app on the Simulator's CarPlay screen the way a driver does: a tap on its icon (docs/CARPLAY-SPEC.md §6.2).
# Reads the icon's label with Vision's OCR in a screenshot of the desktop, inside the CarPlay window (the window draws
# a frame around the car's screen, so the screen's own screenshot doesn't map onto it), and clicks there. Opened: the
# app logs its CarPlay scene becoming active after the click, and the car's screen is no longer the home screen.
# CarPlay connects the scene in the background as soon as its display comes on, so "connected" alone proves nothing.
# Three tries: the Simulator's CarPlay window is known to ignore clicks at times.
# Usage: open-app.sh <simulator udid> <label> <out dir>
set -euo pipefail
UDID=$1
LABEL=$2
OUT=$3
HERE=$(cd "$(dirname "$0")" && pwd)
FIND_TEXT="${RUNNER_TEMP:-/tmp}/find-text"
swiftc -O "$HERE/find-text.swift" -o "$FIND_TEXT"

active_since() {
  xcrun simctl spawn "$UDID" log show --start "$1" --style compact \
    --predicate 'subsystem == "ai.wtf.navigator" AND category == "carplay"' 2>/dev/null |
    grep -q "CarPlay scene active"
}

# Screen points per pixel of a desktop screenshot (2 on a Retina display, else 1).
DESKTOP_W=$(osascript -e 'tell application "Finder" to get bounds of window of desktop' | awk -F', *' '{print $3}')

for TRY in 1 2 3; do
  read -r WX WY WW WH <<< "$(osascript "$HERE/window-frame.applescript")"
  sleep 1
  DESK="$OUT/desktop-before-click-$TRY.png"
  screencapture -x "$DESK"
  IW=$(sips -g pixelWidth "$DESK" | awk '/pixelWidth/ {print $2}')
  # The rightmost text with the label inside the CarPlay window: the app's icon, not its small copy in the side dock.
  if ! AT=$("$FIND_TEXT" "$DESK" "$LABEL" 2> "$OUT/ocr-desktop-$TRY.txt" |
    awk -v s="$DESKTOP_W" -v iw="$IW" -v wx="$WX" -v wy="$WY" -v ww="$WW" -v wh="$WH" '
      { x = $1 * s / iw; y = $2 * s / iw
        if (x > wx && x < wx + ww && y > wy && y < wy + wh && x > bx) { bx = x; by = y } }
      END { if (bx) printf "%d %d\n", bx, by; else exit 1 }'); then
    echo "Try $TRY: no \"$LABEL\" in the CarPlay window ($WX,$WY ${WW}x$WH; ocr-desktop-$TRY.txt)"
    sleep 5
    continue
  fi
  read -r X Y <<< "$AT"
  SINCE=$(date '+%Y-%m-%d %H:%M:%S')
  echo "Try $TRY: \"$LABEL\" at $X,$Y in the CarPlay window ($WX,$WY ${WW}x$WH); clicking"
  osascript -l JavaScript "$HERE/click.js" "$X" "$Y" ||
    osascript -e "tell application \"System Events\" to tell process \"Simulator\" to click at {$X, $Y}"
  sleep 8
  SHOT="$OUT/carplay-after-click-$TRY.png"
  xcrun simctl io "$UDID" screenshot --display=external "$SHOT"
  screencapture -x "$OUT/desktop-after-click-$TRY.png" || true
  if "$FIND_TEXT" "$SHOT" Settings > /dev/null 2>&1; then
    echo "Try $TRY: still the CarPlay home screen"
  elif active_since "$SINCE"; then
    echo "The app is open on the CarPlay screen (try $TRY)"
    exit 0
  else
    echo "Try $TRY: the home screen is gone, but the app's CarPlay scene didn't become active"
  fi
done
echo "::error::The app never opened on the CarPlay screen"
exit 1
