# wtf.ai — Spoofing-Resilient Car Navigator: Specification

Source of truth for coding agents. Update this file when a decision changes; it states what the system does and
what must not drift, not how it got there.

Companion specs: [UI-SPEC.md](UI-SPEC.md) (screens and the map), [VEHICLE-LINK-SPEC.md](VEHICLE-LINK-SPEC.md)
(the OBD adapter), [TRIP-LOGGER-SPEC.md](TRIP-LOGGER-SPEC.md) (trip detection, logging, export),
[NAVIGATOR-SPEC.md](NAVIGATOR-SPEC.md) (EKF, calibration, integrity, replay), [MAPMATCH-SPEC.md](MAPMATCH-SPEC.md)
(road graph, particle filter), [ROUTING-SPEC.md](ROUTING-SPEC.md) (routing and guidance),
[SEARCH-SPEC.md](SEARCH-SPEC.md) (offline address search), [UPDATES-SPEC.md](UPDATES-SPEC.md) (app and map updates),
[ANDROID-SPEC.md](ANDROID-SPEC.md) (the Android build), [STORE-REVIEW.md](STORE-REVIEW.md) (store builds).

## 1. Problem and goal

**wtf.ai** stands for **"Where the f\* am I?"**: helping drivers know their position when GNSS cannot be trusted.

During air raids in Ukraine, GNSS is jammed or spoofed (fixes jump to wrong places, often outside Ukraine). The app
keeps a trustworthy vehicle position by fusing the last trusted GNSS fix with vehicle odometry in an EKF, locating the
vehicle on the offline road network with a map-constrained particle filter, and provides offline routing, address
search and voice guidance.

Odometry comes in stages (§2.1): speed from the car over an OBD-II adapter (standard PID `0D` on any car, or the
wheel speeds from the CAN bus where the adapter and car allow) and heading rate from the phone gyro.

## 2. Fixed decisions

| Topic | Decision |
| --- | --- |
| Platform | **iOS first**; **Android** for volunteer testers, sideloaded as an APK from CI and tested on emulators ([ANDROID-SPEC.md](ANDROID-SPEC.md), [ANDROID-TESTING.md](ANDROID-TESTING.md)). |
| Dev environment | Windows only, no Mac, **no paid Apple Developer account**. iOS builds: GitHub Actions macOS runner, `expo prebuild` + `xcodebuild` with signing disabled → unsigned IPA, sideloaded with **AltStore**. **No EAS.** JS-only changes reach Release builds over the air from our own update server ([OTA.md](OTA.md)). CI: [CI.md](CI.md). |
| Framework | Expo SDK 57, Expo Router, TypeScript. Dev builds only (no Expo Go). |
| Odometry roadmap | **Staged** (§2.1). Each stage is a drop-in odometry source; the EKF, integrity and map matching don't change between stages. |
| Adapter protocol | Plain ELM327 command subset for polling (§3.1); STN commands only for identification (`STI`) and the CAN monitor on STN adapters. |
| Adapter transport | iOS: **BLE** (CoreBluetooth, no MFi: any Bluetooth 4.0+ LE ELM327) and **MFi Classic Bluetooth** (`ExternalAccessory`: OBDLink MX+, vLinker FS/MS). Android: BLE and Classic SPP. The ELM327 layer is transport-agnostic. |
| Trip log format | **ULog** (PX4), written by a pure-TS encoder; read on PC with Python (`tools/triplog`). |
| Sensor capture | Own native module `modules/sensor-capture` (CoreLocation + CoreMotion; LocationManager + SensorManager on Android), batched, one monotonic clock shared with the adapter timestamps. `expo-location` only for permissions and the walking compass. |
| Map display | **MapLibre** with **offline** OSM vector tiles of the active downloaded region only; without one the app asks for a download. No online map. |
| Routing | **A\* in TS on our own road graph** (the map-matching graph), see ROUTING-SPEC. No Valhalla: its native packaging was never solved, its tiles were a second download, and its roads differed from the filter's. |
| Map matching | **Custom road-constrained particle filter** in TS over our own road graph. No HMM for live matching: an HMM assumes independent, bounded errors; dead-reckoning error is correlated and grows. |
| Estimator location | **TypeScript** (`src/nav/`), not native: logic must hot-reload and replay on Windows. Native code stays thin. |
| GNSS integrity | Two checks only: **outside the Ukraine polygon** and **teleport vs odometry**. No raw GNSS (C/N0, AGC), no slow drag-off detection. |
| Yaw source | Phone gyro projected onto gravity (any mount angle). Optional, experimental: the rear wheels' speed difference from CAN (NAVIGATOR-SPEC §5.4). CAN yaw rate: later (Stage 3). |
| Absolute heading | From trusted GNSS course, the particle filter's road heading, the driver placing the car, and the pose saved at ignition off. **The magnetometer is not used for navigation**: in-car distortion changes when the phone moves. The compass runs in **shadow mode** (computed, checked, logged; never navigated with) and a display-only compass shows where the phone points when walking. |
| Phone mount | A **rigid phone mount** is required (the gyro is the only yaw source without CAN). |
| Standstill bias calibration | 2 s of standstill, refined at every stop (ZUPT). No calibration drive, screen or wizard: everything is learned online. |
| Distribution | Sideloading (AltStore source on iOS, the app installs its own APK on Android; UPDATES-SPEC). Store builds (`DISTRIBUTION=store`) drop self-installed updates and AltStore, and hide the Developer screen and the tester upload until unlocked (STORE-REVIEW.md). Privacy policy: [PRIVACY.md](PRIVACY.md). |
| Privacy | All data stays on the device. No position upload; trip logs leave the phone only by the share sheet or the **opt-in upload** with a personal code (TRIP-LOGGER-SPEC §7.1). One other exception: Sentry crash/error reports (EU region, no PII; coordinates and VINs scrubbed in `src/config/sentry-scrub.ts`). |

