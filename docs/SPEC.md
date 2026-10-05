# wtf.ai — Spoofing-Resilient Car Navigator: High-Level Specification

Status: draft v8 (2026-10-04). Source of truth for coding agents. Update this file when decisions change.

Companion specs: [UI-SPEC.md](UI-SPEC.md) (UI-first milestone), [VEHICLE-LINK-SPEC.md](VEHICLE-LINK-SPEC.md) (Bluetooth ELM327 communication), [TRIP-LOGGER-SPEC.md](TRIP-LOGGER-SPEC.md) (trip detection, logging, export — Phase 1), [NAVIGATOR-SPEC.md](NAVIGATOR-SPEC.md) (Stage 1 EKF, online calibration, replay — Phase 2), [MAPMATCH-SPEC.md](MAPMATCH-SPEC.md) (road graph, particle filter — Phase 5), [ROUTING-SPEC.md](ROUTING-SPEC.md) (A\* routing on the road graph — Phase 6), [SEARCH-SPEC.md](SEARCH-SPEC.md) (offline address search — Phase 6).

## 1. Problem & goal

**wtf.ai** stands for **"Where the f\* am I?"** The name captures the app's central purpose: helping drivers understand their position when GNSS cannot be trusted. The native launch splash displays the full name.

During air raids in Ukraine, GNSS is jammed or spoofed (fixes jump to wrong places, often outside Ukraine). The app keeps a trustworthy vehicle position by fusing the last trusted GNSS fix with vehicle odometry in an EKF, locating the vehicle on the offline road network with a map-constrained particle filter, and provides offline routing.

Odometry is built up in stages (§2.1). Stage 1 uses the minimum that works on almost any car: vehicle speed from standard OBD-II over plain ELM327 commands, and heading rate from the phone gyro. Later stages add CAN wheel speeds and CAN yaw rate.

## 2. Fixed decisions

| Topic                       | Decision                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform                    | **iOS first**. Android is nice-to-have later (no test device).                                                                                                                                                            |
| Dev environment             | Windows only, no Mac, **no paid Apple Developer account**. iOS builds: **GitHub Actions** macOS runner, `expo prebuild` + `xcodebuild` with signing disabled → unsigned IPA, sideloaded with **AltStore** (free Apple ID, 7-day refresh). **No EAS** (Build/Submit/Update). CI runs checks, and this build when needed ([CI.md](CI.md), §6). |
| Framework                   | Expo SDK 57, Expo Router, TypeScript. Dev builds only (no Expo Go).                                                                                                                                                       |
| Odometry roadmap            | **Staged** (§2.1): Stage 1 OBD-II speed + phone gyro → Stage 2 CAN wheel speeds → Stage 3 CAN yaw rate. Each stage is a drop-in odometry source; the EKF, integrity, and map matching don't change between stages.           |
| Adapter protocol            | Stage 1: **plain ELM327 command subset only** (§3.1), for broad dongle compatibility. No STN/OBDLink-specific commands until Stage 2.                                                                                        |
| Adapter transport           | From Phase 1, both: **BLE** (CoreBluetooth, no MFi — any Bluetooth 4.0+ LE ELM327 adapter, including no-name clones) and **MFi Classic Bluetooth** over `ExternalAccessory` (OBDLink MX+, the dev adapter on hand). The ELM327 layer is transport-agnostic. See [VEHICLE-LINK-SPEC.md](VEHICLE-LINK-SPEC.md). |
| Trip log format             | **ULog** (PX4), written by a pure-TS encoder; read on PC with Python (`pyulog`-based `tools/triplog`). See [TRIP-LOGGER-SPEC.md](TRIP-LOGGER-SPEC.md).                                                                       |
| Sensor capture              | Own native module `modules/sensor-capture` (CoreLocation + CoreMotion, batched) for logging, estimation and the map's position, sharing one monotonic clock with the adapter timestamps. `expo-location` is used only for permissions and the walking compass (its position watcher stopped for good after jamming). |
| First vehicle               | **Mazda CX-5 KF (2017–2021)**.                                                                                                                                                                                            |
| Map display                 | **MapLibre** (`@maplibre/maplibre-react-native`) with **offline** OSM vector tiles. Not Google Maps.                                                                                                                      |
| Routing                     | **A\* in TS on our own road graph** (`src/nav/routing/`, the map-matching graph of §3.8), see [ROUTING-SPEC.md](ROUTING-SPEC.md). Valhalla dropped (2026-10-05): its native packaging was never solved, its tiles were a second download, and its roads differed from the filter's. |
| Map matching                | **Custom road-constrained particle filter** in TS (`src/nav/mapmatch/`) over **our own compact road graph** (§3.8). Valhalla `trace_attributes` is **not** used: its HMM assumes independent, bounded GNSS-like errors, while DR error is correlated and grows, so it locks onto parallel roads and returns a single answer. |
| Estimator location          | **TypeScript** (`src/nav/`), not native. Reason: Windows-only dev; logic must hot-reload and be unit-testable/replayable on Windows. Native code stays thin.                                                              |
| GNSS integrity              | Only two checks: **outside-Ukraine polygon** and **teleport vs odometry/DR**. Do **not** use raw GNSS data. Do **not** implement slow drag-off detection.                                                                 |
| Yaw source                  | Stage 1: **phone gyro** projected onto gravity. Stage 2: rear wheel-speed differential. Stage 3: **CAN yaw rate** (to be reverse-engineered; not in opendbc).                                                            |
| Absolute heading            | From trusted GNSS course, particle-filter road heading, manual fix, and the pose persisted at ignition off. **The magnetometer is not used** for navigation: in-car distortion (body steel, wiring, mount) changes when the phone moves. Exceptions: a display-only compass beam on the map when walking (UI-SPEC §6.1); the raw magnetometer is logged (TRIP-LOGGER-SPEC §5.2). Measured on 7 drives (NAVIGATOR-SPEC §7.5): calibrated on other drives, median error 4–18°, always < 90°; re-seating the phone costs 15–20°. **In replay only:** a calibrated compass weighs the travel directions at a jammed map-matching start (at most 6.7:1), only while its calibration was confirmed on the drive that kept it; a wrong one can still cause a wrong start (MAPMATCH-SPEC §8.2, NAVIGATOR-SPEC §7.6). In the app in **shadow mode**: computed, checked and logged on real drives (one calibration per car and phone mounting), never navigated with, until the logs show how often a stored calibration is wrong (NAVIGATOR-SPEC §7.6). |
| Phone mount                 | Stage 1 requires a **rigid phone mount** (the gyro is the only yaw source).                                                                                                                                               |
| Standstill bias calibration | **2–3 s**, refined at every stop (ZUPT). No dedicated long standstill step.                                                                                                                                               |
| Distribution                | Sideloading via AltStore now. App Store later needs a paid Apple Developer account; then BLE needs nothing more, MFi adapters need the vendors' authorizations (see §9).                                                    |
| Privacy                     | All data stays on device. No position upload; trip logs exported only by explicit user action. **One exception: Sentry crash/error reports and logs** (EU region, all builds with `environment` = development/production, no PII, no replay/screenshots; coordinates and VINs scrubbed from events, breadcrumbs and logs in `src/config/sentry-scrub.ts`). |

