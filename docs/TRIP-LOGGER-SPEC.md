# wtf.ai — Trip Logger Specification

Status: v3 (2026-10-10), field-tested. Implements SPEC.md Phase 1 (Logger). Source of truth for coding agents. Adapter communication is specified in [VEHICLE-LINK-SPEC.md](VEHICLE-LINK-SPEC.md).

## 1. Goal

First end-to-end target for the whole app:

1. Know when a trip starts and ends (engine on/off) without user interaction once the app is open.
2. Record each trip into a compact binary log: timestamps, OBD vehicle speed, GNSS position with its uncertainty, IMU.
3. Move logs to a Windows PC and read them there (Python) to develop dead-reckoning algorithms offline.
4. Pages to drive and inspect all of this (Trip recorder, trips, the ELM terminal).

## 2. Decisions

| Topic            | Decision                                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Log format       | **ULog** (PX4), version 1. Self-describing, append-only, truncation-tolerant. Readers: `pyulog`, PlotJuggler, Foxglove.                                                     |
| Log writer       | Pure TS encoder (`src/triplog/`), file sink via `expo-file-system` `File.open(FileMode.Append)` + `FileHandle.writeBytes`.                                                   |
| Sensor capture   | Own native module `modules/sensor-capture` (Swift): CoreLocation + CoreMotion, batched to JS. The map's position uses the same GNSS stream (`SensorService` runs capture for the union of its owners: recorder, map). |
| Time base        | Monotonic uptime µs (`ProcessInfo.systemUptime`) for every record — same clock as CoreMotion and `modules/vehicle-link`. Wall clock via `time_sync` records.                |
| Automation       | Open the app once; connect, trip start/end, and recording are automatic and survive screen lock / background while the app stays alive (§4.3).                              |
| Permissions      | Location **When In Use** is enough (a session started in the foreground may continue in the background with the blue indicator). "Always" only for the later auto-wake.    |
| Export           | Share sheet (`expo-sharing`) per trip + app Documents visible in the iOS Files app / Windows "Apple Devices" file sharing. Export only by explicit user action (SPEC §2). |
| PC tooling       | Python package `tools/triplog/` (pandas DataFrames, CSV/Parquet export, plots, checks).                                                                                     |
| Dev UI strings   | Dev-only screens still go through i18n keys; `uk.ts` may reuse the English text for dev-only keys.                                                                          |

## 3. Components

```
modules/vehicle-link ──▶ src/services/vehicle-link ──(VehicleLink contract)──┐
                                                                            ▼
modules/sensor-capture ─▶ src/services/sensor-capture ──(SensorStream)──▶ src/services/trip-recorder
                                                                            │  trip state machine (§4)
                                                                            ▼
                                                     src/triplog (pure TS): ULog encoder + record schemas
                                                                            │  Uint8Array chunks
                                                                            ▼
                                                     file sink (expo-file-system) → Documents/trips/*.ulg
                                                                            │  share sheet / Files app
                                                                            ▼
                                                     PC: tools/triplog (Python) → pandas / CSV / Parquet / plots
```

- `src/triplog/**` follows the `src/nav/**` rule (no React Native/Expo imports), so the replay harness can reuse the schemas and a future TS reader.
- The trip state machine itself is pure TS in `src/triplog/trip-detector.ts`. `src/services/trip-recorder` wires it to the link and sensors and owns the pre-roll buffer, the writer lifecycle, and the trip index; it exposes a `TripRecorder` store (`getSnapshot`/`subscribe`) for the UI.
- `src/services/runtime.ts` creates the vehicle link, sensor service, recorder and the map's GNSS position source once for the app's lifetime; `src/providers/runtime-provider.tsx` exposes them to screens and auto-connects on launch/foreground.

## 4. Trip detection

### 4.1 States

| State       | Meaning                                                                                     | Sensors           |
| ----------- | ------------------------------------------------------------------------------------------- | ----------------- |
| `idle`      | No adapter connected                                                                        | off               |
| `armed`     | Adapter connected (`standby`/`polling`), no trip                                            | off while `ignition-off`; on (pre-roll) once the ECU is awake |
| `recording` | Trip in progress, log file open                                                             | on                |
| `lingering` | Trip ended; keep the app alive briefly in case the next trip starts soon (fuel stop)        | GNSS low power    |

