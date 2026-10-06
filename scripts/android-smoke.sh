#!/usr/bin/env bash
# Emulator smoke test (docs/ANDROID-SPEC.md §4): install the APK, grant permissions, launch, and check that the app
# renders its first screen, receives GNSS fixes from the emulator, connects the simulated OBD adapter, starts the IMU
# and survives. Writes screenshots and logcat to $2. Runs inside the emulator job; also works locally against a running
# emulator: bash scripts/android-smoke.sh path/to/app.apk out-dir
set -u
APK="${1:?apk path}"
OUT="${2:-smoke-out}"
PKG=ai.wtf.navigator
mkdir -p "$OUT"

fail() {
  echo "SMOKE FAIL: $*" >&2
  adb logcat -d > "$OUT/logcat.txt" 2>&1
  adb exec-out screencap -p > "$OUT/fail.png" 2>/dev/null
  adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 && adb pull /sdcard/ui.xml "$OUT/fail-ui.xml" > /dev/null 2>&1
  exit 1
}

alive() { adb shell pidof "$PKG" > /dev/null; }

ui_dump() {
  adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1
  adb shell cat /sdcard/ui.xml 2> /dev/null
}

# Tap the first element whose text or content-desc contains $1. Returns 1 when there is none.
tap_text() {
  local xy
  xy=$(ui_dump | python3 -c '
import re, sys
needle = sys.argv[1]
xml = sys.stdin.read()
for m in re.finditer(r"<node [^>]*>", xml):
    node = m.group(0)
    text = re.search(r"\btext=\"([^\"]*)\"", node)
    desc = re.search(r"content-desc=\"([^\"]*)\"", node)
    label = (text.group(1) if text else "") + " " + (desc.group(1) if desc else "")
    b = re.search(r"bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"", node)
    if needle in label and b:
        x1, y1, x2, y2 = map(int, b.groups())
        print((x1 + x2) // 2, (y1 + y2) // 2)
        break
' "$1")
  [ -n "$xy" ] || return 1
  adb shell input tap $xy
}

# Wait up to $2 seconds for logcat to contain the pattern $1.
wait_log() {
  local i
  for i in $(seq 1 "$2"); do
    adb logcat -d 2> /dev/null | grep -qE "$1" && return 0
    sleep 1
  done
  return 1
}

# The first boot of a CI emulator is slow enough for system apps (the launcher) to ANR; their dialogs would cover
# our UI and break the UI dumps. Our own crashes and ANRs are still caught through logcat and pidof below.
adb shell settings put global hide_error_dialogs 1

adb logcat -c
adb install -r "$APK" || fail "install"

# What the first-run flow would ask for, granted up front so the test is about the app, not dialogs.
for p in ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION; do adb shell pm grant "$PKG" "android.permission.$p"; done
for p in BLUETOOTH_SCAN BLUETOOTH_CONNECT POST_NOTIFICATIONS; do adb shell pm grant "$PKG" "android.permission.$p" 2> /dev/null || true; done

adb shell am start -W -n "$PKG/.MainActivity" || fail "start"

# 1. First screen: the onboarding welcome title (fresh install).
seen=0
for i in $(seq 1 45); do
  sleep 2
  if ui_dump | grep -q 'Where the f'; then seen=1; break; fi
  alive || fail "app process died while starting"
done
adb exec-out screencap -p > "$OUT/1-first-screen.png"
[ "$seen" = 1 ] || fail "first screen text not found in 90 s"

# 2. GNSS: the emulator plays fixes through its gps provider into our LocationManager listener.
for i in 1 2 3 4 5; do
  adb emu geo fix 30.5234 50.4501 > /dev/null 2>&1
  sleep 1
done
wait_log "WtfSensorCapture: gnss fix" 30 || fail "no GNSS fix reached the native module (logcat: WtfSensorCapture)"
adb exec-out screencap -p > "$OUT/2-after-fix.png"

# 3. Simulated OBD adapter: open the vehicle screen by deep link and connect the emulated ELM327.
adb shell am start -a android.intent.action.VIEW -d "wtfai://vehicle" "$PKG" > /dev/null
sleep 5
adb exec-out screencap -p > "$OUT/3-vehicle.png"
tapped=0
for i in $(seq 1 15); do
  if tap_text "Emulator · ELM327 v1.5"; then tapped=1; break; fi
  sleep 2
done
[ "$tapped" = 1 ] || fail "simulated adapter not listed on the vehicle screen"
# Connected = the screen offers "Disconnect" (while connecting it says "Stop searching").
connected=0
for i in $(seq 1 30); do
  if ui_dump | grep -q 'text="Disconnect"'; then connected=1; break; fi
  sleep 2
done
adb exec-out screencap -p > "$OUT/4-connected.png"
[ "$connected" = 1 ] || fail "simulated adapter did not connect within 60 s"

# 4. The IMU comes up with the app and must deliver batches.
wait_log "WtfSensorCapture: startImu" 30 || fail "IMU never started"
wait_log "WtfSensorCapture: imu batch" 30 || fail "IMU started but delivered no batches"

# 5. Stay up for a while: crashes and ANRs often come a few seconds after the first frame.
sleep 20
alive || fail "app process died after start"
adb exec-out screencap -p > "$OUT/5-after-20s.png"

adb logcat -d > "$OUT/logcat.txt" 2>&1
if grep -E "FATAL EXCEPTION|ANR in $PKG|Process $PKG .* has died" "$OUT/logcat.txt" > /dev/null; then fail "crash or ANR in logcat"; fi
if grep -E "ReactNativeJS.*(Error|Unhandled)" "$OUT/logcat.txt" | grep . > /dev/null; then fail "JS error in logcat"; fi
echo "SMOKE OK"
