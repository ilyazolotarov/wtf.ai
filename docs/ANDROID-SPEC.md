# wtf.ai — Android: plan and specification

Status: draft v1 (2026-10-05). Companion to [SPEC.md](SPEC.md); when decisions here are final, fold them into SPEC §2, §4, §5, §8.

## 1. Goal and constraints

- Volunteer testers run the app on their own Android phones. We have **no Android device**, so nothing may reach them
  that CI has not installed and exercised on an emulator.
- Same product, same TypeScript core (`src/nav`, `src/obd`, `src/triplog` stay untouched). Android means: two Kotlin
  Expo modules with the same JS contract as the Swift ones, a few UI fallbacks, a foreground service, and CI.
- No EAS, no Play Store account. Distribution: a **signed release APK** from GitHub Actions (artifact, optionally sent
  to Telegram like the IPA). Testers enable "install unknown apps".
- Unlike iOS, **Android can be built and run on this Windows PC** (Android SDK + emulator, no Mac needed), so the native
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
| Vendor battery killers | Xiaomi, Samsung, Huawei kill foreground services. Onboarding links testers to the battery-optimization exemption screen; the tester guide (§7) names the per-vendor steps. |

## 3. Work breakdown

### A. JS parity and Android config (no native code, testable on Windows today)

1. `app.json`: `android.package` (`ai.wtf.navigator`), permissions above via a config plugin, `expo-build-properties`
   (debug cleartext, `minSdk` per SDK 57, `compileSdk`/`targetSdk` defaults), Sentry Android.
2. `Icon` already passes Android names (done before this plan). `GlassFill`/`MapBlur`: `BlurTargetView` plumbing in the map screen (done).
3. `src/services/runtime.ts`: `autoConnect` is gated on `Platform.OS === "ios"`; open it for Android with the Android
   Bluetooth state.
4. `src/obd`: transport kind `spp`, catalog/discovery ranking for Classic names (`OBDII`, `V-LINK`, `OBDLink`, …),
   `NativeTransport` and `device-list.tsx` handle `spp` like `mfi` (no picker; bonded list instead).
5. Permission flow on the Vehicle and onboarding screens: Android 12+ Bluetooth runtime permissions, notifications.
6. `src/services/telemetry.ts`: Sentry tags and metric helpers (§4.1).
7. Jest: Platform-switched tests; config-plugin tests (manifest output) like `app-plugin.test.ts`.

### B. `modules/sensor-capture` Android (Kotlin)

- Same JS contract as `SensorCaptureModule.ts` (no TS change): `nowUs`, `getPermissions`, `requestLocationPermission`,
  `startGnss`/`stopGnss`, `startImu`/`stopImu`, events `onGnss`, `onGnssError`, `onImuBatch`, `onAuthorization`.
- Mapping and batching in **plain Kotlin** (`.../logic/`, no `android.*` imports): `LocationSample → gnssEvent`,
  motion-row assembly (a row per gyro event with the latest gravity / linear accel / rotation vector), `ImuBatcher`.
  Tested on the JVM; vectors copied from `native-tests/` so Swift and Kotlin produce identical payloads.
- `permissions()`: `fine`/`coarse` map onto `whenInUse`; `accuracy` = `reduced` when only coarse is granted.
- GNSS in a foreground service (module owns `TripService`; the vehicle-link module reuses it through a small shared
  interface or a third `modules/trip-service`, decided at implementation).

### C. `modules/vehicle-link` Android (Kotlin)

- Same contract as `VehicleLinkModule.ts`. `LinkLogic` (UUID normalizing, `selectUart`, chunking, `PromptFramer`)
  ported to Kotlin line for line, with the Swift test vectors. Logic stays transport-free.
- BLE: scan (with the catalog service filter + unfiltered fallback), `connectGatt(TRANSPORT_LE)`, service discovery,
  MTU request (use the negotiated MTU − 3 for chunking), notifications via CCCD, write queue.
- SPP: `createRfcommSocketToServiceRecord(SPP)`, fall back to the reflective insecure channel-1 socket that many
  clones need; blocking read thread framing on `>`.
- Both: timestamps from the monotonic clock at write and at first/last byte; one transaction in flight; `link-lost`
  errors as iOS; reconnect-with-pending-connect semantics (`timeoutMs: 0`).