### 2.1 Odometry stages

| Stage | Speed source | Yaw source | Adapter features | Vehicle-specific data |
| --- | --- | --- | --- | --- |
| 1 | OBD-II Mode 01 PID `0D` (1 km/h resolution), polled at 2 Hz, unsigned | Phone gyro `ω = gyro · ĝ` | ELM327 subset, request/response | None |
| 2 | CAN wheel speeds (0.01 km/h), signed by the CAN gear | Phone gyro; optionally the rear wheel differential | STN passive CAN monitor + pass filters | Per-make profile (opendbc) |
| 3 | As Stage 2 | CAN yaw rate (to be reverse-engineered) | As Stage 2 | Profile + yaw signal |

- Stage 1 is the permanent fallback: cars with a CAN gateway, unknown makes, non-STN adapters.
- Stage selection is automatic per vehicle. Engine and ignition state stay on OBD (`010C`, the `0100` probe) in every
  stage.
- The adapter can't poll and monitor CAN at the same moment; it switches within tens of milliseconds. Stage 2 shares
  it by time-slicing (VEHICLE-LINK-SPEC §16): the monitor listens while the car moves, the polls run while it stands
  or while no fresh CAN speed comes.
- One setting for every car, Settings → Car → **Speed from the wheels**, on by default (VEHICLE-LINK-SPEC §16.3):

  | Setting | Navigation speed | CAN frames | OBD `010D` |
  | --- | --- | --- | --- |
  | off | `010D` at 2 Hz | not read | the speed source |
  | on (default) | wheel speeds | decoded on the phone, logged | polled while the car stands, or without fresh CAN speed |

  CAN falls back to OBD by itself: an adapter that isn't an STN, a car not on CAN, a make without a profile, none
  of its ids heard, or the monitor failing. Wheel and gear mappings are opendbc's, trusted as they are; the speed
  scale is learned against GNSS as with OBD (`k_s`). There is no "log the frames but navigate on OBD" mode: the polls'
  breaks cost both sides.

## 3. Architecture

```
Adapter ──BLE / EA / SPP──▶ modules/vehicle-link (Swift, Kotlin; thin: transport + timestamps)
                              │ ELM327 request/response with tx/rx timestamps; raw CAN monitor output
                              ▼
                            src/obd (TS: ELM327 session, probe, PID parsing, poller, engine state, CAN monitor)
                              │  VehicleLink contract (VEHICLE-LINK-SPEC §6)
                              ▼
GNSS + IMU ──────────────▶ src/nav (TypeScript, pure)
(modules/sensor-capture,      ├─ odometry   (imu: gyro · ĝ, handling detection, phone speed; can: profiles, decoder, wheel yaw)
 batched)                     ├─ integrity  (GNSS trust state machine, Ukraine border)
                              ├─ ekf        (dead reckoning + updates, heading alignment)
                              ├─ calibration (GNSS lag), compass (shadow)
                              ├─ mapmatch   (particle filter on the road graph; RoadGraph interface ◀─ graph file)
                              ├─ routing    (A* on the same graph, guidance, voice announcer)
                              ├─ search     (offline address search)
                              ├─ phone      (phone-only mode: no adapter)
                              └─ replay, sim (benchmarks, simulated drives)
                                      │
                                      ▼
                            src/services (RN glue) → src/app screens (map, route, vehicle, guide, more)
```

