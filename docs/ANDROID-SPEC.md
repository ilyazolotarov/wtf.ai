# wtf.ai — Android Specification

Status: v2 (2026-10-10). The Android build for volunteer testers. Companion to [SPEC.md](SPEC.md); tester guide:
[ANDROID-TESTING.md](ANDROID-TESTING.md).

## 1. Goal and constraints

- Volunteer testers run the app on their own Android phones. We have **no Android device**, so nothing may reach them
  that CI has not installed and exercised on an emulator.
- Same product, same TypeScript core (`src/nav`, `src/obd`, `src/triplog` stay untouched). Android means: two Kotlin
  Expo modules with the same JS contract as the Swift ones, a few UI fallbacks, a foreground service, and CI.
- No EAS, no Play Store account. Distribution: a **signed release APK** from GitHub Actions (artifact, optionally sent
  to Telegram like the IPA). Testers enable "install unknown apps".
- Unlike iOS, **Android can be built and run on a Windows PC** (Android SDK + emulator, no Mac needed), so the native
  iteration loop is local, and CI is the safety net.

## 2. What Android changes (decisions)

| Topic | Decision |
| --- | --- |
| Adapter transports | **BLE** (`BluetoothGatt`) and **Classic Bluetooth SPP** (RFCOMM, UUID `00001101-…`). No MFi: Android needs no authorization, so the OBDLink MX+ and most cheap ELM327 clones (Classic) work directly. The JS transport kind `mfi` gets a sibling `spp`; the ELM327 layer is unchanged. |
| Position | Platform `LocationManager`, **no Google Play services dependency**: `gps` provider = satellite fixes, `network` provider = coarse Wi-Fi/cell fixes (the iOS fallback fixes the EKF already uses under jamming). Satellite fix = has speed, as on iOS. |
| IMU | `SensorManager`: `TYPE_GYROSCOPE`, `TYPE_GRAVITY`, `TYPE_LINEAR_ACCELERATION`, `TYPE_GAME_ROTATION_VECTOR` (no magnetometer, like `xArbitraryZVertical`), raw `TYPE_MAGNETIC_FIELD` for logging. 100 Hz, batched like iOS. |
| Clock | `SystemClock.elapsedRealtimeNanos()` in µs. Sensor events and `Location.elapsedRealtimeNanos` use it natively, so the GNSS fix time needs no wall-clock mapping (better than iOS). |
| Conventions | Kotlin normalizes to the iOS conventions the TS code assumes: gravity is the **true gravity direction** (Android's `TYPE_GRAVITY` points up, so it is negated), m/s², rad/s, course in radians, invalid fields omitted. A parity test pins this (§5). |
| Background | One **foreground service** (types `location` + `connectedDevice`) started with a trip, with a persistent notification and a partial wake lock. Without it Android stops sensors and BLE/SPP polling when the screen is off. No "Always" location permission needed. |
| Permissions | `ACCESS_FINE_LOCATION`, `BLUETOOTH_SCAN` (`neverForLocation`) + `BLUETOOTH_CONNECT` (Android 12+; legacy `BLUETOOTH`/`BLUETOOTH_ADMIN` ≤ 11), `POST_NOTIFICATIONS` (13+), `FOREGROUND_SERVICE_LOCATION`, `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `WAKE_LOCK`, `HIGH_SAMPLING_RATE_SENSORS`. All from config plugins, never by hand in `android/`. |
| Pairing | Classic adapters must be bonded (PIN 1234/0000). The Vehicle screen lists bonded devices plus discovery results; tapping an unbonded one calls `createBond()` and the system PIN dialog does the rest. |
| Icons | `expo-symbols` already renders Material Symbols on Android, and the `Icon` map keys are Material names: add `android: <key>` to each entry. |
| Blur | `BlurView` on Android needs a `BlurTargetView` and `blurMethod`. Panels use `dimezisBlurViewSdk31Plus`, and on Android 12+ the map renders into a `TextureView` (`androidView="texture"`): the default `GLSurfaceView` is not part of the view drawing the blur samples, so the blur came out empty. Android 10–11 get no blur (too slow over a moving map) and `GlassFill` swaps the 35 % tint for a dense one (`panelSolid`, 86 %) so text stays readable. |
| Offline maps | MapLibre RN supports Android offline packs. The dev map source on the LAN is cleartext HTTP, so debug builds allow cleartext traffic (`expo-build-properties`); release does not. |
| Vendor battery killers | Xiaomi, Samsung, Huawei kill foreground services. The tester guide (ANDROID-TESTING.md §4) names the per-vendor steps; the app doesn't open the exemption screen itself yet. |

## 3. Implementation

- `modules/sensor-capture` and `modules/vehicle-link` have Kotlin sides with the same JS contracts as the Swift ones
  (`SensorCaptureModule.ts`, `VehicleLinkModule.ts`); `src/nav`, `src/obd` and `src/triplog` are unchanged.
- Mapping and batching live in plain Kotlin (`modules/*/android/**/logic/`, no `android.*` imports): GNSS and motion
  payloads, `ImuBatcher`, and the link logic (UUID normalizing, UART selection, chunking, `>` framing) ported from
  the Swift with its test vectors. JUnit tests in `native-tests-android/`.
- **Vehicle link:** BLE (`connectGatt(TRANSPORT_LE)`, MTU request, notifications, write queue) and Classic SPP
  (bonding, the secure socket, then the insecure and channel-1 fallbacks many clones need). Classic devices get the id
  `spp:<MAC>` (BLE keeps the bare MAC) so a dual-mode adapter doesn't collide. `getMfiAccessories` returns `[]`.
- **Sensors:** phones without gravity / linear-acceleration sensors (and some emulators) derive them from the
  accelerometer.
- **Trip service:** a foreground service (types location + connected device, notification "wtf.ai is recording your
  trip", partial wake lock) runs while a trip records.
- **Permissions:** the Bluetooth permission dialog is shown at most once per process, and never on devices without an
  adapter (a restart loop on the emulator taught that).

## 4. CI/CD: nothing broken reaches a tester

| Job | What it proves | When |
| --- | --- | --- |
| `checks` | lint, tsc, Jest (Android branches included) | per the CI plan ([CI.md](CI.md)) |
| `native-logic-android` | the Kotlin logic tests on a plain JVM (`native-tests-android/`) | Android-native changes |
| `build-android` | `expo prebuild --platform android`, `./gradlew assembleRelease`; uploads the signed APK | `main`, Android-native changes, `[build android]` |

- **Emulator smoke test** (`scripts/android-smoke.sh`, local only; it was too slow for CI): installs the APK,
  grants permissions, launches, and checks that the app renders its first screen, receives GNSS fixes from the
  emulator, connects the simulated OBD adapter (`wtfai://vehicle?emulators=1`, the same switch as Developer → Show
  emulated adapters), starts the IMU and survives; writes screenshots and logcat.
  `bash scripts/android-smoke.sh path/to/app.apk out-dir`.