- `getMfiAccessories` returns `[]`; `showMfiPicker` rejects `unsupported`. A new `getBondedDevices()` and `bond(id)` serve SPP.

### D. Foreground service and lifecycle

- `TripService` starts when a trip starts (GNSS + IMU running or adapter connected), stops with the trip. Notification
  channel "Trip in progress". Partial wake lock only while it runs.
- Verify: polling and logging continue 10+ minutes with the screen off (emulator can lock the screen; real proof comes
  from a tester, §7).

### E. CI/CD (the safety net, §4)

### F. Tester guide and spec updates

- `docs/ANDROID-TESTING.md` for non-technical testers: install the APK, permissions, battery exemption, how to export
  and send a trip log.
- SPEC.md: move Android from "later / out of scope" to a phase, add the Kotlin tests to §6, fix §8.

## 4. CI/CD: nothing broken reaches a tester

All on GitHub-hosted Ubuntu runners (free minutes; KVM gives a hardware-accelerated emulator).

| Job | What it proves | When |
| --- | --- | --- |
| `checks` (existing) | lint, tsc, Jest (now also Android branches), pytest | every push |
| `native-logic-android` | Kotlin logic unit tests on a plain JVM Gradle project (`native-tests-android/`, mirrors `Package.swift`): UUID/GATT selection, framer, chunking, GNSS/IMU payload mapping, batcher | every push |
| `build-android` | `expo prebuild --platform android`, `./gradlew assembleRelease`, lint of the manifest; uploads the signed APK | every push, after checks |

The emulator smoke test (`scripts/android-smoke.sh`) was a CI job (API 34 on every Android build, API 29 too on
`main`); removed from CI on 2026-10-06 because it took too long. It now runs only against a local emulator.

Signing: a keystore stored as secrets (`ANDROID_KEYSTORE_BASE64`, `_PASSWORD`, `_KEY_ALIAS`, `_KEY_PASSWORD`) so APK
updates install over the previous one and keep app data. Without the secrets the job signs with an ephemeral debug key
(fine for CI, not sent to testers). A small config plugin points the `release` signing config at those variables.

### What the emulator test covers

- **Boot and render**: release bundle starts, map screen draws, no red box, no crash (Maestro + `adb logcat`).
- **GNSS path**: `adb emu geo fix` / a GPX route plays through the real `gps` provider, so `startGnss`, event mapping and
  the navigator get real events. Assertions: the position puck appears; a trip log file is created.
- **IMU path**: the emulator's virtual accelerometer/gyroscope (`adb emu sensor set`) feed `startImu`; assertion: motion
  rows in the trip log, gravity sign matches the iOS convention.
- **Adapter path**: no Bluetooth on the CI emulator, so the existing TS **driving emulator** (the web fallback adapter)
  is switched on by the deep link `wtfai://vehicle?emulators=1` (the same switch as Developer → Show emulated adapters). This runs the real ELM session, poller, navigator and
  recorder end to end with simulated OBD. Native BLE/SPP are covered by logic tests plus the tester round (below).
- **Background**: `adb shell input keyevent KEYCODE_SLEEP`, wait, wake, assert the trip log kept growing (foreground
  service holds).
- **Trip export**: the share path produces a readable ULog (checked with `tools/triplog` in the same job).

### What CI cannot prove (and how we cover it)

- Real BLE/SPP adapters and OEM battery killers: the first tester round is a **staged rollout**: one tester with a
  common phone and a Classic adapter, using the tester guide; trip logs come back and are replayed with `replay:parity`
  (the same parity tool as iOS). Only then the wider group.
- Phone sensor quirks (gyro noise, GNSS lag per model): the navigator already measures GNSS lag online; per-phone
  logs extend SPEC §9 item 17.

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
  upload of ProGuard/R8 mapping and source maps in `build-android` (same `SENTRY_AUTH_TOKEN` secret, §9 item 18).
- **CI correlation**: `build_sha` ties an issue to the commit; the emulator smoke test sets `environment=ci` so its
  events never mix with testers' (`environment`: `ci` | `development` | `production`, with testers on `production`).
