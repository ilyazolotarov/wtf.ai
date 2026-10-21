# wtf.ai — Android Specification

The Android build for volunteer testers. Companion to [SPEC.md](SPEC.md); tester guide:
[ANDROID-TESTING.md](ANDROID-TESTING.md).

## 1. Goal and constraints

- Volunteer testers run the app on their own Android phones. We have **no Android device**: everything is checked
  on emulators, and testers' trip logs and Sentry reports are the field data.
- Same product, same TypeScript core (`src/nav`, `src/obd`, `src/triplog` untouched). Android means: Kotlin sides of
  the Expo modules with the same JS contract as the Swift ones, a few UI fallbacks, a foreground service, and CI.
- No Play Store account yet. Distribution: a **signed release APK** from GitHub Actions, downloaded from the website
  and updated from the app (UPDATES-SPEC §3). The store path: STORE-REVIEW.md.
- Android builds and runs on the Windows PC (Android SDK + emulator), so the native iteration loop is local and CI is
  the safety net.

## 2. What Android changes (decisions)

| Topic | Decision |
| --- | --- |
| Adapter transports | **BLE** (`BluetoothGatt`) and **Classic Bluetooth SPP** (RFCOMM, UUID `00001101-…`). No MFi: the OBDLink MX+ and cheap ELM327 clones work directly. The JS transport kind `spp`; the ELM327 layer is unchanged. |
| Position | Platform `LocationManager`, **no Google Play services**: the `gps` provider = satellite fixes (with speed), `network` = coarse Wi-Fi/cell fixes. |
| IMU | `SensorManager`: `TYPE_GYROSCOPE`, `TYPE_GRAVITY`, `TYPE_LINEAR_ACCELERATION`, `TYPE_GAME_ROTATION_VECTOR` (no magnetometer in the frame), raw `TYPE_MAGNETIC_FIELD` for logging. 100 Hz, batched like iOS. Phones without gravity / linear-acceleration sensors derive them from the accelerometer. |
| Clock | `SystemClock.elapsedRealtimeNanos()` in µs: sensor events and `Location.elapsedRealtimeNanos` use it natively. |
| Conventions | Kotlin normalizes to the iOS conventions the TS assumes: gravity is the **true gravity direction** (Android's `TYPE_GRAVITY` points up, so it is negated) and user acceleration is CoreMotion's (`TYPE_LINEAR_ACCELERATION` negated); m/s², rad/s, course in radians, invalid fields omitted. A parity test pins this (§5). |
| Background | One **foreground service** (types `location` + `connectedDevice`) started with a trip, with a persistent notification ("wtf.ai is recording your trip") and a partial wake lock. Without it Android stops sensors and Bluetooth polling with the screen off. Location "all the time" only for the opt-in that keeps the position without opening the app (VEHICLE-LINK-SPEC §11), asked for there and nowhere else. |
| Permissions | `ACCESS_FINE_LOCATION`, `BLUETOOTH_SCAN` (`neverForLocation`) + `BLUETOOTH_CONNECT` (12+; legacy `BLUETOOTH`/`BLUETOOTH_ADMIN` ≤ 11), `POST_NOTIFICATIONS` (13+), `FOREGROUND_SERVICE(_LOCATION, _CONNECTED_DEVICE)`, `WAKE_LOCK`, `HIGH_SAMPLING_RATE_SENSORS`, `ACCESS_BACKGROUND_LOCATION` (asked for only by the wake's opt-in), the three companion permissions for the wake (`REQUEST_OBSERVE_COMPANION_DEVICE_PRESENCE`, `REQUEST_COMPANION_START_FOREGROUND_SERVICES_FROM_BACKGROUND`, `REQUEST_COMPANION_RUN_IN_BACKGROUND`), `REQUEST_INSTALL_PACKAGES` (sideloaded builds only). All from config plugins (`modules/vehicle-link/app.plugin.js`, `app.json`), never by hand in `android/`. The Bluetooth dialog is shown at most once per process, and never on devices without an adapter. |
| Pairing | Classic adapters must be bonded (PIN 1234/0000). The Vehicle screen lists bonded devices plus discovery results; tapping an unbonded one calls `createBond()`. |
| Icons | `expo-symbols` renders Material Symbols on Android; the `Icon` map keys are Material names with an `android` entry each. |
| Blur | Panels use `dimezisBlurViewSdk31Plus` with `blurReductionFactor` 1, and on Android 12+ the map renders into a `TextureView` (the default `GLSurfaceView` isn't part of the view the blur samples). Android 10–11 get no blur and `GlassFill` uses a dense tint (`panelSolid`, 86 %). |
| Offline maps | MapLibre RN offline packs. Debug builds allow cleartext traffic for a LAN map source; release does not. |
| Update notification | `modules/app-notice`: a local notification when the app's own check finds a new build (UPDATES-SPEC §5.2). |
| Vendor battery killers | Xiaomi, Samsung, Huawei kill foreground services. The tester guide names the per-vendor steps; the app doesn't open the exemption screen itself. |
| `minSdk` | 29 (Android 10): where foreground service types start; Android 8–9 are a few percent of phones and untestable here. |

## 3. Implementation

- `modules/sensor-capture`, `modules/vehicle-link`, `modules/audio-output` and `modules/app-notice` have Kotlin sides
  with the same JS contracts as the Swift ones.
- Mapping and batching live in plain Kotlin (`modules/*/android/**/logic/`, no `android.*` imports): GNSS and motion
  payloads, the IMU batcher, and the link logic (UUID normalizing, UART selection, chunking, `>` framing) ported from
  the Swift with its test vectors. JUnit tests in `native-tests-android/` (plain JVM).
- **Vehicle link:** BLE (`connectGatt(TRANSPORT_LE)`, MTU request, notifications, write queue) and Classic SPP
  (bonding, the secure socket, then the insecure and channel-1 fallbacks clones need). Classic devices get the id
  `spp:<MAC>`. `getMfiAccessories` returns `[]`.
- **Trip service:** the foreground service runs while a trip records.
- **Wake:** a companion device the driver picked once (the car's Bluetooth, a BLE adapter) starts the app and its
  JS without a screen, and a trip records in the background; a process that dies mid-drive with the device present
  is started again (VEHICLE-LINK-SPEC §11). Android 12+.

## 4. CI/CD: nothing broken reaches a tester

| Job | What it proves | When |
| --- | --- | --- |
| `checks` | lint, tsc, Jest | per the CI plan ([CI.md](CI.md)) |
| `native-logic-android` | the Kotlin logic tests on a plain JVM | Android-native changes |
| `build-android` | `expo prebuild --platform android`, `./gradlew assembleRelease`; the signed APK | `main`, Android-native changes, `[build android]` |

- **Emulator smoke test** (`scripts/android-smoke.sh`, local only: too slow for CI): installs the APK, grants
  permissions, launches, and checks that the app renders its first screen, receives GNSS fixes from the emulator,
  connects the emulated OBD adapter (`wtfai://vehicle?emulators=1`), starts the IMU and survives; writes screenshots
  and logcat. `bash scripts/android-smoke.sh path/to/app.apk out-dir`.
- **Local build and emulator** (Windows, no Android Studio): the SDK command-line tools with `platform-tools`,
  `emulator`, `platforms;android-36`, `build-tools;36.0.0`, `ndk;27.1.12297006`, `cmake;3.30.5` and an x86_64 Google
  APIs system image, and a JDK 17 for Gradle. `npx expo prebuild --platform android --no-install` (it rewrites
  `package.json`'s `android`/`ios` scripts: restore them), then `cd android && ./gradlew assembleDebug
  -PreactNativeArchitectures=x86_64`. The debug dev client asks Metro for a manifest signed with the OTA key, which
  only the owner holds: for a local build drop the two `expo.modules.updates.CODE_SIGNING_*` entries from the
  generated `AndroidManifest.xml`. Test with a 3-button navigation bar (`cmd overlay enable
  com.android.internal.systemui.navbar.threebutton`): most phones have one. The large-text sweep (UI-SPEC §8) runs
  against this emulator.
- **Signing:** a stable keystore (`ANDROID_KEYSTORE_BASE64`, `_PASSWORD`, `_KEY_ALIAS`, `_KEY_PASSWORD`;
  `bash scripts/android-keystore.sh` creates the key outside the repo and prints the `gh secret set` commands), so
  APK updates install over the previous one and keep app data. The secrets belong to the GitHub environment
  `android-release`, which only `main` may use: whoever holds the key can ship an APK that installs over the testers'
  app, and a workflow edited on a branch could leak a repository secret. Branch APKs are signed with a debug key: a
  tester must uninstall `main`'s APK to try one.
- **What CI cannot prove:** real adapters and OEM battery killers. Testers' trip logs are replayed with
  `replay:parity` and `replay:regress --testers`.

### 4.1 Logging and metrics (Sentry; `src/services/telemetry.ts`, `src/config/sentry.ts`)

We cannot watch testers' phones, so the app reports what it can through Sentry (EU region, scrubbing in
`sentry-scrub.ts`, logs on, breadcrumbs from the link and recorder). Same privacy rule as SPEC §2: no coordinates, no
VINs, no adapter serials; the scrubber is the single gate.

- **Tags on every event:** `os`, `os_version`, `sdk_int`, `device_manufacturer`, `device_model`, `build_sha`,
  `js_source` (built in or an OTA update), `install_id` (the random "Support code" in Settings, so a tester's reports
  can be found).
- **Metrics** (numbers only): connect time and failures by reason (`bond`, `gatt-133`, `socket-secure-failed`,
  `timeout`), poll rate and latency per transport and adapter model (the catalog name, never the serial), GNSS and
  IMU rates, the satellite share, the longest IMU gap while recording (the direct check that Android keeps sensors
  alive with the screen off).
- **Logs:** the vehicle-link events and recorder messages, permission results, Bluetooth/location state changes,
  service start/stop, a GATT dump summary for unknown adapters (service UUIDs only).
- **Environment:** `ci` for emulator runs (the smoke test), else development / production, so testers' phones never
  mix with CI.
- Not in Sentry: the trip logs themselves, which remain the source for navigation accuracy.
- Not built: native `onNativeError` events from Kotlin bridge entry points, trip size/duration metrics, alert rules
  (set up in the Sentry UI).

## 5. Parity checks

- **Sign conventions:** a Kotlin test feeds Android-convention sensor values for a known motion and asserts the same
  `motion` row the Swift logic yields for iOS values.
- **Payload parity:** JSON fixtures of `onGnss` / `onImuBatch` payloads shared between the Swift tests, the Kotlin
  tests and a Jest test of the TS consumers.
- **Replay on Android logs:** testers' logs go through the replay unchanged; a per-phone tweak the navigator needs
  lives in calibration, not in a fork.

## 6. Status

Built, checked on the emulator, and road-tested by testers: a Classic no-name adapter on a K-line car gave the speed
every poll and navigated a route with no GNSS fix (VEHICLE-LINK-SPEC §13). The tester guide's battery-killer steps
are the only mitigation for OEM background limits.

## 7. Open items

- BLE adapters on real Android phones (only Classic SPP is road-tested).
- The companion wake on a real phone: the dialog listing the car's Bluetooth, the process start, a trip recorded
  without opening the app, and whether vendor battery killers let it run.
- Testers' phone models, once known, refine the sensor matrix (gyro noise, GNSS lag per model) through the logs.
- Google Play: STORE-REVIEW.md.