### 2.1 Odometry stages

| Stage | Speed source                                                   | Yaw source                                  | Adapter features                          | Vehicle-specific data              |
| ----- | -------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------- | ---------------------------------- |
| 1     | OBD-II Mode 01 PID `0D` (1 km/h resolution), polled, unsigned  | Phone gyro `ω = gyro · ĝ`                   | ELM327 subset, request/response           | None (works on any OBD-II car)     |
| 2     | CAN wheel speeds (0.01 km/h, ~50 Hz), signed by CAN gear       | Rear wheel differential, gyro as cross-check | STN passive CAN monitor + pass filters    | JSON vehicle profile (opendbc)     |
| 3     | As Stage 2                                                     | CAN yaw rate (reverse-engineered)           | As Stage 2                                | Profile + RE yaw signal            |

- Stage 1 is the permanent fallback: cars with a CAN gateway firewall, unknown makes/models, and generic dongles stay on it.
- Stage selection is automatic per vehicle: the highest stage whose requirements are met (adapter supports monitoring, profile exists for the VIN, signals are visible at the OBD port).
- An ELM327-class adapter can't poll PIDs and passively monitor CAN at the same time. Stage 2+ takes speed from the wheel-speed frames and doesn't poll.

## 3. Architecture

```
Adapter ──BLE / EA──▶ modules/vehicle-link (Swift, thin: transport + timestamps)
                         │ Stage 1: ELM327 request/response with tx/rx timestamps
                         │ Stage 2+: batched raw CAN frames (50–100 ms)
                         ▼
                       src/obd (TS: ELM327 session, probe, PID parsing, poller, engine state)
                         │  VehicleLink contract (VEHICLE-LINK-SPEC §6)
                         ▼
CoreLocation + CoreMotion ───▶ src/nav (TypeScript)
(modules/sensor-capture,           ├─ odometry         (OdometrySource: speed + yaw rate per stage)
 batched)                          │    ├─ obd        (OBD speed samples → odometry)       Stage 1
                                   │    ├─ imu        (gyro · ĝ, handling detection)      Stage 1+
                                   │    └─ can        (JSON vehicle profiles, decoder)    Stage 2+
                                   ├─ integrity        (GNSS trust state machine)
                                   ├─ ekf              (dead reckoning + updates)
                                   ├─ calibration      (initial + online)
                                   ├─ mapmatch         (particle filter on road graph)
                                   │    └─ RoadGraph interface ◀─ graph tiles (device: file/SQLite reader; replay: Node fs)
                                   └─ routing          (A* on the same road graph)
                                           │
                                           ▼
                                 src/app screens (MapLibre, routing, wizard)
```

### 3.1 Vehicle link: `modules/vehicle-link` (Swift) + `src/obd` (TS)

Full specification: [VEHICLE-LINK-SPEC.md](VEHICLE-LINK-SPEC.md). Summary:

- **Native** (`modules/vehicle-link`), responsibilities only: BLE scan, list/pair MFi accessories, connect/reconnect, write bytes, frame on the ELM `>` prompt, timestamp with the monotonic clock. No protocol logic.
- **Transports**: **BLE** (CoreBluetooth; serial-over-GATT profiles `FFF0`, `FFE0`, `18F0`, ISSC, Nordic UART, … plus a heuristic, kept in a TS table so adding an adapter needs no native build) and **MFi** (`ExternalAccessory`; protocol strings in `UISupportedExternalAccessoryProtocols` via config plugin: `com.obdlink` for OBDLink MX+, `com.vgatemall` for Vgate vLinker FS/MS). Wi-Fi ELM327 is not planned.
- **TS** (`src/obd`, pure): discovery ranking, ELM327 verification probe on connect, session init, speed/RPM poller, engine/ignition state. Apps use only the `VehicleLink` contract.
- **Stage 1 API**: `transact(command) → { raw, txUs, rxUs }`, one in flight. The poll loop runs in TS; native timestamps keep timing accurate despite bridge jitter. A speed sample is timestamped at `(txUs + rxUs) / 2`. If bridge overhead limits the poll rate, add a native repeat mode as an optimization.