### 3.1 Vehicle link: `modules/vehicle-link` + `src/obd`

Full specification: [VEHICLE-LINK-SPEC.md](VEHICLE-LINK-SPEC.md). Summary:

- **Native**: BLE scan, list/pair MFi accessories, connect/reconnect, write bytes, frame on the ELM `>` prompt,
  timestamp with the monotonic clock, forward unsolicited bytes (the CAN monitor). No protocol logic.
- **TS** (`src/obd`, pure): discovery ranking by a GATT/name catalog (adding a BLE adapter needs no native build),
  ELM327 verification probe, session init, speed/RPM poller, engine/ignition state, the CAN monitor.
- **Stage 1 API**: `transact(command) → { raw, txUs, rxUs }`, one in flight. A speed sample is timestamped at
  `(txUs + rxUs) / 2`.
- Commands: probe `ATZ`/`ATWS`, `ATE0`, `ATI`, `AT@1`, `STI`, `ATRV`; init `ATE0 ATL0 ATS0 ATH1 ATAT1`, protocol
  `ATSP0` + `0100` → `ATDPN` → `ATSPn`; on 11-bit CAN pin the speed ECU (`ATSH`/`ATCRA`), then `ATH0`. Speed `010D1`
  at 2 Hz (the trailing `1` is the response count; fall back to `010D`). RPM `010C` every 5 s with the engine running,
  2 s with the ECU awake and the engine off, 5 s as the ignition probe. VIN `0902`. Ignition off = no valid response
  for 10 s.

### 3.2 Odometry sources (`src/nav/odometry/`)

- **OBD speed**: PID `0D` (km/h, integer) → m/s, unsigned (reverse is car-specific: the main test car reads 0).
  Measurement noise covers the 1 km/h quantization and poll timing. Some ECUs read 0 below 2–3 km/h, so standstill
  also needs a quiet IMU.
- **Phone IMU** (`odometry/imu/`): vertical yaw rate `ω = gyro · ĝ` from CoreMotion `xArbitraryZVertical` at 100 Hz.
  **Handling detection** marks the gyro invalid while the phone moves in the mount or in a hand (NAVIGATOR-SPEC §5.1).
- **CAN** (`odometry/can/`, Stage 2): a per-make mapping (`mappings.ts`, written from opendbc's `carstate` for every
  make on classic CAN: wheel speeds, speed, gear, steering, brake, yaw rate where one exists; units, signs, gear
  tables) resolved against `signals.json`, generated by `npm run can:profiles` from the opendbc submodule
  (`tools/can/opendbc`, pinned commit recorded in the file). No DBC parsing on the device. CAN FD platforms are left
  out (STN adapters receive classic CAN only). Profile selection: the VIN's make gives the candidates, the ids heard
  at the OBD port pick one; a profile needs a wheel or speed message among them. The track width for wheel yaw is a
  constant (1.60 m), not in the profile.

### 3.3 GNSS integrity (`src/nav/integrity/`)

Run by the navigator on every satellite fix before anything uses it (NAVIGATOR-SPEC §8). A refused fix moves nothing.
Shown states: `TRUSTED`, `UNTRUSTED` (refused as spoofed), `REACQUIRING` (back on the dead reckoning, or held after
a gap, being checked), `NO_FIX` (no good satellite fix for 8 s).

1. **Outside Ukraine**: `ukraine-border.ts`, Ukraine's OSM boundary buffered by 2 km and simplified to 500 m,
   generated by `python -m tiles.cli border`. Any fix outside is refused.
2. **Teleport** vs odometry and dead reckoning: a **jump** farther than the car could have got since the last trusted
   fix; a **shape** mismatch (over ≥ 50 m driven, the fixes moved a different distance than the OBD + gyro track);
   **after a gap** (> 10 s or a session start) a fix far from every dead-reckoning hypothesis is held
   (`REACQUIRING`) until the fixes come back or move like the car for 200 m.
