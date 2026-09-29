# wtf.ai — Spoofing-Resilient Car Navigator: High-Level Specification

Status: draft v4 (2026-09-30). Source of truth for coding agents. Update this file when decisions change.

## 1. Problem & goal

**wtf.ai** stands for **"Where the f\* am I?"** The name captures the app's central purpose: helping drivers understand their position when GNSS cannot be trusted. The native launch splash displays the full name.

During air raids in Ukraine, GNSS is jammed or spoofed (fixes jump to wrong places, often outside Ukraine). The app keeps a trustworthy vehicle position by fusing the last trusted GNSS fix with vehicle odometry in an EKF, locating the vehicle on the offline road network with a map-constrained particle filter, and provides offline routing.

Odometry is built up in stages (§2.1). Stage 1 uses the minimum that works on almost any car: vehicle speed from standard OBD-II over plain ELM327 commands, and heading rate from the phone gyro. Later stages add CAN wheel speeds and CAN yaw rate.

## 2. Fixed decisions

| Topic                       | Decision                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform                    | **iOS first**. Android is nice-to-have later (no test device).                                                                                                                                                            |
| Dev environment             | Windows only, no Mac. iOS builds via **EAS Build** (cloud).                                                                                                                                                               |
| Framework                   | Expo SDK 57, Expo Router, TypeScript. Dev builds only (no Expo Go).                                                                                                                                                       |
| Odometry roadmap            | **Staged** (§2.1): Stage 1 OBD-II speed + phone gyro → Stage 2 CAN wheel speeds → Stage 3 CAN yaw rate. Each stage is a drop-in odometry source; the EKF, integrity, and map matching don't change between stages.           |
| Adapter protocol            | Stage 1: **plain ELM327 command subset only** (§3.1), for broad dongle compatibility. No STN/OBDLink-specific commands until Stage 2.                                                                                        |
| Adapter transport           | Stage 1: **OBDLink MX+** over `ExternalAccessory` (the dev adapter on hand), then **BLE ELM327** (CoreBluetooth, no MFi) for generic dongles and App Store distribution. The ELM327 layer is transport-agnostic.            |
| First vehicle               | **Mazda CX-5 KF (2017–2021)**.                                                                                                                                                                                            |
| Map display                 | **MapLibre** (`@maplibre/maplibre-react-native`) with **offline** OSM vector tiles. Not Google Maps.                                                                                                                      |
| Routing                     | **valhalla-mobile** (Rallista, MIT) — `route` only, offline tiles built from OSM Ukraine extract.                                                                                                                         |
| Map matching                | **Custom road-constrained particle filter** in TS (`src/nav/mapmatch/`) over **our own compact road graph** (§3.8). Valhalla `trace_attributes` is **not** used: its HMM assumes independent, bounded GNSS-like errors, while DR error is correlated and grows, so it locks onto parallel roads and returns a single answer. |
| Estimator location          | **TypeScript** (`src/nav/`), not native. Reason: Windows-only dev; logic must hot-reload and be unit-testable/replayable on Windows. Native code stays thin.                                                              |
| GNSS integrity              | Only two checks: **outside-Ukraine polygon** and **teleport vs odometry/DR**. Do **not** use raw GNSS data. Do **not** implement slow drag-off detection.                                                                 |
| Yaw source                  | Stage 1: **phone gyro** projected onto gravity. Stage 2: rear wheel-speed differential. Stage 3: **CAN yaw rate** (to be reverse-engineered; not in opendbc).                                                            |
| Absolute heading            | From trusted GNSS course, particle-filter road heading, manual fix, and the pose persisted at ignition off. **The magnetometer is not used**: in-car distortion (body steel, wiring, mount) is typically 10–30° and changes when the phone moves. |
| Phone mount                 | Stage 1 requires a **rigid phone mount** (the gyro is the only yaw source).                                                                                                                                               |
| Standstill bias calibration | **2–3 s**, refined at every stop (ZUPT). No dedicated long standstill step.                                                                                                                                               |
| Distribution                | Ad-hoc now. App Store via the BLE transport (no MFi), or via MX+ after MFi approval from OBDLink (see §9).                                                                                                                  |
| Privacy                     | All data stays on device. No telemetry, no position upload. Logs exported only by explicit user action.                                                                                                                   |

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
Adapter ──EA / BLE──▶ modules/vehicle-link (Swift, thin: transport + timestamps)
                         │ Stage 1: ELM327 request/response with tx/rx timestamps
                         │ Stage 2+: batched raw CAN frames (50–100 ms)
                         ▼