- **Alerts** (set up in Sentry, once): new issue on a release, crash-free sessions < 99 %, `imu.rate_hz` < 50 or
  `service.foreground_gap_s` > 5 for a tester, `link.poll_rate_hz` < 8 (SPEC §9 item 1's minimum usable rate).
- **Not in Sentry**: the trip logs themselves (ULog, exported by the tester) remain the source for navigation accuracy;
  Sentry carries health and compatibility, not tracks.

Implementation sits in part A (tags, native-error event, metric helpers in one `src/services/telemetry.ts`) and in each
module part (Kotlin errors, rates); the helper is pure TS, tested with Sentry mocked, and the emulator job asserts the
tags and one metric reach `environment=ci`.

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
| Emulator GNSS is too clean to show jamming behaviour | Jam simulation stays in `replay:sim`; Android only needs the event path correct |
| Kotlin compile errors surface only in CI | Local build on Windows (Android SDK) before pushing; `build-android` is the backstop |

## 6. Milestones (each ends green in CI)

1. **M1 App boots on Android**: part A + `build-android` + `android-smoke` with no native modules yet (stub Kotlin
   modules returning "unavailable"), so the empty shell and the CI pipeline are proven first.
2. **M2 Sensors**: part B, GNSS/IMU emulator tests, trip log produced.
3. **M3 Vehicle link**: part C + D, logic tests, E2E with the driving emulator.
4. **M4 Tester build**: signed APK delivery, tester guide, first staged round.

## 6.1 Status

- **M1 done** (2026-10-06, CI run on the `android` branch): the release APK builds and is signed, and the Android 14
  emulator job installs it, grants permissions and sees the onboarding screen with no crash, ANR or JS error.
  Plugged into the CI plan of `docs/CI.md` (merged from `ci/run-what-changed`). Not yet exercised: Android 10 image
  (runs on `main` only), the stable signing key (its secrets are set since 2026-10-06), Telegram delivery.
- **M2 and M3 verified on the emulator** (2026-10-06): GNSS fixes from the emulator's `gps` provider and IMU batches
  reach the TS side; the simulated ELM327 connects on the Vehicle screen; the trip foreground service starts with a
  recording (types location + connected device); the app survives a 35 s screen-off. Kotlin logic tests
  (`native-tests-android/`, 40 cases) mirror the Swift vectors. BLE (GATT with MTU and retry) and Classic SPP (bonding,
  secure/insecure/channel-1 sockets) are written but **only compile-checked**: the emulator has no Bluetooth, so the
  first real run is a tester with an adapter.
- Differences from the plan: classic devices get the id `spp:<MAC>` (BLE keeps the bare MAC) so a dual-mode adapter
  does not collide; phones without gravity/linear-acceleration sensors (and some emulators) derive them from the
  accelerometer; the Bluetooth permission dialog is shown at most once per process and never on devices without an
  adapter (a restart loop on the emulator taught us that); iOS-only fields stay iOS-only.
- Telemetry (§4.1) is in: tags (device, Android version, build, install id shown as "Support code" in Settings),
  connect time and failures by reason, poll rate and latency, GNSS/IMU rates, satellite share, longest IMU gap while
  recording, `ci` environment for emulator runs. Not done: native `onNativeError` events, trip size/duration metrics,
  Sentry alert rules (set up in the Sentry UI).
- Next: M4 (tester build: signing key secrets, first staged round).

## 7. Decisions and open items

- Decided: `minSdk` 29 (Android 10; raised from 26 on 2026-10-06). Android 8–9 are a few percent of phones, we cannot
  test on them, and 29 is where foreground service types start.
- Decided: first test adapters are a Vgate vLinker FD+ and a cheap ELM327 clone. Which transport each uses (BLE or Classic
  SPP) is confirmed from the first trip log; both are implemented in M3.
- No developer program is needed: the APK is sideloaded. Google Play would need a $25 account and a 14-day closed test
  with 12 testers; not planned.
- Done (2026-10-06): the signing key and its four secrets (`bash scripts/android-keystore.sh` creates the key outside
  the repo and prints the `gh secret set` commands). Next: an emulator check of the signed build, then Actions → CI →
  Run workflow with `android = tester` (Telegram delivery if its secrets are set). The tester variant (arm64 + armeabi-v7a) is not exercised by branch CI, because
  `workflow_dispatch` only runs workflows already on `main`; its first run happens after the merge.
- Open: testers' phone models, once known, refine the matrix.