3. **Re-acceptance**: 5 fixes in a row over ≥ 4 s near a hypothesis; fixes that move like the car after 200 m when the
   dead reckoning may be wrong, after 2 km when it agreed with the fixes before the spoofing began.
4. **Wi-Fi/cell fixes** (no speed) are not GNSS: they never make the state `TRUSTED`; one outside Ukraine is dropped;
   otherwise the EKF uses them at their reported accuracy (they stayed honest in real jammed drives, and spoofing
   doesn't move them). A fix is a satellite fix when it has a speed.
5. **Without OBD speed** only the border and a 200 km/h jump protect; the map holds the last fix integrity passed,
   its circle growing at 15 m/s.

Out of scope: raw GNSS, slow drag-off, spoofs that follow the car's own motion.

### 3.4 EKF (`src/nav/ekf/`)

- Local ENU frame, re-anchored every 5 km. State `E, N, ψ, v, k_s, b_ω, k_ω`. Prediction at the IMU rate; `v` a
  random walk corrected by speed updates (`v = k_s · s`, OBD at 2 Hz or CAN wheel speed at ~10 Hz).
- Updates: satellite position (+ course at speed) only for fixes integrity passes, through a χ² gate; Wi-Fi/cell
  positions at their accuracy in any trust state; ZUPT at standstill; map-matching road heading and position
  (MAPMATCH-SPEC §9); the driver placing the car (NAVIGATOR-SPEC §6.2). Fix comparisons are lag-corrected with a
  GNSS lag measured online.
- Before the heading is known the position is anchored at the best fix with a radius growing by the distance
  driven; the heading comes from a GNSS course, from fitting the OBD + gyro track to coarse fixes, from the map
  (MAPMATCH-SPEC §8), or from the saved parked pose.
- Pure TS, deterministic, no RN imports: unit-testable and replayable in Node on Windows.

### 3.5 Calibration (`src/nav/calibration/`, NAVIGATOR-SPEC §7)

Online only: gyro bias at stops, speed scale `k_s` (persisted per VIN), GNSS lag (persisted per phone model and OS
version), the compass (shadow, per car and mounting). The pose at ignition off starts the next drive.

### 3.6 Map matching (`src/nav/mapmatch/`, [MAPMATCH-SPEC.md](MAPMATCH-SPEC.md))

Road-constrained particle filter (Gustafsson et al., IEEE TSP 2002). The EKF supplies calibrated increments
`Δs`, `Δψ`; the filter holds the position on the road network, weighs hypotheses mainly by the car's measured turns
against the roads', keeps a small off-road share for yards and unmapped roads, starts the EKF with the road heading
under jamming, and feeds road heading and position back into the EKF. The map shows the dominant hypothesis and the
other roads the car may be on. Graph access only through the `RoadGraph` interface, so the same code runs on the
device and in replay.

### 3.7 Offline data (`tools/tiles/`)

- Source: Geofabrik Ukraine PBF. Per region (`ukraine` and its 27 subdivisions): vector tiles (PMTiles, OpenMapTiles
  schema, Liberty style), the **road graph** (`<region>.graph.bin`, MAPMATCH-SPEC §4: drivable ways split at
  junctions, turn restrictions, speed attributes for route times; tiled internally at z14 so the Ukraine graph costs
  what an oblast's does), the **address search index** (`<region>.search.bin`, SEARCH-SPEC). Shared: the style, glyphs,
  sprites and `world.geojson`, the world drawn around the region (`tools/tiles/README.md`).
- Published weekly to the update Worker (UPDATES-SPEC §4); the in-app download manager is resumable and
  checksum-verified (small shared files six at a time, each tried three times before the download fails), and the
  active region updates itself on Wi-Fi up to 300 MB. Each install of a region's tiles
  gets its own file name (`<region>.<md5>.pmtiles`): MapLibre caches a PMTiles header by URL for the life of the app.

### 3.8 App (`src/app/`, Expo Router; [UI-SPEC.md](UI-SPEC.md))

- `index`: the map. `onboarding`, `map-setup` (the first download): full-screen modals. Pages pushed on the root
  stack: `route`, `vehicle`, `downloads` (also `more/downloads`), `guide/` (+ `guide/lesson`), `more/` with
  `settings`, `update`, `recorder` (trip logs), `developer` (test switches, ELM terminal, UI gallery), `trips`,
  `debug-terminal`.
- Background: iOS `UIBackgroundModes` `location`, `external-accessory`, `bluetooth-central`, `audio`; Android a
  foreground service while a trip records. Location stays **When In Use**.

### 3.9 Logging and replay (`src/triplog`, `src/nav/replay`, `tools/replay`)

- Every drive is recorded as a ULog file ([TRIP-LOGGER-SPEC.md](TRIP-LOGGER-SPEC.md)): OBD polls, GNSS fixes, IMU at
  100 Hz, raw magnetometer, CAN frames, engine and trip events, and what the map showed (`nav_estimate`,
  `nav_mapmatch`, routes).
- Replay runs the same navigator in Node (`npm run replay`, the viewer, benchmarks; NAVIGATOR-SPEC §10,
  `tools/replay/README.md`). Simulated outages, jamming and spoofing come from cutting or replacing fixes in clean
  logs; simulated city drives from `src/nav/sim`.
- Real logs live in `tools/triplog/logs/`, git-ignored (VIN, GPS tracks), backed up to a private bucket
  (`npm run logs:push`). Testers' uploads land in `logs/testers/<name>/`.
- **Phone-only mode** (experimental developer setting, NAVIGATOR-SPEC §9.6): navigation without an adapter from the
  phone's own speed estimate and turn-anchored map matching, with the driver placing the car. Not usable unattended.

## 4. Repository layout

```
src/app/                 Expo Router screens only
src/nav/                 pure TS core (no React Native imports)
  odometry/{imu,can}/ ekf/ integrity/ calibration/ compass/ mapmatch/ routing/ search/ phone/ position/ geo/ replay/ sim/
  navigator.ts           sensor fusion entry point (live services and replay feed it)
src/obd/                 pure TS: adapter catalog, ELM327 session/probe/parser, PIDs, poller, engine state, emulator, CAN monitor
src/triplog/             pure TS: ULog encoder and reader, trip log schemas, trip detector, upload protocol
src/services/            RN glue: navigation (navigator, routes, places), position, vehicle-link, sensor-capture, trip-recorder,
                         trip-upload, offline-map, app-update, guide, telemetry; runtime.ts creates them once
src/providers/           React bindings of the services; src/components/ UI; src/i18n/ strings (en, uk); src/config/ map styles, Sentry, distribution
modules/vehicle-link/    Expo module (Swift, Kotlin): BLE + EA (MFi) on iOS, BLE + Classic SPP on Android; config plugin for permissions
modules/sensor-capture/  Expo module (Swift, Kotlin): GNSS and IMU capture, batched; the Android trip foreground service
modules/audio-output/    Expo module (Swift, Kotlin): where the phone plays audio, the system output picker, play on the speaker
modules/app-notice/      Expo module (Kotlin): Android's local "update ready" notification (UPDATES-SPEC §5.2)
native-tests/            XCTest for the modules' Foundation-only Swift logic (Package.swift at the root)
native-tests-android/    JUnit for the modules' plain-Kotlin logic
tools/replay/            replay CLI, viewer, benchmarks, route tools over src/nav/replay (Node)
tools/tiles/             build pipeline: vector tiles, road graph, search index, map releases
tools/triplog/           Python: ULog trip log reader, CSV/Parquet export, plots, checks; logs/ (git-ignored); log sync and tester codes
tools/can/               opendbc submodule and the CAN profile generator
tools/voice/             records the spoken maneuvers (ROUTING-SPEC §8.5)
tools/ota/               signed OTA JS updates from an `expo export`; uploads of builds and maps (OTA.md)
workers/triplog-upload/  Cloudflare Worker for the opt-in log upload (TRIP-LOGGER-SPEC §7.1)
workers/app-updates/     Cloudflare Worker serving JS updates, native builds, the AltStore source and maps (OTA.md)
scripts/                 emulator smoke test and UI sweep, store screenshots, keystore and site media helpers
site/, wiki/             the website (https://wtf-ai.uk) and the GitHub wiki sources
```

## 5. Status and roadmap

Built and field-tested: the vehicle link (MFi and BLE on iOS, a Classic adapter on Android), trip logging, the
navigator with integrity and online calibration, map matching with the closed loop, routing with voice guidance and
alternatives, address search, offline maps and updates, the guide, the Android build, CAN wheel speeds (Stage 2)
and turns from the wheels (on by default). Field data: two test cars and a few testers' cars, one iPhone and testers'
Android phones.

Not built: CAN yaw rate (Stage 3: a parking-lot drive with unfiltered CAN logging, regression of every candidate field
against the gyro's vertical yaw rate), waking the app when the car starts (VEHICLE-LINK-SPEC §11), a logged drive with
real spoofing (integrity is tuned on simulated spoofs), App Store and Google Play submission (STORE-REVIEW.md).

## 6. Conventions for agents

- Follow [AGENTS.md](../AGENTS.md) (Expo rules, `npx expo install`, no hand-editing `ios/`/`android/`).
- `src/nav/**`, `src/obd/**` and `src/triplog/**` stay pure TypeScript with no React Native / Expo imports.
- Native modules stay thin: I/O and bridging only. Non-trivial Swift logic goes in `modules/*/ios/Logic/`
  (Foundation only, XCTest in `native-tests/`); Android-free Kotlin in `modules/*/android/**/logic/` (JUnit in
  `native-tests-android/`). Payloads use the iOS conventions, so the TypeScript is the same on both platforms. The JS
  side of each module is tested in Jest with the native module mocked.
- Batch high-rate data across the bridge (IMU samples, CAN frames); never one event per sample.
- Units: SI (m, s, rad, m/s). Convert at boundaries. Exception: engine speed in rev/min, the unit in the field name.
- Time base: every sensor, adapter and log timestamp is monotonic uptime in µs. Wall clock only through explicit
  sync records.
- Navigator tuning lives in the library defaults (`DEFAULT_NAV_CONFIG`, `DEFAULT_MAP_MATCH`): the app ships no
  setting other than the defaults, so a replay runs what the app runs. Change the default, never add an app-only
  override.
- A navigator or map-matching change is judged with `npm run replay:regress` (every drive, several filter seeds,
  parked and drawn starts) and `replay:incidents` on the simulated drives, never on one drive or one seed.
- Minimize native changes: each needs a CI macOS build and a re-sideload.
- Before declaring done: `npx expo lint`, `npx tsc --noEmit`, `npx jest` (plus the Python, Swift or Kotlin tests
  when touched).

## 7. Out of scope (v1)

Google Maps; live traffic (none is open for Ukraine); raw GNSS analysis; slow drag-off spoofing detection; Wi-Fi
ELM327 adapters; magnetometer heading for navigation; Classic Bluetooth without MFi on iOS (impossible); lane-level
accuracy; cloud services beyond Sentry, the update Worker and the opt-in trip log upload; feeding corrected location to
other apps; cross-region routing.

## 8. Risks and open items

1. **ELM327 clone quality**: slow clones, no response-count suffix. Measure per adapter; the tested-adapter table is
   VEHICLE-LINK-SPEC §13.
2. **OBD speed quality**: 1 km/h resolution, zero cutoff at low speed, unsigned (reverse reads 0 on the main test car,
   positive on others: NAVIGATOR-SPEC §5.2). CAN wheel speeds and gear remove this where available.
3. **Heading at outage start** (~2° RMS) limits dead reckoning more than gyro drift does; the road heading from map
   matching is the correction.
4. **MFi for the App Store**: each declared protocol string needs the vendor's authorization (STORE-REVIEW §3.2).
5. **Auto-wake** of a non-running app: on iOS by the location session and Bluetooth state restoration after the OS
   ended the app, and with the opt-in for location "Always" by significant location changes for a drive the app wasn't
   opened for (TRIP-LOGGER-SPEC §4.3, VEHICLE-LINK-SPEC §11), untested on a drive; not after a swipe. Android
   12+: by a companion device the driver picked once (the car's Bluetooth, a BLE adapter), untested on a phone; a
   woken trip has GNSS with location "all the time", else after a tap on the notification or opening the app.
6. **Particle filter CPU on the phone**: ~8 ms per update at 500 particles on the test iPhone against a 5 ms budget;
   smooth at 2–3 updates a second, spikes can drop frames (MAPMATCH-SPEC §14).
7. **Routing time on the phone**: A\* in slices on the JS thread; long routes fall back to a stronger heuristic.
8. **OSM completeness**: missing roads and wrong tags. Mitigated by off-road particles and soft restriction factors.
9. **Tuning from one phone**: all navigator tuning comes from one iPhone, one mount and one car; testers' logs
   check it (NAVIGATOR-SPEC §11).
10. **Sentry** needs the `SENTRY_DSN` variable and, for readable stack traces, the source map upload secrets
    (README → Configuration).