**Stage 1 ELM327 command subset** (ELM327 v1.3-level; avoid anything clones commonly lack)

- Probe: `ATZ` (or `ATWS`), `ATE0`, `ATI`, `AT@1`, `ATRV`; `STI` for read-only chip identification (no STN features in Stage 1).
- Init: `ATE0`, `ATL0`, `ATS0`, `ATH1` (while identifying ECUs), `ATAT1`, `ATSP0` + `0100` (auto-detect), `ATDPN`, then `ATSPn` (lock it). On 11-bit CAN, pin the speed ECU with `ATSH`/`ATCRA` (physical addressing); then `ATH0`.
- Speed poll: `010D1`, back-to-back. The trailing `1` is the expected response count, so the adapter answers without waiting out its timeout. If the adapter rejects it (`?`) or doesn't speed up, fall back to `010D`. `ATAT2` kept if it helps.
- RPM: `010C` every 5 s while the engine runs (engine on/off for trip detection), every 2 s while the ECU is awake with the engine stopped, and as a 5 s ignition probe while the ECU is silent.
- VIN: `0902` (per-VIN calibration storage; fall back to an adapter ID if unsupported).
- Supported-PID probe: `0100`/`0120`/…; if PID `A4` (transmission actual gear) is supported, poll it at a low rate to sign speed in reverse.
- Ignition-off detection: no valid response for ≥ 10 s (`NO DATA` / `UNABLE TO CONNECT` / bus errors); `ATRV` logged every 30 s as a hint.

**Stage 2+ (STN)**

- Reset, select protocol/bus (HS-CAN 500 kbps), set **pass filters** for required IDs only, start monitor mode. Unfiltered mode only for the logger/RE workflow.
- Batch frames to JS every 50–100 ms. Ignition-off detection: CAN silence timeout.

### 3.2 Odometry sources (`src/nav/odometry/`)

A common `OdometrySource` interface feeds the EKF with timestamped speed and yaw-rate samples, each carrying its variance and validity. The EKF doesn't know which stage produced them.

#### Stage 1: OBD speed (`odometry/obd/`)

- Parses PID `0D` (km/h, integer) → m/s. Unsigned. Forward is assumed unless PID `A4` reports reverse.
- Measurement noise covers 1 km/h quantization, possible truncation bias (§9), and poll-timing latency.
- Some ECUs report 0 below ~2–3 km/h. Standstill therefore also requires a quiet IMU (§3.6).
- CX-5 KF: PID `0D` reads about 2 % below GNSS speed; `k_s` absorbs it.

#### Stage 1+: phone IMU (`odometry/imu/`)

- Vertical yaw rate `ω = gyro · ĝ` (independent of how the phone is mounted), from CoreMotion `CMDeviceMotion` (`xArbitraryZVertical`, no magnetometer) at 100 Hz via `modules/sensor-capture`, batched (TRIP-LOGGER-SPEC §5.2).
- **Handling detection**: mark gyro samples invalid when the gravity direction in the phone frame changes (phone moved on/in the mount) or the phone rotates fast about a horizontal axis (NAVIGATOR-SPEC §5.1). In Stage 2+, also when the gyro disagrees with the wheel yaw. During invalid windows the EKF propagates heading without a yaw input and with inflated covariance; at standstill (OBD 0) the heading is held instead.

#### Stage 2+: vehicle profiles (`odometry/can/`)

- JSON profiles derived from opendbc (MIT) subset + our reverse-engineered signals. No DBC parsing on device.
- Profile fields: bus, CAN IDs, signals (start bit, length, endianness, signedness, scale, offset), track width, wheelbase, default wheel scale.

##### Mazda CX-5 KF — known signals (opendbc `mazda_2017.dbc`, HS-CAN pins 6/14)

| ID (hex / dec) | Message        | Signals                                                                                         |
| -------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| 0x215 / 533    | `WHEEL_SPEEDS` | FL `7\|16@0+`, FR `23\|16@0+`, RL `39\|16@0+`, RR `55\|16@0+`; scale 0.01, offset −100, km/h    |
| 0x228 / 552    | `GEAR`         | `GEAR 2\|3@0+`: 0 shifting, 1 P, 2 R, 3 N, 4 D                                                  |
| 0x082 / 130    | `STEER`        | `STEER_ANGLE 23\|16@0+` scale 0.05, offset −1600, deg                                           |
| 0x078 / 120    | `BRAKE`        | `VEHICLE_ACC_X 5\|13@0+` (0.01, −40) m/s²; `VEHICLE_ACC_Y 8\|13@0+` (0.001, −4.096) m/s²        |
| 0x202 / 514    | `ENGINE_DATA`  | `SPEED 23\|16@0+` scale 0.01 km/h                                                               |
| ?              | yaw rate       | **Unknown — reverse-engineer (Phase 9, Stage 3).** Likely near 0x078 (stability-control sensor cluster). |

- Wheel speeds are unsigned → direction from `GEAR` (R = negative).
- MS-CAN (pins 3/11, 125 kbps) is a fallback bus if chassis frames aren't on HS-CAN at the OBD port.

### 3.3 GNSS integrity (`src/nav/integrity/`)

States: `TRUSTED` → `UNTRUSTED` → `REACQUIRING` → `TRUSTED`.

1. **Outside Ukraine**: bundled simplified border polygon with small buffer; any fix outside → reject, go `UNTRUSTED`.
2. **Teleport**: reject if
   - distance(fix, DR position) > k·σ of DR position uncertainty (+ reported fix accuracy), or
   - fix-to-fix displacement inconsistent with odometry distance over the same interval (+ margin).
   - DR uncertainty = particle-filter posterior (all clusters) when map matching is active, else EKF covariance. A fix is consistent if it is within k·σ of *any* cluster.