### 4.2 Transitions (engine states from VEHICLE-LINK-SPEC §10.4)

| Transition               | Condition                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `armed` → `recording`    | `engine-running`, **or** 2 consecutive speed samples > 0 (hybrid pulling away in EV mode).                                                 |
| `recording` → end        | (a) `ignition-off` (ECU silent ≥ 10 s), or (b) `engine-off` with speed 0 for ≥ 5 min (parked with ignition on), or (c) adapter link lost and not back within 2 min, or (d) manual stop. |
| end → `lingering`        | Close the log (`trip_event` end + reason), start the linger timer.                                                                         |
| `lingering` → `recording` | A new trip starts (new file).                                                                                                             |
| `lingering` → `armed`    | After 15 min; stop GNSS so iOS may suspend the app.                                                                                        |

- Auto stop-start stops (`engine-off` at a red light) do **not** end a trip; only ignition off or a long parked stop does.
- During link loss inside a trip, GNSS and IMU keep recording; `trip_event link_lost/link_restored` mark the gap.
- **Pre-roll**: from the moment the ECU wakes (`engine-off`/`engine-running` after `ignition-off`) sensors run into a 30 s in-memory ring buffer, written at the start of the trip file. This captures the standstill before pulling away (gyro bias, SPEC §3.6).
- Manual start/stop in the dev UI (works without an adapter, e.g. to log GNSS + IMU only). Manual trips carry `start_reason = manual`.
- All thresholds live in one config object, editable from the dev UI.

### 4.3 App lifecycle (first target)

- The user opens the app; it auto-connects to the remembered adapter (VEHICLE-LINK-SPEC §7) and goes `armed`.
- During `recording` and `lingering`, background location (`allowsBackgroundLocationUpdates`, `showsBackgroundLocationIndicator`) keeps the app running, so the TS poll loop, sensor batches, and the writer keep working with the screen locked.
- In `armed` with the ignition off and no linger, the app may be suspended; the next session begins when the user opens the app again. Fully automatic wake is later (VEHICLE-LINK-SPEC §11).

## 5. Sensor capture — `modules/sensor-capture`

### 5.1 GNSS (CoreLocation)

- `CLLocationManager`: `desiredAccuracy = kCLLocationAccuracyBestForNavigation`, `distanceFilter = kCLDistanceFilterNone`, `activityType = .automotiveNavigation`, `pausesLocationUpdatesAutomatically = false`, `allowsBackgroundLocationUpdates = true`, `showsBackgroundLocationIndicator = true`.
- Per fix, deliver: latitude, longitude, altitude (MSL), ellipsoidal altitude, horizontal/vertical accuracy, speed, speed accuracy, course, course accuracy, fix wall-clock timestamp, `sourceInformation` (`isSimulatedBySoftware`, `isProducedByAccessory`). Negative accuracy/speed/course → invalid (NaN in the log).
- Fix timestamp → uptime: `fixUs = nowUptimeUs − (nowWall − fix.timestamp)`, computed at delivery. Also record the delivery delay.
- No heading (`CLHeading` uses the magnetometer, SPEC §2).

### 5.2 IMU (CoreMotion)

- `CMDeviceMotion` at **100 Hz**, reference frame `xArbitraryZVertical` (no magnetometer). Fields: `rotationRate` (rad/s, bias-corrected), `userAcceleration` and `gravity` (converted from g to m/s², × 9.80665), `attitude.quaternion`. Timestamp = `CMLogItem.timestamp` (uptime).
- Optional raw streams, **off by default** (dev toggle): `CMGyroData` and `CMAccelerometerData` at 100 Hz.
- Raw magnetometer, **always on** with the IMU: `CMMagnetometerData` at 20 Hz, µT in the device frame, uncalibrated
  (includes the phone's own and the car's fields; calibrate offline, e.g. from turns measured by the gyro). Logged
  only, not used for navigation (SPEC §2). It doesn't change the `CMDeviceMotion` reference frame.
- Device frame: Apple's (x right, y toward the top of the screen, z out of the screen).

### 5.3 Bridge