CoreLocation (expo-location) ─▶ src/nav (TypeScript)
Phone IMU (expo-sensors) ─────▶   ├─ odometry         (OdometrySource: speed + yaw rate per stage)
                                   │    ├─ obd        (ELM327 session, PID parsing)       Stage 1
                                   │    ├─ imu        (gyro · ĝ, handling detection)      Stage 1+
                                   │    └─ can        (JSON vehicle profiles, decoder)    Stage 2+
                                   ├─ integrity        (GNSS trust state machine)
                                   ├─ ekf              (dead reckoning + updates)
                                   ├─ calibration      (initial + online)
                                   ├─ mapmatch         (particle filter on road graph)
                                   │    └─ RoadGraph interface ◀─ graph tiles (device: file/SQLite reader; replay: Node fs)
                                   └─ routing client ─▶ modules/valhalla (Swift, thin)
                                           │
                                           ▼
                                 src/app screens (MapLibre, routing, wizard)
```

### 3.1 `modules/vehicle-link` (Expo native module, Swift)

Responsibilities only: connect/reconnect, write bytes, read bytes, split on the ELM `>` prompt / line endings, timestamp with a monotonic clock. No protocol logic beyond that.

**Transports**

- **EA** (OBDLink MX+): iOS `ExternalAccessory` session; protocol string declared in `UISupportedExternalAccessoryProtocols` via `app.json`/config plugin.
- **BLE** (generic ELM327 BLE, OBDLink CX): CoreBluetooth; discover the serial-over-GATT service (write + notify characteristics). Known service/characteristic UUIDs kept in a TS table and passed to native, so adding a dongle doesn't need a native build.
- Wi-Fi ELM327 (TCP) is not planned.

**Stage 1 API: request/response**

- `send(command) → { lines, txTime, rxTime }`: write the command, resolve when the `>` prompt arrives or a timeout expires.
- The poll loop runs in TS. The native timestamps keep the timing accurate despite bridge jitter. A speed sample is timestamped at `(txTime + rxTime) / 2`.
- If bridge overhead limits the poll rate, add a native repeat mode (same command, batched results) as an optimization.

**Stage 1 ELM327 command subset** (ELM327 v1.3-level; avoid anything clones commonly lack)

- Init: `ATZ`, `ATE0`, `ATL0`, `ATS0`, `ATH0`, `ATSP0` + `0100` (auto-detect), `ATDPN` (read the detected protocol), then `ATSPn` (fix it), `ATAT1` (adaptive timing).
- Speed poll: `010D1`. The trailing `1` is the expected response count, so the adapter answers without waiting out its timeout. If the adapter rejects it (`?`) or doesn't speed up, fall back to `010D`.
- VIN: `0902` (per-VIN calibration storage; fall back to an adapter ID if unsupported).
- Supported-PID probe: `0100`/`0120`/…; if PID `A4` (transmission actual gear) is supported, poll it at a low rate to sign speed in reverse.
- Ignition-off detection: repeated `NO DATA` / `UNABLE TO CONNECT`, plus `ATRV` battery voltage drop.

**Stage 2+ (STN)**

- Reset, select protocol/bus (HS-CAN 500 kbps), set **pass filters** for required IDs only, start monitor mode. Unfiltered mode only for the logger/RE workflow.
- Batch frames to JS every 50–100 ms. Ignition-off detection: CAN silence timeout.

### 3.2 Odometry sources (`src/nav/odometry/`)

A common `OdometrySource` interface feeds the EKF with timestamped speed and yaw-rate samples, each carrying its variance and validity. The EKF doesn't know which stage produced them.

#### Stage 1: OBD speed (`odometry/obd/`)

- Parses PID `0D` (km/h, integer) → m/s. Unsigned. Forward is assumed unless PID `A4` reports reverse.
- Measurement noise covers 1 km/h quantization, possible truncation bias (§9), and poll-timing latency.
- Some ECUs report 0 below ~2–3 km/h. Standstill therefore also requires a quiet IMU (§3.6).

#### Stage 1+: phone IMU (`odometry/imu/`)

- Vertical yaw rate `ω = gyro · ĝ` (independent of how the phone is mounted), from `expo-sensors` DeviceMotion at ~50–100 Hz (verify the achievable rate in Phase 0), batched.
- **Handling detection**: mark gyro samples invalid when the gravity direction in the phone frame changes (phone moved on/in the mount) or on accel spikes. In Stage 2+, also when the gyro disagrees with the wheel yaw. During invalid windows the EKF propagates heading without a yaw input and with inflated covariance.

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
4. **Startup**: last pose persisted at ignition off; first fix of new session is checked for teleport against it (odometry distance since = 0 until driving).
5. Jamming (no fix / poor accuracy) = simply no GNSS updates.

- Out of scope: raw GNSS (C/N0, AGC), slow drag-off detection.

### 3.4 EKF (`src/nav/ekf/`)

- Frame: local ENU tangent plane, re-anchored periodically; convert to/from WGS84 at boundaries.
- State: `E, N, ψ (heading), v, k_s (speed scale), b_ω (yaw bias), k_ω (yaw scale)`; plus `r_LR` (left/right wheel radius ratio) in Stage 2 while using wheel-differential yaw.
- Predict: unicycle/CTRV model.
  - Stage 1: driven by the phone yaw rate at the IMU rate (~50–100 Hz); `v` is a random walk (acceleration process noise), corrected by speed updates.
  - Stage 2+: ~50 Hz on CAN data; speed = mean rear wheel speed × `k_s`, signed by gear.
- Updates:
  - Stage 1 speed: `v = k_s · s_OBD` at the poll rate (expected ~5–20 Hz depending on adapter).
  - GNSS position (+ course when speed is sufficient) — **only when `TRUSTED`**.
  - ZUPT at standstill: `v = 0`, measured yaw = bias.
  - Map-match pseudo-measurement from the particle filter (§3.7): position + road heading, **only when the posterior is unimodal**; covariance from cluster spread. In Stage 1 this is the main correction for gyro heading drift during long outages.
  - Manual fix (user long-press on map, heading snapped to road).
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

### 3.7 Map matching — road-constrained particle filter (`src/nav/mapmatch/`)

Reference approach: Gustafsson et al., "Particle filters for positioning, navigation, and tracking", IEEE Trans. Signal Processing, 2002 (car positioning from wheel speeds + road map, no GNSS).

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

**Initialization**: around the last trusted GNSS fix, the pose persisted at startup, or a manual fix. Spread over edges within k·σ, with direction consistent with heading.

**Budget**: ~300–1000 particles; target < 5 ms per update on iPhone on the JS thread (measure in replay and on device).

### 3.8 Offline data (`tools/tiles/`)

- Source: Geofabrik Ukraine PBF.
- Outputs:
  1. Valhalla routing tiles tarball (routing only).
  2. Vector map tiles (PMTiles/MBTiles) + MapLibre style.
  3. **Road graph for map matching**: drivable OSM ways (no footway/path/cycleway/steps; `service`/`private` kept but flagged), split at intersections. Per edge: simplified polyline (≤ ~1 m deviation), length, road class, one-way, connectivity, turn restrictions (OSM relations). Tiled (e.g. z14) with a per-tile spatial index in a compact binary format; the device loads tiles around the active hypotheses. Size to be measured in Phase 0.
- Hosted as versioned, checksummed downloads. In-app download manager: resumable, checksum-verified, update check.

### 3.9 App (`src/app/`, Expo Router)

UI-first milestone (map with live GNSS + mock screens): see [UI-SPEC.md](UI-SPEC.md).

- Native launch splash — displays `wtf.ai` and **"Where the f\* am I?"**.
- `index` — map: fused position puck + uncertainty circle (dominant hypothesis), alternative map-match hypotheses as secondary markers when ambiguous, raw GNSS ghost marker, trust badge (`GPS OK` / `UNTRUSTED` / `REACQUIRING`), time & distance since last trusted fix, adapter status.
- `calibration` — first-run wizard.
- `vehicle` — adapter connection (transport, ELM version, protocol, poll rate), VIN, active odometry stage.
- `downloads` — offline data manager.
- `route` — offline routing (Valhalla `route`), reroute on deviation, next maneuver + distance.
- `debug` — live signals, EKF state, particle cloud overlay + cluster weights, logging controls, log export.
- Background: iOS `UIBackgroundModes` = `location`, plus `external-accessory` (EA) and `bluetooth-central` (BLE) (config plugin, never hand-edit `ios/`).

### 3.10 Logging & replay (`tools/replay/`)

- On-device logger, all with monotonic timestamps; file export:
  - Stage 1: full ELM327 transcript (every command/response with tx/rx times), CoreLocation fixes, phone IMU (gyro + gravity + user accel).
  - Stage 2+: raw CAN frames in addition.
- Replay harness runs `src/nav` in Node/Bun on Windows. Simulated outages/spoofing by cutting or offsetting GNSS in clean logs.
- Map-matching metrics: wrong-road rate (share of time the dominant cluster is on a different edge than the GNSS ground truth), time to re-lock after an ambiguity, time spent multimodal, PF update time.
- Stage comparison: Stage 2 logs can be degraded to Stage 1 inputs (wheel speed → quantized to 1 km/h, resampled at the measured PID rate; yaw → phone gyro) to compare stages on the same drive.

## 4. Repository layout (target)

```
src/app/                 Expo Router screens only
src/nav/                 pure TS core (no React Native imports)
  odometry/{obd,imu,can}/ ekf/ integrity/ calibration/ mapmatch/ geo/