3. **Re-acceptance**: N consecutive fixes consistent with DR (within k·σ) → `TRUSTED`.
4. **Startup**: last pose persisted at ignition off; first fix of new session is checked for teleport against it (odometry distance since = 0 until driving). Stage 1: NAVIGATOR-SPEC §6.1.
5. **Jamming:** iOS falls back to Wi-Fi/cell positions. They have no speed, claim ±7 m … 150 km, and are often
   repeated.
   - They are not GNSS: they never make the state `TRUSTED`.
   - The EKF still uses them at their reported accuracy (NAVIGATOR-SPEC §6). They stayed honest in real jammed
     drives, and spoofing doesn't move them.
   - A fix is a satellite fix when it has a speed. Accuracy alone can't tell the two kinds apart.

- Out of scope: raw GNSS (C/N0, AGC), slow drag-off detection.
- Until this module exists, the map's trust comes from the interim `GnssTrustTracker` (NAVIGATOR-SPEC §8).

### 3.4 EKF (`src/nav/ekf/`)

- Frame: local ENU tangent plane, re-anchored periodically; convert to/from WGS84 at boundaries.
- State: `E, N, ψ (heading), v, k_s (speed scale), b_ω (yaw bias), k_ω (yaw scale)`; plus `r_LR` (left/right wheel radius ratio) in Stage 2 while using wheel-differential yaw.
- Predict: unicycle/CTRV model.
  - Stage 1: driven by the phone yaw rate at the IMU rate (~50–100 Hz); `v` is a random walk (acceleration process noise), corrected by speed updates.
  - Stage 2+: ~50 Hz on CAN data; speed = mean rear wheel speed × `k_s`, signed by gear.
- Updates:
  - Stage 1 speed: `v = k_s · s_OBD` at the poll rate (expected ~5–20 Hz depending on adapter).
  - Satellite GNSS position (+ course when speed is sufficient) — **only when `TRUSTED`**. Until integrity exists,
    every fix goes through the EKF innovation gate instead.
  - Coarse Wi-Fi/cell positions in any trust state, at their reported accuracy (§3.3 item 5).
  - Fix comparisons are lag-corrected. CoreLocation's lag behind the gyro/OBD is measured online from turns
    (NAVIGATOR-SPEC §7.3): −0.1 ± 0.1 s on an iPhone 13.
  - ZUPT at standstill: `v = 0`, measured yaw = bias.
  - Map-match pseudo-measurement from the particle filter (§3.7): position + road heading, **only when the posterior is unimodal**; covariance from cluster spread. In Stage 1 this is the main correction for gyro heading drift during long outages.
  - Manual fix (user long-press on map, heading snapped to road).
- Before the heading is known, the position is anchored at the best fix, with a radius that grows by the distance
  driven. The heading comes from a GNSS course or, under jamming, from fitting the OBD + gyro track to coarse fixes
  (NAVIGATOR-SPEC §4, §6).
- Standstill holds the heading and learns the gyro bias (NAVIGATOR-SPEC §5.1, §7.1).
- Outputs to the particle filter: calibrated odometry increments `Δs`, `Δψ` with their variances, plus current `ψ` and its variance.
- Pure TS, deterministic, no RN imports → unit-testable and replayable in Node/Bun on Windows.

### 3.5 Yaw sources (priority order among those available)

1. CAN yaw rate (Stage 3).
2. Rear wheel differential: `ω = (v_RR − v_RL) / track_width`, with `r_LR` calibrated (Stage 2).
3. Phone gyro projected onto gravity: `ω = gyro · ĝ` (Stage 1 primary; fallback and cross-check in Stage 2+). Handling detection per §3.2.

### 3.6 Calibration (`src/nav/calibration/`)

- **Standstill**:
  - Stage 1: PID `0D` = 0 AND gyro/accel variance below threshold → average yaw for 2–3 s for bias.
  - Stage 2+: all 4 wheel speeds = 0 AND (gear P OR brake).
  - Recursive refinement at every stop.
- **Initial drive (first run per VIN)**: ~1–3 min with `TRUSTED` GNSS, including a straight segment (~300 m) and several turns → `k_s`, `k_ω`, `b_ω`, speed latency offset; plus `r_LR` in Stage 2. Skippable → defaults + "low accuracy" badge.
- **Online**: EKF continues estimating parameters while `TRUSTED`. Persist per VIN (and per phone mount for `k_ω`).
  Also the GNSS position lag, measured from turns and persisted per phone (NAVIGATOR-SPEC §7).
- Implemented online today: gyro bias at stops, `k_s`, `k_ω` and the GNSS lag. The learned `k_ω` is a timing
  artifact (NAVIGATOR-SPEC §7.2). Persisted: `k_s` per VIN and the GNSS lag per phone model + iOS version
  (NAVIGATOR-SPEC §7.4). The pose at ignition off starts the next session (NAVIGATOR-SPEC §6.1). Not yet: the initial-drive wizard.

### 3.7 Map matching — road-constrained particle filter (`src/nav/mapmatch/`)

Detailed in [MAPMATCH-SPEC.md](MAPMATCH-SPEC.md). Reference approach: Gustafsson et al., "Particle filters for positioning, navigation, and tracking", IEEE Trans. Signal Processing, 2002 (car positioning from wheel speeds + road map, no GNSS).

**Roles**

- EKF (§3.4) = odometry and calibration. It supplies calibrated increments `Δs`, `Δψ`.
- Particle filter (PF) = position on the road network. During outages its output is the navigation position.
- Pure TS. Graph access only through a `RoadGraph` interface (edges near a point, edge geometry, outgoing edges with restrictions), so the same code runs on device and in the replay harness.

