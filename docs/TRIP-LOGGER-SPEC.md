# wtf.ai — Trip Logger Specification

Trip detection, the ULog trip log, export and the opt-in upload, the PC reader. Adapter communication is
[VEHICLE-LINK-SPEC.md](VEHICLE-LINK-SPEC.md). Source of truth for coding agents.

## 1. Goal

1. Know when a trip starts and ends (engine on/off) without user interaction once the app is open.
2. Record each trip into a compact binary log: timestamps, vehicle speed, GNSS with its uncertainty, IMU, CAN
   frames, and what the navigator and the map did with them.
3. Move logs to a PC and read them there (Python, and the TS replay) to develop the navigator offline.
4. Pages to drive and inspect this (Trip recorder, trips, the ELM terminal).

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Log format | **ULog** (PX4), version 1: self-describing, append-only, truncation-tolerant. Readers: `pyulog`, PlotJuggler, Foxglove. |
| Log writer | Pure TS encoder (`src/triplog/`), file sink via `expo-file-system` (`File.open(FileMode.Append)` + `FileHandle.writeBytes`). |
| Sensor capture | `modules/sensor-capture`: CoreLocation + CoreMotion (LocationManager + SensorManager on Android), batched. The map's position uses the same streams (`SensorService` runs capture for the union of its owners: recorder, navigator). |
| Time base | Monotonic uptime µs for every record, the clock of `modules/vehicle-link` and CoreMotion. Wall clock via `time_sync`. |
| Automation | Open the app once; connect, trip start/end and recording are automatic and survive screen lock / background while the app stays alive (§4.3). |
| Permissions | Location **When In Use**: a session started in the foreground continues in the background with the indicator. Never "Always". |
| Export | Share sheet per trip or all trips as a ZIP; the app's Documents folder is visible to the Files app / USB file sharing. Export only by explicit user action, or the opt-in upload (§7.1). |
| PC tooling | Python package `tools/triplog/` (pandas, CSV/Parquet, plots, checks); the TS reader `src/triplog/trip-log-reader.ts` for replay. |

## 3. Components

```
modules/vehicle-link ──▶ src/services/vehicle-link ──(VehicleLink contract)──┐
modules/sensor-capture ─▶ src/services/sensor-capture ──(SensorStream)──▶ src/services/trip-recorder
                                                                            │  trip state machine (src/triplog/trip-detector.ts)
                                                                            ▼
                                                     src/triplog: ULog encoder + record schemas (schema.ts)
                                                                            ▼
                                                     file sink → Documents/trips/*.ulg → share sheet / Files app / upload
                                                                            ▼
                                                     PC: tools/triplog (Python), src/triplog/trip-log-reader.ts (replay)
```

- `src/triplog/**` has no React Native/Expo imports. The trip state machine is pure TS; `src/services/trip-recorder`
  wires it to the link and sensors and owns the pre-roll buffer, the writer and the trip index; it exposes a
  `TripRecorder` store (`getSnapshot`/`subscribe`).
- `src/services/runtime.ts` creates the link, sensor service, recorder and navigator once; `src/providers/
  runtime-provider.tsx` exposes them and auto-connects on launch/foreground.

## 4. Trip detection

### 4.1 States

| State | Meaning | Sensors |
| --- | --- | --- |
| `idle` | No adapter connected | off |
| `armed` | Adapter connected (`standby`/`polling`), no trip | off while `ignition-off`; on (pre-roll) once the ECU is awake |
| `recording` | Trip in progress, log file open | on |
| `lingering` | Trip ended; the app stays alive in case the next trip starts soon | on |

### 4.2 Transitions (`DEFAULT_TRIP_CONFIG`; engine states from VEHICLE-LINK-SPEC §10.4)

| Transition | Condition |
| --- | --- |
| `armed` → `recording` | `engine-running`, **or** 2 consecutive speed samples > 0 (a hybrid pulling away in EV mode) |
| `recording` → end | (a) parked ≥ 5 min: `engine-off` with speed 0, or `ignition-off`, so a short stop with the key out stays one trip (reason `ignition_off` when the ignition went off, else `parked_timeout`); (b) link lost and not back within 2 min (`link_timeout`; lost while parked, the adapter is asleep with the car and (a) ends the trip); (c) manual stop |
| end → `lingering` | close the log (`trip_event` end + reason), start the linger timer |
| `lingering` → `recording` | a new trip starts (new file) |
| `lingering` → `armed` | after 15 min; GNSS stops so the OS may suspend the app |