- **Signing:** a stable keystore from secrets (`ANDROID_KEYSTORE_BASE64`, `_PASSWORD`, `_KEY_ALIAS`, `_KEY_PASSWORD`;
  `bash scripts/android-keystore.sh` creates the key outside the repo and prints the `gh secret set` commands), so
  APK updates install over the previous one and keep app data. Without the secrets the job signs with a debug key
  (fine for CI, not sent to testers).
- **What CI cannot prove:** real BLE/SPP adapters and OEM battery killers. The first tester round is staged: one
  tester with a common phone and a Classic adapter, using the tester guide; trip logs come back and are replayed with
  `replay:parity`, then the wider group. Phone sensor quirks (gyro noise, GNSS lag per model) come from those logs
  (SPEC §9 item 17).

## 4.1 Logging and metrics (Sentry)

We cannot watch testers' phones, so the app reports what it can, through the existing Sentry setup
(`src/config/sentry.ts`: EU region, scrubbing in `sentry-scrub.ts`, logs on, breadcrumbs from the link and recorder).
Same privacy rule as SPEC §2: no coordinates, no VINs, no adapter serials; the scrubber stays the single gate.

- **Tags on every event** (set once at startup): `os` (`android`), `os.version`, `sdk_int`, `device.model`/`manufacturer`
  (from `expo-device`), `build_sha`, `transport` (`ble` | `spp` | `mfi`), `adapter_model` (catalog name, not serial),
  `battery_optimized` (true/false), `tester` (an anonymous id you hand out: "t01", "t02", so reports can be grouped; the id-to-person list is never stored in the repo).
- **Native crashes**: Sentry's Android NDK/ANR integration (included in `@sentry/react-native`), plus Kotlin
  `try/catch` around every bridge entry point that reports through a JS event `onNativeError {module, where, message}`
  so a failed `connectGatt` is a Sentry issue, not a silent dead button.