**Particles**

- On-road: `edgeId`, offset along edge (m), travel direction, per-particle distance-scale perturbation `δk_s`.
- Off-road (small fixed share): free `E, N, ψ`. Covers parking lots, fuel stations, roads missing from OSM.

**Propagate** — every ~1–2 m travelled or at 5–10 Hz; frozen at standstill.

- On-road: advance by `Δs · (1 + δk_s)` + noise. At the edge end, branch into allowed outgoing edges (one-way, turn restrictions, no U-turn except at dead ends), sampled by how well the junction turn angle matches the measured `Δψ`.
- Off-road: unicycle step with `Δs`, `Δψ` + noise.

**Weight**

- **Relative heading (primary)**: measured `Δψ` over a sliding window (~20–50 m) vs the road-geometry heading change along the particle's path. Uses heading *changes*, so slow gyro drift doesn't hurt.
- **Absolute heading (weak)**: EKF `ψ` vs road heading, using the EKF `ψ` variance.
- **GNSS position** — only when `TRUSTED`. The PF keeps running with GNSS so it is already locked when an outage starts.
- **Off-road penalty**: small constant likelihood penalty for off-road particles.

**Resample**: systematic, when effective sample size < N/2. Keep the minimum off-road share. Re-inject a small fraction of particles near the current clusters to recover from depletion.

**Output**

- Cluster the posterior (by graph connectivity / distance).
- **Unimodal** (one cluster holds ≳ 90% of the weight and its spread is below a threshold): position + road heading → EKF pseudo-measurement and map puck.
- **Multimodal**: no EKF update. The UI shows the dominant hypothesis and marks the alternatives. Integrity uses the full spread (§3.3).
- **On-road weight collapses**: off-road mode (free DR) until particles re-lock onto the graph.

**Initialization**: around the last trusted GNSS fix, the pose persisted at startup, or a manual fix. Spread over edges within k·σ, with direction consistent with heading. Under jamming with no heading yet: over all edges near the anchored position, both directions; the PF can then start the EKF with the road heading (MAPMATCH-SPEC §8).

**Budget**: ~300–1000 particles; target < 5 ms per update on iPhone on the JS thread (measure in replay and on device).

### 3.8 Offline data (`tools/tiles/`)

- Source: Geofabrik Ukraine PBF.
- Outputs:
  1. (Dropped 2026-10-05: Valhalla routing tiles. Routing runs on item 3, ROUTING-SPEC.)
  2. Vector map tiles (PMTiles/MBTiles) + MapLibre style.
  3. **Road graph for map matching and routing**: drivable OSM ways (no footway/path/cycleway/steps; `service`/`private` kept but flagged), split at intersections. Per edge: simplified polyline (≤ ~1 m deviation), length, road class, one-way, connectivity, turn restrictions (OSM relations). One file per region (`<region>.graph.bin`, `ukraine` included; no cross-region navigation), tiled internally at z14 with a directory and per-tile spatial lists, read by random access: the device decodes only tiles around the active hypotheses, so the Ukraine graph costs about what an oblast's does. Built with pyosmium. Size to be measured in Phase 0. Format: MAPMATCH-SPEC §4.
- Hosted as versioned, checksummed downloads. In-app download manager: resumable, checksum-verified, update check.

### 3.9 App (`src/app/`, Expo Router)

UI-first milestone (map with live GNSS + mock screens): see [UI-SPEC.md](UI-SPEC.md). Phase 1 makes `vehicle` and `debug` real and adds dev-only `trips` and `debug-terminal` routes: see [TRIP-LOGGER-SPEC.md](TRIP-LOGGER-SPEC.md) §9.

- Native launch splash — displays `wtf.ai` and **"Where the f\* am I?"**.
- `index` — map. Today it shows the Stage 1 navigator (NAVIGATOR-SPEC §9), or phone GNSS from `modules/sensor-capture` without an OBD adapter, with the interim trust tracker. Target: fused position puck + uncertainty circle (dominant hypothesis), alternative map-match hypotheses as secondary markers when ambiguous, raw GNSS ghost marker, trust badge (`GPS OK` / `UNTRUSTED` / `REACQUIRING`), time & distance since last trusted fix, adapter status.
- `onboarding` — first-run flow (welcome, location permission, adapter, calibration).
- `more` — sheet linking Offline data, Calibration, Diagnostics, Settings.
- `calibration` — first-run wizard.
- `vehicle` — adapter discovery list and connection (transport, ELM version, protocol, poll rate), VIN, engine state, active odometry stage.
- `downloads` — offline data manager.
- `route` — offline routing (A\* on the road graph, ROUTING-SPEC), reroute on deviation, next maneuver + distance.
- `debug` — live signals, EKF state, particle cloud overlay + cluster weights, trip recorder controls; `debug-terminal` (ELM terminal); `trips` (log list, share, delete).
- Background (from Phase 1): iOS `UIBackgroundModes` = `location`, plus `external-accessory` (EA) and `bluetooth-central` (BLE) (config plugins, never hand-edit `ios/`). Location stays **When In Use**: a session started in the foreground continues in the background. "Always" is needed only for the later auto-wake (VEHICLE-LINK-SPEC §11).

### 3.10 Logging & replay (`tools/replay/`)

- On-device trip logger ([TRIP-LOGGER-SPEC.md](TRIP-LOGGER-SPEC.md)): automatic per-trip **ULog** files, monotonic uptime µs timestamps, export via share sheet / Files app, Python reader `tools/triplog`.
  - Stage 1: every OBD poll (raw bytes, status, tx/rx timing), the text ELM327 transcript for all other exchanges, CoreLocation fixes with accuracies, phone IMU (`CMDeviceMotion` 100 Hz; raw gyro/accel optional), raw magnetometer (20 Hz), engine state and trip events.
  - Stage 2+: raw CAN frames in addition (new ULog message; the format is self-describing, so this is additive).