src/components/          UI components
modules/vehicle-link/    Expo module (Swift) — EA + BLE transports; STN monitor in Stage 2
modules/valhalla/        Expo module (Swift) — valhalla-mobile wrapper (routing only)
assets/profiles/         vehicle JSON profiles (Stage 2+)
assets/geo/              Ukraine border polygon
tools/re-yaw/            yaw reverse-engineering script (Stage 3)
tools/replay/            replay harness (loads road graph via Node fs)
tools/tiles/             build pipeline: Valhalla tiles, vector tiles, road graph
```

## 5. Phases

### Stage 1 — minimum viable odometry

| #   | Phase                       | Depends on | Key output                                                                                                                                                                                               |
| --- | --------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Setup & spikes              | —          | Apple Developer account, EAS dev build on iPhone; MX+ EA connect + ELM327 init + `010D1` poll rate measured on CX-5; DeviceMotion rate measured; valhalla-mobile inside Expo module (SPM vs CocoaPods); MapLibre offline tiles; Ukraine road graph built, size and tile-load time measured |
| 1   | Logger                      | 0          | ELM327 transcript + GNSS + IMU logs exportable                                                                                                                                                          |
| 2   | TS EKF + replay             | 1          | `src/nav/odometry` (obd, imu), `src/nav/ekf`, replay metrics                                                                                                                                             |
| 3   | Integrity                   | 2          | `src/nav/integrity`                                                                                                                                                                                      |
| 4   | Calibration                 | 2, 3       | wizard + online estimation, per-VIN storage                                                                                                                                                              |
| 5   | Map matching (particle filter) | 0, 2    | road-graph pipeline + `RoadGraph` reader (device + Node), `src/nav/mapmatch` PF, EKF pseudo-measurements, replay map-matching metrics (§3.10)                                                           |
| 6   | App UI, routing, background | 2–5        | screens, download manager                                                                                                                                                                                |
| 7   | Field test (Stage 1)        | 6          | real outage drives; baseline DR error numbers                                                                                                                                                            |
| 7b  | BLE transport               | 1          | generic ELM327 BLE dongles + OBDLink CX; tested-adapter list with measured poll rates                                                                                                                  |

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
- `src/nav/**` must stay pure TypeScript with no React Native / Expo imports.
- Native modules stay thin: I/O and bridging only; no estimation or protocol logic in Swift.
- Batch high-rate data across the native→JS bridge (IMU samples, CAN frames); never emit one event per CAN frame or IMU sample.
- Units internally: SI (m, s, rad, m/s, rad/s). Convert at boundaries.
- Minimize native changes — each one costs a cloud EAS build.
- Before declaring done: `npx expo lint`, `npx tsc --noEmit`, and unit tests for `src/nav`.

## 7. Verification targets

### Stage 1

1. Phase 0: `010D1` poll rate on CX-5 via MX+ measured and reported (target ≥ 10 Hz); PID `0D` matches GNSS speed within 1 km/h at steady speed; VIN read via `0902`.
2. Standstill: heading drift ≈ 0 while stopped after 2–3 s bias estimate.
3. Handling detection: picking up / re-seating the phone during a logged drive invalidates the gyro window; no heading step after re-seating.
4. Replay: GNSS cut for 1 / 5 / 15 min on clean logs — report DR error with and without map matching.
5. Map matching: on replay with GNSS cut, report wrong-road rate and re-lock time (§3.10), including dedicated parallel-road and dense-grid segments; after an ambiguity the correct hypothesis must survive (never fully pruned) until a turn resolves it.
6. PF performance: update time within budget (§3.7) on iPhone with the target particle count.
7. Integrity: injected out-of-Ukraine fixes and teleports rejected within 1 fix; zero false rejections on clean logs.
8. Lint + typecheck pass; EAS dev build installs and runs on iPhone.

### Stage 2 & 3

9. CX-5 wheel speeds and gear decode correctly (compare to GNSS speed / gear lever).
10. Yaw RE: candidate correlation > 0.98 vs phone vertical yaw, both turn directions.
11. Stage comparison: DR error for Stage 2 and 3 vs Stage 1 on the same logs (§3.10); each stage must not be worse than the previous.

## 8. Out of scope (v1)

Google Maps; Android; raw GNSS analysis; slow drag-off spoofing detection; Wi-Fi ELM327 adapters; magnetometer heading; STN/OBDLink-specific commands in Stage 1; lane-level accuracy; any cloud services; feeding corrected location to other apps.

## 9. Risks & open items

1. **ELM327 clone quality**: many clones (fake "v2.1") are slow, lack the response-count suffix, or mis-handle timeouts → poll rate may drop to ~3–8 Hz. Measure per adapter; define a minimum usable rate; keep a tested-adapter list.
2. **OBD speed quality**: 1 km/h resolution; some ECUs truncate rather than round (small constant bias that `k_s` can't absorb — consider a speed-offset state if replay shows it); zero cutoff at low speed; unsigned (reversing counted as forward unless PID `A4` is supported). ZUPT and map matching must absorb these.
3. **Gyro-only heading drift** in Stage 1 during long outages (residual bias ~0.01°/s ≈ 9° per 15 min). Depends on map matching and on a rigid mount; quantify in Phase 7.
4. **MFi for App Store** (EA/MX+ only): ad-hoc/dev builds only need the EA protocol string in Info.plist. App Store (and likely external TestFlight) requires OBDLink (ScanTool.net) to register our bundle ID with Apple's MFi program (PPID) before review. The BLE transport (Phase 7b) avoids MFi entirely.
5. **BLE in background**: verify that polling survives screen lock / background with `bluetooth-central`.
6. **CAN visibility at OBD port** on CX-5 KF (Stage 2) — verify in Phase 8; fallback MS-CAN pins 3/11.
7. **No Mac**: native iteration only via EAS cloud builds (build quota). Mitigation: thin native layer; protocol logic in TS; consider cloud Mac / used Mac mini.
8. **valhalla-mobile packaging**: ships as Swift Package; Expo modules use CocoaPods → may need vendored xcframework. Valhalla is now routing-only; if packaging proves too costly, offline routing (A\*) on our own road graph is an alternative that removes the native dependency.
9. **Data sizes** (Valhalla tiles, vector tiles, road graph for Ukraine) and Valhalla routing CPU/latency on device — measure in Phase 0.
10. **Particle filter robustness**: particle depletion (correct hypothesis pruned), tuning of noise/penalties, and CPU budget. Mitigations: off-road share, re-injection near clusters, replay metrics on hard segments before field tests.
11. **OSM completeness**: missing or outdated roads, wrong one-way/turn-restriction tags → on-road hypotheses die. Mitigations: off-road particles, soft (not hard) restriction penalties if replay shows false pruning.
12. MX+ EA protocol string — confirm exact value with OBDLink docs.
13. **Temporary privacy exception (dev only)**: until offline tiles exist (§3.8), the map uses OpenFreeMap online vector styles, which sends the map viewport to a third party. This is an exception to the §2 privacy rule. It must be removed before any non-dev distribution by switching the style URLs in `src/config/map.ts` to offline PMTiles. See [UI-SPEC.md](UI-SPEC.md) §2.