- **Metrics** (Sentry metrics, numeric, no positions), emitted from TS where the data already exists:
  - `link.poll_rate_hz` (per adapter model, per transport), `link.transact_latency_ms`, `link.timeouts`;
  - `link.connect_ms`, `link.connect_failed` with a reason tag (`bond`, `gatt-133`, `socket-secure-failed`, `timeout`),
    `link.lost` with reason, and reconnect time;
  - `gnss.fix_rate_hz`, `gnss.coarse_share`, `gnss.satellite_share` (jamming indicator), `gnss.lag_ms` (online estimate);
  - `imu.rate_hz` and `imu.dropped_batches`: the direct check that Android keeps sensors alive with the screen off;
  - `service.foreground_gap_s` (longest hole in samples while the screen is off) and `service.restarts`;
  - `nav.dr_error_p50_m` per outage versus trusted fix when the fix returns, `nav.mapmatch_unimodal_share`;
  - `trip.duration_s`, `trip.log_bytes`, `app.cold_start_ms`.
- **Logs** (Sentry logs, levels): the vehicle-link events and recorder messages as today, plus permission results
  (granted/denied per permission, never prompts' text), Bluetooth/location state changes, service start/stop,
  battery-optimization state, GATT dump summary for unknown adapters (service UUIDs only).
- **Release health**: sessions on, so crash-free rate per release and per device model is visible; the Android
  upload of ProGuard/R8 mapping and source maps in `build-android` (same `SENTRY_AUTH_TOKEN` secret, SPEC §9 item 18).
- **CI correlation**: `build_sha` ties an issue to the commit; the emulator smoke test sets `environment=ci` so its
  events never mix with testers' (`environment`: `ci` | `development` | `production`, with testers on `production`).
- **Alerts** (set up in Sentry, once): new issue on a release, crash-free sessions < 99 %, `imu.rate_hz` < 50 or
  `service.foreground_gap_s` > 5 for a tester, `link.poll_rate_hz` < 8 (SPEC §9 item 1's minimum usable rate).
- **Not in Sentry**: the trip logs themselves (ULog, exported by the tester) remain the source for navigation accuracy;
  Sentry carries health and compatibility, not tracks.

Built (`src/services/telemetry.ts`, pure TS, tested with Sentry mocked): the tags (device, Android version, build,
the install id shown as "Support code" in Settings), connect time and failures by reason, poll rate and latency,
GNSS/IMU rates, satellite share, longest IMU gap while recording, the `ci` environment for emulator runs. Not built:
native `onNativeError` events, trip size/duration metrics, and the alert rules (set up in the Sentry UI).

## 5. Parity and risk checks

- **Sign conventions**: a Kotlin test feeds Android-convention sensor values for a known motion (phone flat, turned
  counter-clockwise) and asserts the same `motion` row the Swift logic yields for iOS values.
- **Payload parity**: JSON fixtures of `onGnss` / `onImuBatch` payloads shared between Swift tests, Kotlin tests and a
  Jest test of the TS consumers.
- **Replay on Android logs**: logs from the first tester go through `npm run replay` unchanged; if the navigator needs a
  per-phone tweak it lives in calibration, not in a fork.

| Risk | Mitigation |
| --- | --- |
| Android pauses sensors/BLE with the screen off | Foreground service + wake lock, emulator sleep test, tester check |
| Classic clones need the insecure-socket workaround | Try secure, then reflective fallback; log which worked |
| `neverForLocation` hides some BLE adapters on some OEMs | Catalog + unfiltered fallback, as on iOS; tester log of unseen devices |
| Differing OEM GNSS (speed/bearing accuracy missing) | Missing fields are omitted, as for iOS invalid fields |
| Emulator GNSS is too clean to show jamming behaviour | Jam simulation stays in replay; Android only needs the event path correct |
| Kotlin compile errors surface only in CI | Local build on Windows (Android SDK) before pushing; `build-android` is the backstop |

## 6. Status

- **Built and checked on the emulator:** the release APK builds and is signed; GNSS fixes from the emulator's `gps`
  provider and IMU batches reach the TS side; the simulated ELM327 connects on the Vehicle screen; the trip
  foreground service starts with a recording; the app survives a screen-off. 40 Kotlin logic tests mirror the Swift
  vectors.
- **Not yet met a real phone:** BLE and Classic SPP are compile-checked only (the emulator has no Bluetooth), and
  OEM battery killers are untested. The first real run is a tester with an adapter.
- Next: the first staged tester round.

## 7. Decisions and open items

- `minSdk` 29 (Android 10): Android 8–9 are a few percent of phones, we can't test on them, and 29 is where
  foreground service types start.
- First test adapters: a Vgate vLinker FD+ and a cheap ELM327 clone; which transport each uses (BLE or Classic SPP)
  is confirmed from the first trip log.
- No developer program: the APK is sideloaded. Google Play would need a $25 account and a 14-day closed test with 12
  testers; not planned.
- Open: testers' phone models, once known, refine the matrix.