- Replay harness: `src/nav/replay` (pure TS: merge streams, run the navigator, score fixes and outages, GeoJSON) + `tools/replay` (`npm run replay` CLI, `replay:view` browser viewer, `replay:bench` outage benchmark; Node 24 type stripping; see its README and NAVIGATOR-SPEC §10). Logs are read by `src/triplog/trip-log-reader.ts`. Simulated outages by cutting GNSS in clean logs (`--cut`, `--open-loop`); offsetting for spoofing is still to do.
- Real logs live in `tools/triplog/logs/`, git-ignored because they hold the VIN and GPS tracks.
- Map-matching metrics: wrong-road rate (share of time the dominant cluster is on a different edge than the GNSS ground truth), time to re-lock after an ambiguity, time spent multimodal, PF update time.
- Stage comparison: Stage 2 logs can be degraded to Stage 1 inputs (wheel speed → quantized to 1 km/h, resampled at the measured PID rate; yaw → phone gyro) to compare stages on the same drive.

## 4. Repository layout (target)

```
src/app/                 Expo Router screens only
src/nav/                 pure TS core (no React Native imports)
  odometry/{obd,imu,can}/ ekf/ integrity/ calibration/ mapmatch/ routing/ geo/ replay/
  navigator.ts           Stage 1 sensor fusion entry point (live services and replay feed it)
src/obd/                 pure TS: adapter catalog, ELM327 session/probe/parser, PIDs, poller, engine state, emulator
src/triplog/             pure TS: ULog encoder (+ reader for replay), trip log schemas
src/services/            RN glue: position, vehicle-link, sensor-capture, trip-recorder
src/components/          UI components
modules/vehicle-link/    Expo module (Swift) — BLE + EA (MFi) transports; STN monitor in Stage 2
modules/sensor-capture/  Expo module (Swift) — CoreLocation + CoreMotion capture, batched
assets/profiles/         vehicle JSON profiles (Stage 2+)
assets/geo/              Ukraine border polygon
tools/re-yaw/            yaw reverse-engineering script (Stage 3)
tools/replay/            replay CLI, viewer and benchmark over src/nav/replay; loads the road graph via Node fs later
tools/tiles/             build pipeline: vector tiles, road graph
tools/triplog/           Python: ULog trip log reader, CSV/Parquet export, plots, checks; logs/ (git-ignored)
```

## 5. Phases

### Stage 1 — minimum viable odometry

| #   | Phase                       | Depends on | Key output                                                                                                                                                                                               |
| --- | --------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Setup & spikes              | —          | CI unsigned build sideloaded with AltStore on iPhone; MX+ EA + one BLE clone connect, ELM327 init + `010D1` poll rate measured on CX-5 (MX+ EA session over `com.obdlink` verified); DeviceMotion rate measured; ~~valhalla-mobile inside Expo module~~ (dropped, ROUTING-SPEC); MapLibre offline tiles; Ukraine road graph built, size and tile-load time measured |
| 1   | Trip logger                 | 0          | [TRIP-LOGGER-SPEC.md](TRIP-LOGGER-SPEC.md): BLE + MFi vehicle link, adapter verification, speed/RPM poller, automatic trip start/end, ULog trip logs (OBD + GNSS + IMU) exportable, Python reader, dev UI |
| 2   | TS EKF + replay             | 1          | `src/nav/odometry` (obd, imu), `src/nav/ekf`, replay metrics                                                                                                                                             |
| 3   | Integrity                   | 2          | `src/nav/integrity`                                                                                                                                                                                      |
| 4   | Calibration                 | 2, 3       | wizard + online estimation, per-VIN storage                                                                                                                                                              |
| 5   | Map matching (particle filter) | 0, 2    | road-graph pipeline + `RoadGraph` reader (device + Node), `src/nav/mapmatch` PF, heading init from the map under jamming, EKF pseudo-measurements, replay map-matching metrics (§3.10); see MAPMATCH-SPEC §12 |
| 6   | App UI, routing, background | 2–5        | screens, download manager, routing ([ROUTING-SPEC.md](ROUTING-SPEC.md))|
| 7   | Field test (Stage 1)        | 6          | real outage drives; baseline DR error numbers                                                                                                                                                            |
| 7b  | Adapter coverage            | 1          | more BLE clones, OBDLink CX, vLinker; grow the GATT catalog and the tested-adapter list with measured poll rates (VEHICLE-LINK-SPEC §13)                                                                  |

Status (2026-10-05):

- **Phase 0:**
  - Done: CI unsigned build + AltStore, MX+ EA session over `com.obdlink`, `010D1` at ~27 Hz on the CX-5,
    DeviceMotion at 100 Hz, MapLibre offline tiles (per-region packs).
  - Road graph built (MAPMATCH-SPEC §4.7): Ukraine 452 MB, 4.3 M edges, 2–3 min and 2.9 GB to build; Chernihiv
    15 MB.
  - Open: a BLE clone. (valhalla-mobile dropped 2026-10-05: routing runs on the road graph, ROUTING-SPEC.)
- **Phase 1:** done and field-tested (14 drives, TRIP-LOGGER-SPEC §11).
- **Phase 2:** the navigator and replay are implemented. It drives the map through `NavigatorService` and saves its
  calibration. Field-tested on 7 drives (NAVIGATOR-SPEC §9.1): 26 m off after 2.7 km jammed throughout.
