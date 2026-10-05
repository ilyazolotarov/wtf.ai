#!/usr/bin/env bash
# Emulator smoke test (docs/ANDROID-SPEC.md §4): install the APK, grant permissions, launch, and check that the app
# renders its first screen and survives. Writes screenshots and logcat to $2. Runs inside the emulator job; also works
# locally against a running emulator: bash scripts/android-smoke.sh path/to/app.apk out-dir
set -u
APK="${1:?apk path}"
OUT="${2:-smoke-out}"
PKG=ai.wtf.navigator
mkdir -p "$OUT"
fail() {
  echo "SMOKE FAIL: $*" >&2
  adb logcat -d > "$OUT/logcat.txt" 2>&1
  adb exec-out screencap -p > "$OUT/fail.png" 2>/dev/null
  exit 1
}

adb logcat -c
adb install -r "$APK" || fail "install"

# What the first-run flow would ask for, granted up front so the test is about the app, not dialogs.
for p in ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION; do adb shell pm grant "$PKG" "android.permission.$p"; done
for p in BLUETOOTH_SCAN BLUETOOTH_CONNECT POST_NOTIFICATIONS; do adb shell pm grant "$PKG" "android.permission.$p" 2>/dev/null || true; done

adb shell am start -W -n "$PKG/.MainActivity" || fail "start"

# Wait for the first screen: the onboarding welcome title (fresh install).
seen=0
for i in $(seq 1 45); do
  sleep 2
  adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1
  if adb shell cat /sdcard/ui.xml 2> /dev/null | grep -q 'Where the f'; then seen=1; break; fi
  adb shell pidof "$PKG" > /dev/null || fail "app process died while starting"
done
adb exec-out screencap -p > "$OUT/first-screen.png"
[ "$seen" = 1 ] || fail "first screen text not found in 90 s"

# Stay up for a while: crashes and ANRs often come a few seconds after the first frame.
sleep 20
adb shell pidof "$PKG" > /dev/null || fail "app process died after start"
adb exec-out screencap -p > "$OUT/after-20s.png"

adb logcat -d > "$OUT/logcat.txt" 2>&1
if grep -E "FATAL EXCEPTION|ANR in $PKG|Process $PKG .* has died" "$OUT/logcat.txt" > /dev/null; then fail "crash or ANR in logcat"; fi
if grep -E "ReactNativeJS.*(Error|Unhandled)" "$OUT/logcat.txt" | grep . > /dev/null; then fail "JS error in logcat"; fi
echo "SMOKE OK"