- Auto stop-start stops do **not** end a trip; only a long parked stop does.
- During link loss inside a trip, GNSS and IMU keep recording; `trip_event link_lost/link_restored` mark the gap.
- **Pre-roll**: from the moment the ECU wakes, sensors run into a 30 s ring buffer written at the start of the trip
  file (the standstill before pulling away: gyro bias).
- Manual start/stop in the Trip recorder (works without an adapter: GNSS + IMU only). Manual trips carry
  `start_reason = manual`.
- The parked and linger times are settings in the Trip recorder.

### 4.3 App lifecycle

The user opens the app; it auto-connects to the remembered adapter and goes `armed`. During `recording` and
`lingering`, background location (`allowsBackgroundLocationUpdates`, the indicator; Android the foreground service)
keeps the app running, so the poll loop, sensor batches and the writer work with the screen locked. In `armed` with
the ignition off and no linger, the app may be suspended.

- **Ended by the OS** (not by the user), the app comes back by itself on iOS:
  - **Location** (iOS 17+): a `CLBackgroundActivitySession` (`LocationKeepAlive`, `src/services/location-session.ts`)
    is held from every time the app is in front, whatever is connected: only one started in front counts, and "When
    In Use" can't start GNSS from the background without it (2026-10-21: the app placed the car, went behind the
    music, the engine started, and the whole 37 min drive had no fix, satellite or Wi-Fi). Held, a trip that starts
    with the app in the background gets GNSS, and iOS relaunches an app it ended; the app joins the session at launch
    (`AppHealthAppDelegate`), before JS, then auto-connects and records as usual. Let go 30 min after the app left
    the screen with no trip recording or lingering and the ECU asleep (the indicator shows while it is held), never
    with the app: one invalidated can't be started again from the background. Joined at a relaunch and not held again
    by JS within 2 min, it ends. Notes `location session held`, `… let go …`.
  - **The adapter** (VEHICLE-LINK-SPEC §11): Bluetooth state restoration relaunches the app for the adapter's link,
    mid-drive or when the car is switched on later; without a location session such a trip has no GNSS (it dead-
    reckons on the wheels).
  - **Never opened for the drive** (opt-in, location "Always", VEHICLE-LINK-SPEC §11): significant location changes
    relaunch the app a few hundred metres into a drive, whatever the adapter; "Always" starts GNSS from the
    background, and the pose where the car was parked is left aside (NAVIGATOR-SPEC §6.1).
  - **Swiped away** by the user, nothing brings it back reliably: iOS doesn't relaunch an app the user closed (the
    significant-change relaunch after a swipe varies by iOS version; reported gone on iOS 26).