- **Phase 6 (routing):** built, not yet driven (ROUTING-SPEC §2): A\* on the road graph (city routes ≤ 0.1 s, oblast
  routes ≤ 1 s in Node), turn instructions, guidance that works without GPS (no false "off route" in 5.4 simulated
  hours), spoken maneuvers, long press → Route here, routes and guidance in trip logs and `replay:view`.
- **Phase 5:** in progress, measured on replay and simulation (MAPMATCH-SPEC §2): road graph, particle filter,
  heading init from the map under jamming, the closed loop (M6: road heading and position back into the EKF, the
  app's default). The app (M7) is built: graph download, map matching on the phone, the puck on the road while
  dead-reckoning, `nav_mapmatch` in trip logs; not yet driven with it.

### Stage 2 & 3 — vehicle-specific improvements

| #     | Phase                         | Depends on        | Key output                                                                                  |
| ----- | ----------------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| 8     | CAN wheel speeds (Stage 2)    | 7                 | STN monitor mode, `odometry/can` + Mazda profile, raw CAN in logger, wheel-differential yaw |
| 9     | Yaw RE (Stage 3)              | 8                 | CAN yaw signal in Mazda profile                                                             |
| 10    | Stage comparison field test   | 9                 | DR error per stage on the same drives (§3.10)                                               |
| later | App Store, Android            | BLE or MFi        | —                                                                                           |

### Phase 9 method (yaw RE)

1. Parking-lot drive: circles and figure-eights both directions, phone rigidly mounted, unfiltered CAN logging.
2. For every CAN ID and every candidate field (8–16 bits, signed/unsigned, both endianness): linear regression vs phone vertical yaw rate (`gyro · ĝ`), time-aligned.
3. Highest correlation → ID, bits, scale, sign, offset. Cross-check against wheel-differential yaw.

## 6. Conventions for agents

- Follow [AGENTS.md](../AGENTS.md) (Expo rules, `npx expo install`, no hand-editing `ios/`/`android/`).
- `src/nav/**`, `src/obd/**`, and `src/triplog/**` must stay pure TypeScript with no React Native / Expo imports.
- Native modules stay thin: I/O and bridging only; no estimation or protocol logic in Swift. Any non-trivial Swift logic goes in `modules/*/ios/Logic/` (Foundation only) with XCTest coverage in `native-tests/` (`Package.swift` at the repo root; CI runs `swift test` on Linux). The JS side of each module is tested in Jest with the native module mocked.
- Batch high-rate data across the native→JS bridge (IMU samples, CAN frames); never emit one event per CAN frame or IMU sample.
- Units internally: SI (m, s, rad, m/s, rad/s). Convert at boundaries. Exception: engine speed in rev/min, with the unit in the field name (`rpm`).
- Time base: every sensor/adapter/log timestamp is monotonic uptime in µs (`ProcessInfo.systemUptime`, the CoreMotion clock). Wall-clock time only through explicit sync records.
- Minimize native changes — each one needs a CI macOS build (~20–40 min) and a re-sideload. Never rely on EAS.
- CI (`.github/workflows/ci.yml`) runs lint, typecheck, Jest, `tools/triplog` pytest, `expo-doctor`, and the unsigned iOS build, each only when what it covers changed ([CI.md](CI.md)): native changes are always compiled, JS-only branch pushes get an IPA with `[build]` in the commit message. The macOS build is the only Swift compiler available: keep it green.
- Before declaring done: `npx expo lint`, `npx tsc --noEmit`, and unit tests for `src/nav`, `src/obd`, `src/triplog` (plus `tools/triplog` Python tests when touched).

## 7. Verification targets

### Stage 1

1. Phase 0: `010D1` poll rate on CX-5 via MX+ measured and reported (target ≥ 10 Hz); PID `0D` matches GNSS speed within 1 km/h at steady speed; VIN read via `0902`.
   - Result (2026-10-03): 25–29 Hz, p50 latency 16–18 ms. OBD reads about 2 % below GNSS (−0.3 … −0.8 km/h median).
   - The VIN was read in only 3 of 14 logs: `0902` went to the TCM when it was pinned for speed. Fixed
     (VEHICLE-LINK-SPEC §9.1).
2. Standstill: heading drift ≈ 0 while stopped after 2–3 s bias estimate.
3. Handling detection: picking up / re-seating the phone during a logged drive invalidates the gyro window; no heading step after re-seating.
4. Replay: GNSS cut for 1 / 5 / 15 min on clean logs — report DR error with and without map matching. Without map matching so far: median max error 11 / 20 / 37 m after 1 / 2 / 4 min (NAVIGATOR-SPEC §10). 5 / 15 min need longer clean drives.
5. Map matching: on replay with GNSS cut, report wrong-road rate and re-lock time (§3.10), including dedicated parallel-road and dense-grid segments; after an ambiguity the correct hypothesis must survive (never fully pruned) until a turn resolves it.
6. PF performance: update time within budget (§3.7) on iPhone with the target particle count.
7. Integrity: injected out-of-Ukraine fixes and teleports rejected within 1 fix; zero false rejections on clean logs.
8. CI green (checks + unsigned iOS build); the IPA sideloaded with AltStore installs and runs on iPhone.

### Stage 2 & 3

9. CX-5 wheel speeds and gear decode correctly (compare to GNSS speed / gear lever).
10. Yaw RE: candidate correlation > 0.98 vs phone vertical yaw, both turn directions.
11. Stage comparison: DR error for Stage 2 and 3 vs Stage 1 on the same logs (§3.10); each stage must not be worse than the previous.

## 8. Out of scope (v1)

Google Maps; Android; raw GNSS analysis; slow drag-off spoofing detection; Wi-Fi ELM327 adapters; magnetometer heading for navigation; STN/OBDLink-specific commands in Stage 1 (read-only `STI` identification excepted); Classic Bluetooth adapters without MFi on iOS (impossible); lane-level accuracy; any cloud services; feeding corrected location to other apps.

## 9. Risks & open items

1. **ELM327 clone quality**: many clones (fake "v2.1") are slow, lack the response-count suffix, or mis-handle timeouts → poll rate may drop to ~3–8 Hz. Measure per adapter; define a minimum usable rate; keep a tested-adapter list.
2. **OBD speed quality**: 1 km/h resolution; some ECUs truncate rather than round (small constant bias that `k_s` can't absorb; not the case on the CX-5, NAVIGATOR-SPEC §13.2); zero cutoff at low speed; unsigned, so reversing counts as forward unless PID `A4` is supported, or reads 0 (CX-5: the car turns in place in the model). ZUPT and map matching must absorb these.
3. **Gyro-only heading drift** in Stage 1 during long outages (residual bias ~0.01°/s ≈ 9° per 15 min). Depends on map matching and on a rigid mount; quantify in Phase 7.
   - Measured in replay (NAVIGATOR-SPEC §10): the gyro is fine (scale 1.007 over 13 turns, bias 0.007 °/s). DR is
     limited by about 2° of heading error at the start of an outage plus ±2–3 % along-track error, not by gyro
     drift.
4. **MFi for App Store** (EA adapters only): ad-hoc/dev builds only need the EA protocol strings in Info.plist. App Store (and likely external TestFlight) requires an MFi authorization from **each** vendor, referenced by PPID in the review information. Authorizations on hand: OBDLink MX+ (OBD Solutions LLC, `com.obdlink`, PPID `221699-0001`), Vgate vLinker FS / MS (ShenZhen CheBoTong, `com.vgatemall`, PIDs `649626-099130` / `649626-112572`). Declare only authorized protocol strings. The BLE transport avoids MFi entirely. Each new MFi protocol string needs a native rebuild and a new authorization; BLE profiles need neither.
5. **BLE in background**: verify that polling survives screen lock / background with `bluetooth-central` while background location keeps the app alive (TRIP-LOGGER-SPEC §4.3). Auto-wake of a non-running app is deferred (VEHICLE-LINK-SPEC §11).
6. **CAN visibility at OBD port** on CX-5 KF (Stage 2) — verify in Phase 8; fallback MS-CAN pins 3/11.
7. **No Mac, no paid Apple account**: native iteration only via CI macOS builds (slow; macOS runner minutes cost more on private repos); free-account sideloading expires after 7 days and limits the device to 3 sideloaded apps. Mitigation: thin native layer; protocol logic in TS, tested on Windows with the emulator.
8. **Routing time on the phone**: Valhalla was dropped (2026-10-05) for A\* on our own road graph in TS (ROUTING-SPEC), which removes the native dependency. The risk moves to planning time on the JS thread for long routes: measured in ROUTING-SPEC §7, searched in slices so the map never freezes.
9. **Data sizes** (vector tiles, road graph for Ukraine) — measure in Phase 0.
10. **Particle filter robustness**: particle depletion (correct hypothesis pruned), tuning of noise/penalties, and CPU budget. Mitigations: off-road share, re-injection near clusters, replay metrics on hard segments before field tests.
11. **OSM completeness**: missing or outdated roads, wrong one-way/turn-restriction tags → on-road hypotheses die. Mitigations: off-road particles, soft (not hard) restriction penalties if replay shows false pruning.
12. MFi protocol strings are known (`com.obdlink`, `com.vgatemall`; VEHICLE-LINK-SPEC §3.4). Verified: an `EASession` opens on the MX+. Still to verify: vLinker FS/MS over EA once one is available.
13. **Temporary privacy exception (dev only)**: until offline tiles exist (§3.8), the map uses OpenFreeMap online vector styles, which sends the map viewport to a third party. This is an exception to the §2 privacy rule. Once an offline map is downloaded (Downloads; regions built by `tools/tiles` and published as GitHub releases `maps-<osm_date>` by `.github/workflows/map-packs.yml`) the map uses only the active region; the online style is the fallback when none is downloaded and must be removed before any non-dev distribution. Fetching the catalog and maps contacts GitHub only from the Downloads screen. See [UI-SPEC.md](UI-SPEC.md) §2.
14. **BLE throughput ceiling**: iOS connection intervals (15–30 ms) limit one adapter to roughly 15–30 polls/s at best; clones are lower. Measure per adapter (VEHICLE-LINK-SPEC §3.5).
15. **BLE catalog completeness**: no-name adapters use varied GATT layouts and names, and many don't advertise services. Mitigations: unfiltered scan + name ranking + heuristic UART search + "Try anyway"; GATT dumps of unknown devices are logged to extend the catalog.
16. **Vehicle ECU quirks:** while the ECU is awake with the engine off, the CX-5 answers PID `0C` with a stale RPM
    latched at shutdown. The repeat rule handles it (VEHICLE-LINK-SPEC §10.4). It reads speed 0 while reversing, and
    battery voltage ~12 V while driving on some drives. Other makes may have other quirks, so check engine state
    and speed against logs on every new car.
17. **Tuning from one phone:** all navigator tuning comes from one iPhone 13, one mount and one car. GNSS timing is
    measured online; the rest needs logs from another phone and mount (NAVIGATOR-SPEC §11).
18. **Sentry source maps**: uploads need the `SENTRY_AUTH_TOKEN` secret and `SENTRY_ORG` / `SENTRY_PROJECT` repo variables; without them builds skip the upload and JS stack traces are minified.