- Functions: `startGnss()`, `stopGnss()`, `startImu({ rateHz, raw, batchMs, magRateHz })`, `stopImu()`, `getPermissions()` / `requestPermissions()` (location When In Use, motion), `nowUs()`.
- Events: `onGnss` (per fix, ~1 Hz), `onImuBatch` every 100 ms with columnar plain number arrays (`t[]`, `gx[]`, …).
- Config plugin: `NSMotionUsageDescription`, `NSLocationWhenInUseUsageDescription` (already set via `expo-location`), `UIBackgroundModes: location` (set via `expo-location` `isIosBackgroundLocationEnabled: true`).

## 6. Log format (ULog)

### 6.1 File

- Path: `Documents/trips/<startUTC as YYYYMMDD-HHMMSS>_<6-char id>.ulg`; manual sessions get suffix `_manual`.
- Standard ULog v1 layout: 16-byte header (magic `55 4C 6F 67 01 12 35`, version 1, uint64 start timestamp µs), `B` flag-bits message (all zero), then definitions (`I` info, `F` formats), then data (`A` subscriptions, `D` data, `C` tagged strings, `S` sync, `O` dropout, and `I` info for values learned after the header — readers keep the last value per key). Little-endian, unaligned, no padding fields.
- Every subscribed message starts with `uint64_t timestamp` = monotonic uptime µs (§2). Readers convert to seconds since log start.

### 6.2 Info messages (`I`)