- Without any of these, the next session begins when the user opens the app again.
- **A manual recording** (the Trip recorder's start button) the process ended without stopping starts again, in a new
  log, at the next start within 10 min of when it was last seen recording (`trips.manual`, refreshed every 30 s;
  note `manual recording resumed …`), after the trip-start listeners, so that log gets the launch notes. Opened later,
  it doesn't: a recording the driver has forgotten about.
- **Developer → *Simulate the system closing the app*** ends the process with `SIGKILL`, as the OS would, after a
  marker. On iOS it first posts `UIApplication.willTerminateNotification`: Sentry would otherwise report an app gone
  while in front as a watchdog (memory) termination. The delegate's `applicationWillTerminate` isn't called, so the
  next launch's previous-run note still reads as an end without notice.

### 4.4 The app process (`src/services/app-health.ts`, `AppHealth.swift`, `AppHealth.kt`)

Why: the app died mid-drive with no crash, memory or CPU report on the phone (2026-10-21), and a process that is
ended can't log why. What it can, it logs; the next process logs the rest.

- **`app_stats`** (§6.3) every 5 s: the memory the process holds and how much more the OS leaves it (iOS
  `os_proc_available_memory`, what jetsam ends it at), CPU, thermal state, low power mode, app state. In the log
  while a trip records (or its pre-roll).
- **A heartbeat** with each sample (iOS `UserDefaults`, Android `SharedPreferences`): time, app state, what the
  recorder did (`recording <trip id>`), memory, memory warnings. iOS also notes `applicationWillTerminate` (the OS
  saying it will end the app), synchronously.
- **At launch** (native, before JS): whether in the background and why (iOS launch options: `location`,
  `bluetooth`), the previous heartbeat, and what the OS reported: iOS MetricKit (exits by reason a day at a time,
  crash, hang and CPU reports; kept until a trip takes them, 20 at most), Android `ApplicationExitInfo` (reason,
  importance, memory; those newer than the last read).
- **Into the trip log** as notes at each trip's start: `app launched N s before this, in front | in the background
  (reasons)` (iOS `location`, `bluetooth`; Android the companion wake within a minute of the start, `ble in range`,
  `bluetooth connected` or `restarted with the device present`, VEHICLE-LINK-SPEC §11); the first trip of a process also `previous run: last seen … before this launch, <app state>, <what it
  did>, <memory>; ended without notice | the OS said it would end it …` and one note per OS report (`iOS exits …`,
  `iOS crash report …`, `Android exit …`). Memory warnings (iOS) and trim levels (Android) are notes when they
  come.
- **Sentry**: a previous run that was recording and ended without notice is a warning event (`app ended mid-trip
  without notice`) with the heartbeat's numbers: known without the trip log.

## 5. Sensor capture (`modules/sensor-capture`)

### 5.1 GNSS

- iOS `CLLocationManager`: `kCLLocationAccuracyBestForNavigation`, no distance filter, `automotiveNavigation`,
  `pausesLocationUpdatesAutomatically = false`, background updates with the indicator. Android: `LocationManager`
  `gps` and `network` providers (ANDROID-SPEC §2).
- Per fix: latitude, longitude, altitude (MSL and ellipsoidal), horizontal/vertical accuracy, speed, speed accuracy,
  course, course accuracy, the fix's wall-clock time, `isSimulatedBySoftware`, `isProducedByAccessory`. Invalid
  fields are omitted (NaN in the log).
- Fix timestamp → uptime: `fixUs = nowUptimeUs − (nowWall − fix.timestamp)` at delivery (Android: the fix's own
  `elapsedRealtimeNanos`). The delivery delay is recorded.
- No heading (`CLHeading` is the magnetometer).

### 5.2 IMU

- iOS `CMDeviceMotion` at **100 Hz**, reference frame `xArbitraryZVertical`: `rotationRate` (rad/s), `userAcceleration`
  and `gravity` (m/s²), `attitude.quaternion`; timestamp the sample's own uptime. Android: the equivalent sensors
  normalized to these conventions (ANDROID-SPEC §2). The rate is fixed: the navigator is tuned on 100 Hz. The raw
  gyro/accelerometer streams (the module's `raw` option) are not asked for; `gyro_raw` / `accel_raw` stay readable
  in older logs.
- Raw magnetometer, **always on** with the IMU, 20 Hz, µT in the device frame, uncalibrated. Logged, and fed to the
  compass in shadow mode (NAVIGATOR-SPEC §7.6).
- Device frame: Apple's (x right, y toward the top of the screen, z out of the screen).

### 5.3 Bridge (`src/SensorCaptureModule.ts`)

Functions `startGnss()`, `stopGnss()`, `startImu({ rateHz, raw, batchMs, magRateHz })`, `stopImu()`,
`getPermissions()`, `requestLocationPermission()`, `nowUs()`. Events `onGnss` per fix and `onImuBatch` every 100 ms
with columnar plain number arrays. Native configuration through config plugins only: `expo-location`
(`isIosBackgroundLocationEnabled`, the location and motion purpose strings), `expo-sensors`, `expo-file-system`
(`enableFileSharing`), localized strings in `locales/`.

## 6. Log format (ULog)

### 6.1 File

- Path: `Documents/trips/<startUTC as YYYYMMDD-HHMMSS>_<6-char id>.ulg`; manual sessions get the suffix `_manual`.
- Standard ULog v1 layout: 16-byte header, `B` flag bits, definitions (`I` info, `F` formats), then data (`A`
  subscriptions, `D` data, `C` tagged strings, `S` sync, `O` dropout, and `I` info for values learned after the
  header: readers keep the last value per key). Little-endian, no padding.
- Every subscribed message starts with `uint64_t timestamp` = monotonic uptime µs.

### 6.2 Info messages (`I`)

| Key | Value |
| --- | --- |
| `sys_name` | `wtf.ai` |
| `ver_sw` | app version, build number and the JS commit (`1.0.0 (3563887 abc1234)`) |
| `ver_update` | the JS that ran: `embedded`, the OTA update id, or `off` (Debug); ` emergency` appended when a broken update fell back to the embedded JS |
| `ver_runtime` | the build's OTA runtime version (fingerprint); empty in Debug |
| `upd_build`, `upd_js` | a newer build / a downloaded JS update waiting to be installed; empty when none |
| `sys_hw`, `sys_os_ver` | phone model identifier, OS version |
| `wtf_log_ver` | `1` (bump on a breaking schema change) |
| `trip_id` | the 6-char id from the file name |
| `start_reason` | `engine` / `speed` / `manual` |
| `adapter_transport` | `ble` / `mfi` / `spp` / `none` |
| `adapter_name`, `adapter_elm`, `adapter_chip` | advertised or EA name, `ATI`, `STI` (or empty) |
| `obd_protocol` | `ATDPN` answer |
| `vehicle_vin`, `vehicle_vin_source` | VIN or empty; `read` / `remembered` / empty (VEHICLE-LINK-SPEC §9.1); repeated in the data section when a retry reads it |
| `imu_frame` | `xArbitraryZVertical` |
| `nav_mapmatch_loop` | `closed` (older logs: `open` or `heading`) |
| `nav_phone_only` | `on` / `off`: navigation without an adapter (NAVIGATOR-SPEC §9.6); a change is the note `nav phone-only …` |
| `can_shadow` | `auto` (ids picked for the car, VEHICLE-LINK-SPEC §16.4) or `off` |
| `can_primary` | `on` / `off`: Settings → Car → Speed from the wheels (VEHICLE-LINK-SPEC §16.3) |
| `nav_wheel_yaw` | `on` / `off`: turns from the wheels (NAVIGATOR-SPEC §5.4); a switch is the note `nav wheel yaw on|off` |
| `position_share` | Android only, `on` / `off`: the car's position shared with Waze and Google Maps (ANDROID-SPEC §8). What they got is `share.ts` over `nav_estimate`; the notes `position share on|off`, `position share hold: <reason>`, `position share resumed`, `position share failed: <code> <message>` say when; `position share gps taken|probing|real|failed: <reason>` when Waze's `gps` provider was wtf.ai's (`taken: a fix <km> km off, next probe in <n> min`: a probe cut short by a spoofed fix) |

### 6.3 Data messages (`F` + `D`; `src/triplog/schema.ts`)

| Message | Fields (after `uint64_t timestamp`) | Rate |
| --- | --- | --- |
| `obd_pid` | `uint32_t latency_us` (rx − tx; the timestamp is **rx**), `uint8_t mode`, `pid`, `status` (§6.5), `n_bytes`, `uint8_t[4] data`, `uint16_t ecu` (CAN id or 0), `float value` (m/s for `0D`, rpm for `0C`, NaN otherwise) | every poll |
| `gnss` | `int64_t utc_us`, `double lat_deg`, `lon_deg`, `float alt_msl_m`, `alt_ellipsoid_m`, `h_acc_m`, `v_acc_m`, `speed_mps`, `speed_acc_mps`, `course_rad`, `course_acc_rad`, `uint32_t delivery_delay_us`, `uint8_t flags` (bit0 simulated, bit1 from accessory) | ~1 Hz |
| `imu_motion` | `float[3] gyro_rad_s`, `user_accel_m_s2`, `gravity_m_s2`, `float[4] attitude_q` (w, x, y, z) | 100 Hz |
| `gyro_raw`, `accel_raw` | `float[3]` | older logs only |
| `mag_raw` | `float[3] mag_ut` | 20 Hz |
| `engine_state` | `uint8_t state` (0 unknown, 1 ignition_off, 2 engine_off, 3 engine_running) | on change |
| `trip_event` | `uint8_t event` (0 start, 1 end, 2 link_lost, 3 link_restored, 4 marker, 5 preroll_end), `uint8_t reason` (end: 0 ignition_off, 1 parked_timeout, 2 link_timeout, 3 manual) | on event |
| `link_stats` | `float speed_hz`, `latency_p50_ms`, `latency_p95_ms`, `uint16_t errors`, `uint8_t link_state`, `float battery_v` (NaN if not read) | 1 Hz |
| `time_sync` | `int64_t utc_us` | at start, every 60 s, on a wall-clock jump |
| `app_stats` | the app process (§4.4): `float footprint_mb` (iOS the footprint jetsam weighs, Android PSS), `headroom_mb` (iOS left before jetsam ends the process, Android the system's available memory; NaN unknown), `cpu_pct` (since the previous record, % of one core; NaN first), `uint8_t thermal` (0 nominal, 1 fair, 2 serious, 3 critical), `app_state` (0 active, 1 inactive, 2 background, 3 unknown), `flags` (bit0 low power mode) | every 5 s |
| `nav_estimate` | what the map showed (NAVIGATOR-SPEC §9): `double lat_deg`, `lon_deg`, `float accuracy_m`, `heading_rad`, `heading_sigma_rad`, `speed_mps`, `speed_scale`, `gnss_lag_s` (NaN unknown), `uint32_t behind_us`, `uint8_t mode` (0 none, 1 anchored, 2 dr), `source` (0 gnss, 1 fused, 2 dr, 3 manual), `trust` (0 TRUSTED, 1 UNTRUSTED, 2 REACQUIRING, 3 NO_FIX), `parked_pose` (0 none, 1 unverified, 2 confirmed, 3 rejected, 4 behind: the app started on the way, VEHICLE-LINK-SPEC §11) | each map update, ~2–3 Hz |
| `nav_mapmatch` | map matching at that `nav_estimate` (MAPMATCH-SPEC §11): `uint8_t state` (0 off, 1 init, 2 tracking, 3 multimodal, 4 offroad), `clusters` (≤ 5), `uint16_t particles`, `uint32_t update_us`, `uint16_t update_count`, `uint32_t update_total_us`, `update_max_us` (every filter update since the previous record), `uint32_t graph_built` (the graph's build time), then the 3 heaviest hypotheses: `float[3] weight`, `double[3] lat_deg`, `lon_deg`, `float[3] heading_rad`, `spread_m` | with `nav_estimate` |
| `nav_route` | each route plan (ROUTING-SPEC §8): `uint16_t plan_id`, `uint8_t reason` (0 new, 1 off-route, 2 resume, 3 alternative, 4 placed), `status` (0 done, 1 no-road-at-start, 2 no-road-at-destination, 3 no-route, 4 too-far, 5 cancelled), `double from_lat_deg`, `from_lon_deg`, `float from_heading_rad`, `double to_lat_deg`, `to_lon_deg`, `float length_m`, `duration_s`, `off_start_m`, `off_end_m`, `uint32_t states`, `tiles`, `float plan_ms`, `wall_ms`, `uint16_t slices`, `points`, `maneuvers`, `uint32_t graph_built` | per plan |
| `nav_route_point` | the plan's polyline: `uint16_t plan_id`, `index`, `double lat_deg`, `lon_deg` | after `nav_route` |
| `nav_route_maneuver` | the plan's maneuvers: `uint16_t plan_id`, `index`, `uint8_t kind` (`ROUTE_MANEUVER_CODES`), `exit` (roundabouts), `double lat_deg`, `lon_deg`, `float at_m`, `turn_rad` | after `nav_route` |
| `nav_route_progress` | guidance at that `nav_estimate`: `uint16_t plan_id`, `uint8_t state` (0 on, 1 leaving, 2 off, 3 unsure, 4 arrived), `uint16_t next_index`, `float along_m`, `off_m` (NaN: nothing matched), `remaining_m`, `remaining_s`, `to_next_m` | with `nav_estimate` |
| `can_frame` | a raw CAN frame heard by the monitor (VEHICLE-LINK-SPEC §16.2); timestamp: arrival of its chunk. `uint32_t id`, `uint8_t len`, `uint8_t[8] data` | ~150–370/s |
| `can_window` | a listening window; timestamp: its start. `uint32_t duration_us`, `uint16_t frames`, `uint8_t flags` (bit0 the adapter stopped by itself, bit1 `BUFFER FULL`, bit2 the first stop character got no prompt), `uint32_t bytes`, `uint16_t other` (frames of ids not asked for), `uint16_t stop_ms` (0xFFFF: none), `uint8_t reopen` (0 already open, 1 bare `ATCRA`, 2 `ATCRAXXX`, 3 a full setup). A frame missing outside the windows wasn't heard | per window |

- `obd_pid` is lossless for single-response polls, so the poll transcript isn't duplicated as text. Speed sample
  time for analysis = `timestamp − latency_us / 2`.
- Additive schema changes don't bump `wtf_log_ver`; readers ignore fields and messages they don't know.

### 6.4 Text (`C` tagged logged strings)

- Tags: `1` ELM transcript, `2` link events, `3` trip recorder, `4` sensors, `5` app (markers, navigator, map
  matching, route, voice, GNSS trust and integrity notes as the other specs list them).
- ELM transcript: every non-poll exchange and every poll with a non-`ok` status or unexpected text, as
  `tx=<txUs> <command> | <raw response, CR escaped>`; the message timestamp is `rxUs`.
- **Before the log**: the recorder keeps the link lines of the adapter setup (200 at most, 10 min) and writes those
  older than the log's start at that start, as `<age> s before the log: <line>`: the probe, protocol search, init and
  VIN read of a trip are there.
- Levels: `'6'` info, `'4'` warning, `'3'` error, `'7'` debug.

### 6.5 `obd_pid.status`

`0` ok, `1` no_data, `2` timeout, `3` unable_to_connect, `4` bus_error, `5` unknown_command, `6` stopped,
`7` buffer_full, `8` parse_error, `9` other (the order of `ElmStatus`).

### 6.6 Writer behavior

- Encode in memory; flush every 1 s or 64 KB, followed by an `S` sync message. A crash loses at most ~1 s; `pyulog`
  reads truncated files. Files without a `trip_event end` are listed as "incomplete".
- If the sink falls behind (buffer > 1 MB), drop IMU batches and CAN frames and write an `O` dropout.

### 6.7 Size

About 7.8 KB/s with IMU, magnetometer and five CAN ids (≈ 28 MB/h); 26 MB/h without CAN. Recording refuses to start
below 200 MB free.

## 7. Export to PC

- **Share sheet** from the trip list: one `.ulg`, or **Share all** (every finished trip, stored, in one
  `wtf-trips-<UTC stamp>.zip` built in `Caches/trip-archives`, only the latest kept).
- **Files app / USB**: `enableFileSharing` exposes `Documents/` (with `trips/`).
- Delete single / all trips from the trip list.

### 7.1 Opt-in upload

Testers send logs without the share sheet. It must stay impossible for the app, or anyone holding a build, to read
logs back.

- **Path:** app → `workers/triplog-upload` (Cloudflare Worker, R2 binding) → private bucket. No storage keys in the
  app or the repo; the Worker can only add objects: `GET /me` (who a code belongs to), `PUT /logs/<trip file>` (201
  stored, 200 same name and size already there, 409 a different log has the name, 400 not a recorder file name, 413
  over 95 MB). Nothing lists, reads, overwrites or deletes.
- **Codes:** one per person, `npm run testers:add -- <name> [--owner]`, shown once: three pronounceable groups
  (`bakim-tuvod-segap`, ~51 bits; case, spaces and dashes ignored). The bucket keeps only the SHA-256
  (`testers/<hash>.json` → name, owner flag). `testers:remove` revokes a code; the logs stay. Shared rules:
  `src/triplog/upload-protocol.ts`.
- **Where logs land:** the owner's phone in `logs/` beside the project's logs; a tester's in `logs/testers/<name>/`.
- **App** (`src/services/trip-upload/`): off until a code is entered in the Trip recorder; the code is kept in the
  keychain (`expo-secure-store`). Uploads run after a trip ends, on foreground and on network changes, oldest first,
  one at a time; the log being written is never sent; Wi-Fi only by default. A sent log is deleted from the phone
  (if the deletion fails it is remembered as sent). A refused log is kept and marked; a revoked code stops uploads.
  A code is kept only after a confirmation that names the tester and what is sent. Store builds show the upload
  only after the Developer unlock (STORE-REVIEW §1).
- **PC:** `npm run logs:pull` brings uploads down with everything else (`tools/triplog/README.md`).

### 7.2 Storage limit

Logs may take at most a set amount of space (Trip recorder slider 0.25–10 GB, default 1 GB ≈ 200 drives). A few
seconds after a trip ends or the limit changes, the oldest finished logs are deleted until all fit. The log being
written, and logs waiting for upload while upload is on, are never deleted.

## 8. PC tooling (`tools/triplog/`, Python)

`pip install -e "tools/triplog[dev]"`. `from triplog import load` gives `trip.info`, `trip.obd`, `trip.obd_speed`,
`trip.obd_rpm`, `trip.gnss`, `trip.imu` (with `yaw_rate_up`), `trip.mag`, `trip.engine`, `trip.trip_events`,
`trip.link_stats`, `trip.app_stats`, `trip.time_sync`, `trip.transcript`, `trip.map_match`. CLI: `triplog info`, `export`, `plot`,
`check`, `refresh` (`tools/triplog/README.md`). Cross-language golden test: `src/triplog/__fixtures__/trip-fixture.ts`
builds `tools/triplog/tests/data/fixture.ulg` (regenerate with `UPDATE_TRIPLOG_FIXTURE=1 npx jest src/triplog`); the
TS test checks the bytes, the Python tests load it. The TS reader (`src/triplog/trip-log-reader.ts`) feeds the replay.
Real logs go in `tools/triplog/logs/` (git-ignored).

## 9. Pages

### 9.1 `vehicle` (from the map's bar)

The device list per VEHICLE-LINK-SPEC §7 (sections, RSSI bars, brand hint, scanning indicator, "New adapter", "Try
anyway", "Forget"); the connected adapter's name and state; whether the car answers (engine running, ignition on with
the engine off, ignition off, waiting), its speed now, and where the speed comes from: the wheels, or OBD and why not
the wheels (`components/vehicle/car-status.ts`). The last error; "Share GATT dump" for an unknown device that
failed, so it can be added to the catalog. The adapter's chip, firmware, protocol, poll timing and the learned
calibration are in the trip log, not on the page.

### 9.2 `recorder` and `developer` (from More)

- `recorder` holds all of trip logging: state, current trip id, duration, file size, start reason; Start (manual) /
  Stop / Marker; the `trips` list; the parked and linger times (§4.2); the upload code (§7.1); the storage limit
  (§7.2).
- `developer`: Show emulated adapters, Map matching on the map (particles), the GPS outage button, Navigate without
  an adapter, RPM period; the ELM terminal and the UI gallery (UI-SPEC §7.3).

### 9.3 `debug-terminal` (from Developer)

ELM terminal: text input, send via `VehicleLink.exclusive` (polling pauses), the transcript with tx/rx times and
latency; quick buttons `ATI`, `ATRV`, `ATDPN`, `0100`, `010D`, `010C`, `0902`; the CAN port survey
(VEHICLE-LINK-SPEC §16.1): all ids for 3 s, or the ids typed for 10 s.

### 9.4 `trips` (from the Trip recorder)

Date, duration, distance, size, adapter, complete/incomplete; share, share all, delete, delete all; free space. With
upload on: how many logs were sent, and that sent logs are deleted from the phone.

## 10. Verification targets

1. Open the app in the car → auto-connect → start the engine → `recording` within 5 s; lock the phone and drive
   20+ min → a continuous log (no IMU gaps > 1 s, GNSS ~1 Hz, OBD at 2 Hz or CAN at ~10 Hz).
2. Auto stop-start doesn't split the trip; key off → the trip ends within ~15 s of ECU silence (or after the parked
   time); a restart within the linger → a new trip without opening the app.
3. The app killed mid-trip → the file reads up to the last ~1 s and is listed as incomplete.
4. `triplog check` passes on field logs; the TS and Python readers agree on the fixture.
5. Lint, typecheck, TS and Python unit tests pass.