| Key                               | Value                                                  |
| --------------------------------- | ------------------------------------------------------ |
| `char[] sys_name`                 | `wtf.ai`                                               |
| `char[] ver_sw`                   | app version + git commit                               |
| `char[] ver_update`               | the JS that ran: `embedded` (the build's own), the OTA update id, or `off` (Debug build); ` emergency` appended when a broken update fell back to the embedded JS (OTA.md) |
| `char[] ver_runtime`              | the build's OTA runtime version (fingerprint), empty in a Debug build |
| `char[] sys_hw`                   | phone model identifier (e.g. `iPhone15,2`)             |
| `char[] sys_os_ver`               | OS version                                             |
| `uint32_t wtf_log_ver`            | `1` (bump on breaking schema change; additive changes don't bump) |
| `char[] trip_id`                  | 6-char id from the file name                           |
| `char[] start_reason`             | `engine` / `speed` / `manual`                          |
| `char[] adapter_transport`        | `ble` / `mfi` / `spp` (Android Classic) / `none`       |
| `char[] adapter_name`             | advertised name / EA name                              |
| `char[] adapter_elm`              | `ATI` answer                                           |
| `char[] adapter_chip`             | `STI` answer or empty                                  |
| `char[] obd_protocol`             | `ATDPN` answer                                         |
| `char[] vehicle_vin`              | VIN or empty; repeated in the data section if read later |
| `char[] vehicle_vin_source`       | `read` (from the car), `remembered` (the read missed: the last car seen on this protocol, VEHICLE-LINK-SPEC §9.1), empty with no VIN; repeated with `vehicle_vin` |
| `char[] imu_frame`                | `xArbitraryZVertical`                                  |
| `char[] nav_mapmatch_loop`        | navigator version at trip start: `open` / `heading` / `closed` (MAPMATCH-SPEC §9); a change mid-drive is the note `nav map-match loop <v>` |
| `char[] nav_route_hint`           | `on` / `off`: map matching told the active route (ROUTING-SPEC §8.6, developer setting); a change is the note `nav route hint …` |
| `char[] nav_phone_only`           | `on` / `off`: navigation without an adapter (NAVIGATOR-SPEC §9.6, developer setting); a change is the note `nav phone-only …` |

### 6.3 Data messages (`F` + `D`)

| Message        | Fields (after `uint64_t timestamp`)                                                                                                                                                                         | Rate            | Payload |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------- |
| `obd_pid`      | `uint32_t latency_us` (rx − tx; timestamp is **rx**), `uint8_t mode`, `uint8_t pid`, `uint8_t status` (§6.5), `uint8_t n_bytes`, `uint8_t[4] data` (raw A–D), `uint16_t ecu` (CAN id or 0), `float value` (decoded: m/s for `0D`, rpm for `0C`, NaN otherwise) | every poll (~5–30 Hz) | 26 B |
| `gnss`         | `int64_t utc_us` (fix wall clock), `double lat_deg`, `double lon_deg`, `float alt_msl_m`, `float alt_ellipsoid_m`, `float h_acc_m`, `float v_acc_m`, `float speed_mps`, `float speed_acc_mps`, `float course_rad`, `float course_acc_rad`, `uint32_t delivery_delay_us`, `uint8_t flags` (bit0 simulated, bit1 from accessory) | ~1 Hz           | 69 B    |
| `imu_motion`   | `float[3] gyro_rad_s`, `float[3] user_accel_m_s2`, `float[3] gravity_m_s2`, `float[4] attitude_q` (w, x, y, z)                                                                                             | 100 Hz          | 60 B    |
| `gyro_raw`     | `float[3] gyro_rad_s`                                                                                                                                                                                        | 100 Hz, optional | 20 B   |
| `accel_raw`    | `float[3] accel_m_s2`                                                                                                                                                                                        | 100 Hz, optional | 20 B   |
| `mag_raw`      | `float[3] mag_ut` (raw magnetic field, µT, device frame)                                                                                                                                                     | 20 Hz           | 20 B    |
| `engine_state` | `uint8_t state` (0 unknown, 1 ignition_off, 2 engine_off, 3 engine_running)                                                                                                                                  | on change       | 9 B     |
| `trip_event`   | `uint8_t event` (0 start, 1 end, 2 link_lost, 3 link_restored, 4 marker, 5 preroll_end), `uint8_t reason` (end: 0 ignition_off, 1 parked_timeout, 2 link_timeout, 3 manual)               | on event        | 10 B    |
| `link_stats`   | `float speed_hz`, `float latency_p50_ms`, `float latency_p95_ms`, `uint16_t errors`, `uint8_t link_state`, `float battery_v` (NaN if not read)                                                                | 1 Hz            | 27 B    |
| `time_sync`    | `int64_t utc_us`                                                                                                                                                                                             | at start, every 60 s, on wall-clock jump | 16 B |
| `nav_estimate` | What the map showed (NAVIGATOR-SPEC §9): `double lat_deg`, `double lon_deg`, `float accuracy_m`, `float heading_rad`, `float heading_sigma_rad`, `float speed_mps`, `float speed_scale`, `float gnss_lag_s` (NaN when unknown), `uint32_t behind_us` (navigator state age at publish), `uint8_t mode` (0 none, 1 anchored, 2 dr), `uint8_t source` (0 gnss, 1 fused, 2 dr, 3 manual), `uint8_t trust` (0 TRUSTED, 1 UNTRUSTED, 2 REACQUIRING, 3 NO_FIX), `uint8_t parked_pose` (0 none, 1 unverified, 2 confirmed, 3 rejected) | each map update, ~2–3 Hz | 60 B |
| `nav_mapmatch` | Map matching at that `nav_estimate`, while a road graph is set (MAPMATCH-SPEC §11): `uint8_t state` (0 off, 1 init, 2 tracking, 3 multimodal, 4 offroad), `uint8_t clusters` (hypotheses, ≤ 5), `uint16_t particles`, `uint32_t update_us` (last filter update), `uint16_t update_count`, `uint32_t update_total_us`, `uint32_t update_max_us` (every filter update since the previous record: how many, their total, the slowest; starts not included, they close the drive's `mm timing` note), `uint32_t graph_built` (graph file build time, unix s: the graph version), then the 3 heaviest hypotheses: `float[3] weight`, `double[3] lat_deg`, `double[3] lon_deg`, `float[3] heading_rad`, `float[3] spread_m` (NaN when fewer) | with `nav_estimate` | 119 B |
| `nav_route` | Each route plan (ROUTING-SPEC §8): `uint16_t plan_id` (from 1 per app session), `uint8_t reason` (0 new, 1 off-route, 2 resume: an active route logged again when a trip starts, 3 alternative: an alternative became the route, ROUTING-SPEC §8.7), `uint8_t status` (0 done, 1 no-road-at-start, 2 no-road-at-destination, 3 no-route, 4 too-far, 5 cancelled), `double from_lat_deg`, `double from_lon_deg`, `float from_heading_rad` (NaN unknown), `double to_lat_deg`, `double to_lon_deg`, `float length_m`, `float duration_s`, `float off_start_m`, `float off_end_m` (NaN unless done), `uint32_t states`, `uint32_t tiles`, `float plan_ms` (in the search), `float wall_ms` (request to result), `uint16_t slices`, `uint16_t points`, `uint16_t maneuvers`, `uint32_t graph_built` | per plan | 95 B |
| `nav_route_point` | The plan's polyline, one per vertex: `uint16_t plan_id`, `uint16_t index`, `double lat_deg`, `double lon_deg` | after `nav_route` | 33 B |
| `nav_route_maneuver` | The plan's maneuvers: `uint16_t plan_id`, `uint16_t index`, `uint8_t kind` (`ROUTE_MANEUVER_CODES`: depart, slight-left, slight-right, left, right, sharp-left, sharp-right, keep-left, keep-right, u-turn, roundabout, arrive), `uint8_t exit` (roundabouts; else 0), `double lat_deg`, `double lon_deg`, `float at_m` (from the start), `float turn_rad` | after `nav_route` | 43 B |
| `nav_route_progress` | Guidance at that `nav_estimate` while a route is active: `uint16_t plan_id`, `uint8_t state` (0 on, 1 leaving, 2 off, 3 unsure, 4 arrived), `uint16_t next_index` (maneuver), `float along_m`, `float off_m` (NaN: nothing matched), `float remaining_m`, `float remaining_s`, `float to_next_m` | with `nav_estimate` | 38 B |

- `obd_pid` is lossless for single-response polls (raw bytes + status + timing), so the poll transcript isn't duplicated as text.
- Speed sample time for analysis = `timestamp − latency_us / 2` (midpoint, SPEC §3.1).

### 6.4 Text (`C` tagged logged strings)

- Tags: `1` ELM transcript, `2` link events, `3` trip recorder, `4` sensors, `5` app (markers, map GNSS trust changes: `gnss trust <state> (±N m)`, and GNSS integrity verdict changes: `gnss integrity <verdict>: <why> (fix ±N m…)`, NAVIGATOR-SPEC §8).
- ELM transcript (tag 1): every non-poll exchange (probe, init, VIN, `ATRV`, terminal commands) and every poll with a non-`ok` status or unexpected text. Format: `tx=<txUs> <command> | <raw response, CR→\r escaped>`; the message timestamp is `rxUs`.
- **Before the log**: the pre-roll (§4.2) waits for the engine state, which the adapter setup comes before. So the recorder
  also keeps the link lines (non-poll exchanges, `0100` checks, failed polls, link events; 200 at most, 10 min) and
  writes those older than the log's start at that start, as `<age> s before the log: <line>` (the `tx=` value still
  gives the exact time). That is where the probe, protocol search, init and VIN read of a trip are.
- Levels: `'6'` info, `'4'` warning, `'3'` error, `'7'` debug.

### 6.5 `obd_pid.status`

`0` ok, `1` no_data, `2` timeout, `3` unable_to_connect, `4` bus_error, `5` unknown_command, `6` stopped, `7` buffer_full, `8` parse_error, `9` other — same order as `ElmStatus` in VEHICLE-LINK-SPEC §6.2.

### 6.6 Writer behavior

- Encode in memory; flush to the file every 1 s or 64 KB, whichever comes first, followed by an `S` sync message. A crash loses at most ~1 s; `pyulog` reads truncated files.
- If the sink falls behind (buffer > 1 MB), drop IMU batches and write an `O` dropout message with the lost duration.
- iOS doesn't reliably notify the app before terminating it, so the 1 s flush is the only guarantee. Files without a `trip_event end` are labelled "incomplete" in the trip list.

### 6.7 Size

| Stream                 | Bytes/s (incl. 5 B `D` header) |
| ---------------------- | ------------------------------ |
| `imu_motion` @ 100 Hz  | 6,500                          |
| `obd_pid` @ 20 Hz      | 620                            |
| `gnss` @ 1 Hz          | 74                             |
| `mag_raw` @ 20 Hz      | 500                            |
| other                  | < 100                          |
| **Total**              | **≈ 7.8 KB/s ≈ 28 MB/h**       |
| + raw IMU (optional)   | + 5 KB/s → ≈ 44 MB/h           |

The trip list shows free space; recording refuses to start below 200 MB free.

## 7. Export to PC

- **Share sheet** (`expo-sharing`) from the trip list: one `.ulg` file, or **Share all** — every finished trip stored (not deflated) in one `wtf-trips-<UTC stamp>.zip`, built in `Caches/trip-archives` (only the latest is kept) → AirDrop is not available (no Mac), so typical targets are Files/iCloud Drive, OneDrive, Telegram, e-mail.
- **Files app / USB**: `expo-file-system` config plugin `enableFileSharing: true` exposes `Documents/` (includes `trips/`). On Windows, the "Apple Devices" app (or iTunes) → device → Files → wtf.ai lets you copy logs over USB. Whether the folder also appears in the Files app is unverified (`LSSupportsOpeningDocumentsInPlace` may be needed).
- Delete single / all trips from the trip list.
- No automatic upload without the tester's opt-in (§7.1, SPEC §2 privacy).

### 7.1 Opt-in upload

Testers send logs without the share sheet. It must stay impossible for the app, or anyone holding a build, to read
logs back.

- **Path:** app → `workers/triplog-upload` (Cloudflare Worker, R2 binding) → private bucket. No storage keys are in
  the app or the repo; the Worker can only add objects: `GET /me` (who a code belongs to), `PUT /logs/<trip file>`
  (201 stored, 200 same name and size already there, 409 a different log has the name, 400 not a recorder file
  name, 413 over 95 MB). Nothing lists, reads, overwrites or deletes.
- **Codes:** one per person, made by `npm run testers:add -- <name> [--owner]`, shown once. Three pronounceable
  groups (`bakim-tuvod-segap`, consonant-vowel-consonant-vowel-consonant, no `l`/`q`/`x`/`y`, about 51 bits); case,
  spaces and dashes are ignored. The bucket keeps only the SHA-256 (`testers/<hash>.json` → name, owner flag).
  `testers:remove` revokes one code; the tester's logs stay. Shared rules: `src/triplog/upload-protocol.ts`.
- **Where logs land:** the owner's phone in `logs/` beside the existing logs; a tester's in `logs/testers/<name>/`,
  so a tester's logs can be deleted together on request.
- **App** (`src/services/trip-upload/`): off until a code is entered in the Trip recorder sheet; the Worker checks it first. The
  code is kept in the keychain (`expo-secure-store`, after first unlock), never in plain storage. Uploads run after a
  trip ends, when the app comes to the foreground, and on network changes, oldest first, one at a time; the log
  being written is never sent. Wi-Fi only by default (`expo-network`). A sent log is deleted from the phone; if the
  deletion fails, it is remembered as sent and never sent twice. A refused log (409/413/400) is kept and marked; a
  revoked code stops uploads until a new one is entered. No background scheduling beyond iOS finishing an upload
  that already started.
- **PC:** `npm run logs:pull` brings uploads down with everything else (tools/triplog/README.md).

### 7.2 Storage limit

Logs may take at most a set amount of space (Trip recorder sheet slider, 0.25–10 GB, default 1 GB ≈ 200 drives). A few
seconds after a trip ends or the limit changes, the oldest finished logs are deleted until all logs fit
(`tripsOverLimit`). The log being written, and logs waiting for upload while upload is on, are never deleted.

## 8. PC tooling — `tools/triplog/` (Python)

- Python ≥ 3.11, `pyproject.toml`, dependencies: `pyulog`, `numpy`, `pandas`, `matplotlib`; optional `pyarrow` (Parquet). Install: `pip install -e tools/triplog`.
- API:

```python
from triplog import load
trip = load("20261003-081500_k3x9qa.ulg")
trip.info            # dict of I messages
trip.obd             # every poll: t_s (midpoint), t_rx_s, latency_ms, mode, pid, status, b0..b3, ecu, value
trip.obd_speed       # DataFrame: t_s (midpoint), speed_mps, raw_kph, latency_ms, status, ecu
trip.obd_rpm         # DataFrame: t_s, rpm, latency_ms, status
trip.gnss            # DataFrame: t_s, utc, lat, lon, alt, h_acc, v_acc, speed, speed_acc, course, course_acc, simulated, from_accessory
trip.imu             # DataFrame: t_s, gyro_x/y/z, ua_x/y/z, g_x/y/z, q_w/x/y/z, yaw_rate_up (gyro · up, CCW+)
trip.engine, trip.trip_events, trip.link_stats, trip.time_sync
trip.transcript      # tagged strings (level, tag, text)
```

- CLI:
  - `triplog info <file>` — summary: duration, distance (GNSS, satellite fixes only: Wi-Fi/cell fallback under jamming has no speed), rates per stream, gaps, dropouts, adapter/vehicle info.
  - `triplog export <file> --csv|--parquet <dir>` — one file per stream.
  - `triplog plot <file>` — OBD speed vs GNSS speed, vertical yaw rate, GNSS track with accuracy, poll rate/latency.
  - `triplog check <file>` — monotonic timestamps, expected rates, OBD vs GNSS speed agreement, incomplete trip.
  - `triplog refresh <file…>` — estimates the ECU refresh period P of PID `0D` from value-change timing (phase coherence over 30 s windows) and suggests a speed cap of 2/P (VEHICLE-LINK-SPEC §10.2).
- Cross-language golden test: `src/triplog/__fixtures__/trip-fixture.ts` builds `tools/triplog/tests/data/fixture.ulg` from synthetic records (regenerate with `UPDATE_TRIPLOG_FIXTURE=1 npx jest src/triplog`); the TS unit test checks the bytes match, and the Python tests load it and check values. Both sides break if the schema drifts.
- A TS reader (`src/triplog/trip-log-reader.ts`) feeds the replay harness (SPEC §3.10, NAVIGATOR-SPEC §10).
- Put real logs in `tools/triplog/logs/`; it is git-ignored (VIN, GPS tracks).
- The files also open directly in PlotJuggler and Foxglove for quick looks.

## 9. Pages

Pages on the root stack (UI-SPEC §5): `vehicle` from the map's bar, the rest from More.

### 9.1 `vehicle`

- Device list per VEHICLE-LINK-SPEC §7: sections, RSSI, brand hint, rank, scanning indicator, "Pair MFi adapter", "Try anyway" for unknown devices, "Forget".
- Connected adapter: link state, transport, name, ELM version, chip, suspected clone, battery voltage, protocol, VIN, capabilities, chosen GATT profile.
- Live: OBD speed (km/h), RPM, engine state, speed poll rate (Hz), latency p50/p95, errors/min.
- Probe result details on failure (which step failed, GATT dump for unknown devices, with a "copy" action so it can be added to the catalog).
- Emulated adapters, listed when Developer → Show emulated adapters is on (VEHICLE-LINK-SPEC §13).

### 9.2 `recorder`, `position`, `developer` (from More)

- `recorder` holds all of trip logging in one place: state, current trip id, duration, file size, start reason;
  buttons Start (manual) / Stop / Marker; the `trips` list; recording settings (trip thresholds §4.2, raw IMU
  toggle, IMU rate 50/100 Hz); the upload code (§7.1); the storage limit (§7.2).
- `position`: GNSS rate, last accuracy, speed accuracy; IMU rate (measured); EKF and map matching state.
- `developer`: speed cap override, RPM period and the other test switches; the ELM terminal.

### 9.3 `debug-terminal` (from Developer)

- ELM terminal: text input, send via `VehicleLink.exclusive` (polling pauses), scrolling transcript with tx/rx times and latency. Quick buttons: `ATI`, `ATRV`, `ATDPN`, `0100`, `010D`, `010C`, `0902`.

### 9.4 `trips` (from Trip recorder)

- List of logs: date, duration, distance, size, adapter, complete/incomplete. Actions: share, share all (ZIP), delete, delete all. Free space indicator. With upload on (§7.1): how many logs were sent, and that sent logs are deleted from the phone, so a short or empty list never reads as trips not recorded.

## 10. App configuration

Native configuration, all through config plugins (never by hand in `ios/` or `android/`):

- `modules/vehicle-link` + its config plugin (VEHICLE-LINK-SPEC §5.4).
- `modules/sensor-capture` + `NSMotionUsageDescription`.
- `expo-location` plugin: `isIosBackgroundLocationEnabled: true`.
- `expo-file-system` plugin: `enableFileSharing: true`.
- Localized permission strings (EN/UK) in `locales/`.

## 11. Phases

| #  | Phase                    | Depends on | Output                                                                                                                       |
| -- | ------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| L0 | Native spike             | —          | Both native modules + config compile in the CI `build-ios` job; IPA sideloaded; MX+ EA session over `com.obdlink` opens; one BLE clone + MX+ answer `ATI`; IMU 100 Hz and GNSS fields verified; event payload format chosen. |
| L1 | TS core (Windows-only)   | —          | `src/obd` (parser, probe, init, poller, engine state, emulator) + `src/triplog` (ULog encoder, schemas) with unit tests.       |
| L2 | PC tooling               | L1         | `tools/triplog` + golden fixture tests.                                                                                       |
| L3 | Services + dev UI        | L0, L1     | `vehicle-link`, `sensor-capture`, `trip-recorder` services; screens §9; export.                                                |
| L4 | Field                    | L2, L3     | Drives on the main test car with MX+ and BLE clones; tested-adapter table; first DR dataset.                                           |

L1 and L2 need no device and can start immediately.

Status: L0–L4 done: drives on the main test car with the MX+ (MFi) and the vLinker FD-IOS (BLE), and on a second
car over K-line; no cheap no-name clone yet.

## 12. Verification targets

1. Open the app in the car → auto-connect → start engine → `recording` within 5 s; lock the phone and drive 20+ min → log is continuous (no gaps > 1 s in IMU, GNSS ~1 Hz, OBD at the adapter's rate).
2. Auto stop-start at lights doesn't split the trip; key off → trip ends within ~15 s; restart within 15 min → new trip without opening the app.
3. Kill the app mid-trip → the file is readable up to the last ~1 s and listed as incomplete.
4. `triplog check` passes on field logs; OBD speed agrees with GNSS speed within 1 km/h at steady speed (SPEC §7.1).
5. Exported file opens in PlotJuggler and loads in Python on Windows.
6. Size ≈ 26 MB/h with default settings.
7. Lint, typecheck, TS and Python unit tests pass.

Results (2026-10-03, 7 drives):

- **1:** auto start ✓.
  - IMU: 100.6 Hz, max gap 10 ms.
  - OBD speed: 25–29 Hz.
  - GNSS: 1 Hz when clean, ~0.1 Hz jammed.
  - Not yet tested with the phone locked for 20+ min.
- **2:** trip ends ✓.
  - Ignition off: ended 10 s after the ECU went silent.
  - Parked with the engine off: ended at 5 min.
  - Link lost (driver walked away): ended at 2 min.
  - Back-to-back trips started on their own.
- **3:** ✓ (2026-10-04). The app was closed mid-trip: the log reads up to its last second, has no end record, and
  the next trip started 17 s later when the app was opened again.
- **4:** OBD reads about 2 % below GNSS (−0.3 … −0.8 km/h median); `triplog check` passes on the clean drives.
- **5:** logs load in Python ✓. PlotJuggler not tried.
- **6:** 26–27 MB/h ✓.

2026-10-04, 7 more drives (the dev UI's parked timeout was set to 1 min, so parked trips ended 60 s after
engine-off):

- **Raw magnetometer:** 19.4 Hz, always on with the IMU ✓. What it measures: NAVIGATOR-SPEC §7.5.
- **The driver walks off with the phone:** on 2 drives the phone left the mount after engine-off while the ECU was
  awake. The link was lost out of Bluetooth range (one trip ended by link timeout; on the other the driver came back
  and the link was restored). It looks like an adapter fault; the IMU and GNSS show the walk (NAVIGATOR-SPEC §9.1).
- **VIN:** read on 1 of 7 drives; the cause is fixed (VEHICLE-LINK-SPEC §9.1).

## 13. Open items

1. Files app visibility of `Documents/` (§7).
2. Tune trip thresholds (§4.2) from field data. So far the defaults behaved correctly on every drive.
