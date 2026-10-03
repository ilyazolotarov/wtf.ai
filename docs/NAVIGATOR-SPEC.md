# wtf.ai — Stage 1 Navigator Specification

Status: draft v2 (2026-10-03). Implements SPEC.md Phase 2 (TS EKF + replay) and the parts of Phase 4 (calibration) that
need no UI. Source of truth for coding agents. Inputs come from [TRIP-LOGGER-SPEC.md](TRIP-LOGGER-SPEC.md) streams;
the vehicle link is specified in [VEHICLE-LINK-SPEC.md](VEHICLE-LINK-SPEC.md).

## 1. Goal

Turn OBD speed, phone gyro and CoreLocation fixes into one position with an honest uncertainty, including while GNSS is
jammed:

1. Keep the position moving by dead reckoning (DR) when GNSS is lost, with a radius that grows the way the error does.
2. Start without a GNSS course, which jamming takes away, by using whatever coarse fixes iOS still gives.
3. Calibrate itself online (gyro bias, speed scale, GNSS timing), so tuning doesn't depend on one phone or car.
4. Be developed and measured on Windows by replaying real trip logs.

## 2. Status (2026-10-03)

- **Implemented:** `src/nav` (pure TS), replay CLI, browser viewer and outage benchmark (`tools/replay`), 30+ unit
  tests.
- **Measured** on 7 real drives: CX-5 KF, OBDLink MX+, iPhone 13 (iOS 26), phone in a mount, Slavutych. Of these,
  4 drives have clean GNSS, 1 is jammed then clean, and 2 are jammed throughout.
- **Wired into the app** (§9): `NavigatorService` drives the map and saves the GNSS lag and the speed scale (§7.4).
  Checked by replaying the real logs through the service; not field-tested yet.

## 3. Inputs (`src/nav/types.ts`)

| Input            | Source                                                | Rate          | Notes                                                    |
| ---------------- | ----------------------------------------------------- | ------------- | -------------------------------------------------------- |
| `ImuSample`      | CoreMotion device motion (`xArbitraryZVertical`)      | 100 Hz        | gyro, gravity, user acceleration; device frame           |
| `ObdSpeedSample` | PID `0D`; time = midpoint of tx and rx                | ~27 Hz moving, 1 Hz parked | raw km/h byte kept (1 km/h resolution, 0 below ~2–3 km/h) |
| `GnssFix`        | CoreLocation via `modules/sensor-capture`             | ~1 Hz; jammed: ~0.1 Hz | invalid fields absent; simulated fixes dropped by the reader |

- **Satellite fix vs coarse fix:** a satellite fix has a speed (0 when standing) and `h_acc < 50 m`. Under jamming iOS
  falls back to Wi-Fi/cell positions with no speed. Their claimed accuracy ranges from ±7 m (dense Wi-Fi) to 150 km.
  They're often repeated and their errors are correlated. Accuracy alone can't tell the two kinds apart.
- All timestamps are monotonic uptime µs. Every input must be fed in time order (`Navigator.onImu / onObdSpeed /
  onGnss`).

## 4. Modes (`src/nav/navigator.ts`)

| Mode       | Position                                    | Uncertainty                                  | Leaves when                                   |
| ---------- | ------------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| `none`     | —                                           | —                                            | first usable fix → `anchored`; parked pose (§6.1) → `dr` |
| `anchored` | best recent fix (heading unknown)           | fix accuracy + OBD distance driven since it  | heading known (§6) → `dr`                     |
| `dr`       | EKF                                         | EKF covariance (reported as a 68 % radius)   | 5 satellite fixes in a row fail the gate → `anchored` at the latest fix |

- **Fix filtering:** fixes worse than 2 km are ignored. Coarse repeats of the same position are skipped. Satellite
  repeats while parked are kept, because they are real measurements.
- **Frame:** local ENU plane, re-anchored when the position is more than 5 km from its origin.

## 5. Odometry inputs

### 5.1 Gyro (`odometry/imu/imu-processor.ts`)

- Yaw rate = gyro · up (up = −gravity), so it doesn't depend on how the phone sits in the mount. Counter-clockwise
  is positive.
- **Handling detection:** the gyro is invalid while the phone moves in the mount or in a hand. Triggers:
  - Gravity direction differs from its 3 s average by more than 8°.
  - The 0.1 s mean of rotation off the vertical exceeds 1.5 rad/s.

  Each trigger holds for 1.5 s. Thresholds come from mounted driving, which stays under 4° and about 1 rad/s.
  Single bump spikes reach 1.9 rad/s, which is why the rotation rate is averaged.
- While the gyro is invalid: if the car stands (OBD 0) the heading is held, because the car can't be turning.
  Otherwise the EKF propagates without yaw input and with heading noise 0.3 rad/√s.
- **Quiet:** over 1 s, the yaw-rate std is below 0.01 rad/s, the mean yaw below 0.005 rad/s, and the acceleration std
  below 0.2 m/s². Standstill = OBD 0 + quiet for 2 s.

### 5.2 OBD speed

- Each sample updates `v = k_s · s_OBD` with σ 0.3 m/s. A raw 0 gets σ 0.8 m/s, because the ECU cuts off below
  ~2–3 km/h.
- At standstill a zero-velocity update (σ 0.02 m/s) replaces the OBD update.
- OBD speed older than 2.5 s (link lost) is unknown: the relative track breaks (alignment and lag windows start
  over), and the anchored radius keeps growing at the last speed. The EKF's own speed random-walks meanwhile.
- CX-5: OBD reads about 2 % below GNSS. Direct comparison gives 1.016–1.021; `k_s` learns 1.00–1.03 per drive.

## 6. EKF (`ekf/dr-ekf.ts`) and heading initialization

- **State:** `E, N, ψ` (clockwise from north), `v`, `k_s`, `b_ω`, `k_ω`.
- **Prediction:** at the IMU rate, `ψ̇ = −k_ω (ω − b_ω)`, with `v` as a random walk. Joseph-form updates are used.
- **GNSS updates** (no integrity module yet, SPEC Phase 3):
  - **Position:** σ = `h_acc / 1.5` for satellite fixes and `h_acc` for coarse ones, with a χ² gate of 16.
  - **Speed** (satellite only): compared with the state 1.0 s earlier (Doppler smoothing).
  - **Course** (satellite only): when ≥ 4 m/s, with σ = max(course accuracy, 2°).
  - **Timing:** position and course are compared with the state at fix time − GNSS lag (§7.3), taken from a 3 s
    history; the correction applies to the current state.
- **Why coarse fixes are used:** in real jammed drives they were honest about their accuracy. 79–90 % landed inside
  their own radius around the DR prediction. They are also the only absolute position available, and GNSS spoofing
  doesn't move Wi-Fi/cell positions. They never count as trusted GNSS (§8).
- **Heading initialization:**
  - **Course:** from a satellite course at ≥ 5 m/s with course accuracy ≤ 10°. When pulling away, CoreLocation's
    course can be tens of degrees off while claiming ±18°.
  - **Alignment** (`ekf/heading-align.ts`): a relative OBD + gyro track, in an unknown rotation, is fitted to the
    fixes with a weighted 2D rotation + translation. Outliers beyond 3σ are dropped one at a time.
    - Fixes less than 25 m apart along the track count as one, because errors at one place are correlated.
    - It starts the EKF when the fitted heading σ ≤ 10° and the fixes span ≥ 150 m (unweighted extent).
    - Position σ = fit noise + heading σ × the lever arm to the fixes.
    - On the jammed drives it started after about 450–600 m. One drive never got enough distinct fixes and stayed
      anchored, which is correct.
  - **Parked pose** (§6.1): from the previous session, before any fix.

### 6.1 Parked pose (SPEC §3.3 startup)

- **Why:** a session otherwise has no heading until a GNSS course (≥ 5 m/s) or, under jamming, alignment after
  ~500 m. The car usually starts where it was parked, facing the same way.
- **Saved** (`Navigator.parkedPose`): position, heading and their σ while the car stands (standstill, or OBD 0) in
  mode `dr`. The service stores it per VIN at engine/ignition off, every 30 s while parked, and when it stops.
  The first OBD speed > 0 clears it, so a pose never outlives a drive.
- **Used** (`Navigator.startFromPose`): when the app starts and the VIN matches, the car of the adapter auto-connect
  will use, known before it connects. The EKF starts at once with σ widened by 5 m and 2°. Refused if the fixes so
  far disagree with it.
- **Checked:** until confirmed, any fix that fails the EKF gate drops it (the car was moved or turned): reset to
  `anchored` at that fix, and the stored pose is deleted. It is confirmed by an agreeing fix ≤ 100 m after 150 m of
  driving, because a fix while parked says nothing about the heading. A live VIN other than the expected one
  restarts the navigator without it.
- **Not checked:** with no fix at all, nothing can tell that the car was moved while the app was off.
- **Measured** (`replay --chain`, 3 consecutive pairs of the real drives):
  - q8tfjs, jammed for its first 10 min: DR from 0 s instead of alignment at 613 s; coarse fixes median 9 m from
    the prediction, 90 % inside their radius.
  - 6vccgr: DR from 0 s instead of a course at 136 s; 49 m off at the first satellite fix after 850 m.
  - s4fkdm: DR from 0 s instead of a course at 162 s.
  - Wrong poses: 300 m off is dropped by the first fix; a heading turned 180° is dropped on all 3; 90° on 2 of 3
    (on the jammed one, coarse fixes pulled the heading round instead).

## 7. Calibration (online)

### 7.1 Gyro bias

Learned at standstill from the mean yaw over 1 s (σ 0.002 rad/s, gated). The prior is tight (0.0005 rad/s) because
CoreMotion's rate is already bias-corrected: 0.007 °/s was measured at standstill. A loose prior let GNSS course errors
leak into the bias.

### 7.2 Gyro scale `k_ω`

- Over 13 complete turns (1006°), gyro and GNSS course agreed within a median 0.4° per turn. The scale is
  1.007 ± 0.005, so the gyro is fine.
- The EKF still learns 1.02–1.04, because at 1 Hz GNSS a timing mismatch looks like a scale error. Fixing
  `k_ω = 1` didn't change the outage error, so it stays a state with a 0.02 prior.
- Revisit it with map matching or a Stage 2 yaw source.

### 7.3 GNSS lag (`calibration/gnss-lag.ts`)

- **Why:** CoreLocation filtering can differ per phone model and iOS version, so the lag is measured instead of
  hard-coded.
- **Method:** take 30 s windows (a new one every 10 s) that contain a ≥ 30° turn, ≥ 25 satellite fixes ≤ 10 m, and
  speed ≥ 3 m/s. For each candidate lag (−0.5…1.5 s, step 0.05), fit the relative track to the fixes with a similarity
  transform (rotation, translation, scale) and add up the residuals. A wrong lag cuts corners, so the minimum marks
  the true lag. Straight roads can't show a lag.
- **When it's used:**
  - Only after 6 windows (overlapping windows: about two turns, 1–3 min of city driving) and only if the minimum
    isn't on the edge of the grid.
  - Until then `gnssLagS` (default 0) applies. An explicit lag (`estimateGnssLag: false`) switches it off.
- **Measured:** −0.1 ± 0.1 s on all drives (fit RMS 1.4 m vs 2.6 m at +0.4 s). An earlier 0.4 s guess from one turn
  cost about a third of the outage accuracy.

### 7.4 Persistence (`src/services/navigation/calibration-store.ts`)

Learned values go to kv-store (`nav.calibration`) every 30 s and when the navigator stops, so the next session starts
calibrated. They only replace defaults after enough data. The parked pose (§6.1) is kept separately
(`nav.parkedPose`).

- **GNSS lag**, per phone model (`sys_hw`) and iOS version: saved once §7.3 has an estimate (6 turn windows), used
  as `gnssLagS` on the next start until the new session measures its own. A value from another model or iOS version
  is dropped.
- **Speed scale `k_s`**, per VIN: saved once its σ ≤ 0.01 (clean GNSS gets there in 1–2 km; jammed drives stay at
  ~0.025 and don't save). It seeds the next EKF with its σ widened by 0.01, since one car's drives learn 1.00–1.03.
  Within a session it also survives an EKF reset.
- **Not stored:** the gyro bias (CoreMotion corrects it, and it drifts with temperature) and `k_ω` (the learned
  value mostly absorbs GNSS timing, §7.2).

## 8. Trust (interim, `src/services/position/gnss-trust.ts`)

Until `src/nav/integrity` (SPEC Phase 3), the map's trust state comes from `GnssTrustTracker`:

- **Good fix:** a satellite fix (has a speed) with accuracy ≤ 50 m. Wi-Fi/cell fixes never count, however
  accurate they claim to be. Counting them used to flip trust on 8 times on a jammed drive.
- **Losing trust:** no good fix for 8 s → `NO_FIX`.
- **Regaining trust:** satellite fixes ≤ 30 m arriving steadily for 5 s.
- Trust changes are written to the trip log (app tag: `gnss trust <state> (±N m)`).

## 9. Wiring into the app (`src/services/navigation/navigator-service.ts`)

- **NavigatorService:**
  - Owns one `Navigator`. It takes GNSS and IMU from `SensorService` (owner `navigator`: IMU runs whenever the
    navigator does) and speed from `VehicleLink.onSpeed`.
  - It is the runtime's `PositionSource` (§4.3 of UI-SPEC), so the map switched source without UI changes.
  - **Runs** while the map is on screen or a trip records, so DR isn't interrupted when the app is backgrounded
    mid-trip. When it stops, the next start begins with a fresh navigator (the car may have moved).
  - **Input order:** inputs are held 300 ms and fed in time order, because IMU arrives in 100 ms batches and fixes
    ~50 ms late (p90 on the real logs; outliers take seconds). A fix more than 2 s behind is dropped.
  - **Display:** the DR position is extrapolated along the heading to "now" (≤ 1 s), since the navigator runs
    300 ms behind.
  - A new VIN starts a new navigator. At start the VIN is `VehicleLinkCore.expectedVin()`: the connected car's,
    else the last verified adapter's car, so the parked pose (§6.1) applies before the adapter connects.
- **Mapping to `PositionEstimate`:**
  - mode `dr` → `source: 'fused'` while trust is `TRUSTED` and a satellite fix was accepted in the last 3 s, else
    `'dr'`;
  - `anchored` → `source: 'gnss'` with the grown radius;
  - trust from §8;
  - `rawGnss` = the latest fix, for the ghost marker; `distanceSinceTrustedM` from OBD.
- **Without OBD speed** (no adapter, or none for 10 s): phone GNSS only, as before. The navigator needs OBD speed
  for DR.
- **Trip log:**
  - `nav_estimate` (TRIP-LOGGER-SPEC §6.3): every position the map was given (~2–3 Hz). It holds the drawn
    position and radius, mode, source, trust, heading and its σ, `k_s`, the GNSS lag in use, the parked-pose status,
    and how far the navigator ran behind (`behind_us`, ~300 ms). This is what the driver saw, including the stored
    calibration and parked pose that a replay doesn't have.
  - Mode changes, resets, the parked pose (saved, used, confirmed, rejected), and loaded/saved calibration are app
    notes (`nav …`).
- **Persistence** per §7.4.
- **Tests:** unit tests replay synthetic drives through the service. The 7 real logs replayed through it (real
  delivery delays) match the offline replay: median 0.1–1 m apart, identical learned values.
- **Next:** a field drive (§12.6).

## 10. Replay and benchmark (`src/nav/replay`, `tools/replay`)

- **Replay:** merges the three streams in time order and runs the navigator. It scores each fix before its update
  (pre-fix error) and can withhold GNSS: `--cut start:len`, or `--open-loop` from the heading fix to the end.
- **Held-out fixes:**
  - They are scored at a fixed lag (`truthLagS`, default 0), so variants of the navigator's own lag share one
    yardstick.
  - Only satellite fixes ≤ 10 m count as truth.
- **`npm run replay:bench`:**
  - Outages of 60/120/240 s starting every 30 s after the EKF starts. A window counts when the held-out satellite
    fixes cover ≥ 80 % of it and the car drives ≥ 200 m.
  - Reports max and end error (median, p90), error per km, and max error ÷ predicted σ.
  - Windows overlap, so small differences are noise.
- **Current numbers** (56 windows, 7 drives):

| Outage | Median distance | Max error median / p90 | Max error ÷ σ |
| ------ | --------------- | ---------------------- | ------------- |
| 60 s   | 0.65 km         | 11 / 21 m              | 1.5           |
| 120 s  | 1.3 km          | 20 / 31 m              | 0.9           |
| 240 s  | 2.1 km          | 37 / 88 m              | 0.6           |

- **Error budget:**
  - About 2° RMS heading error already at the start of the outage, growing only to 2.8° after 3 min.
  - ±2–3 % along-track error.
  - Gyro drift is not the limit.
- **Tried with no effect:** fixed `k_ω`, course updates only on straight road, and lower gyro noise. Gyro noise
  ≤ 0.001 makes the filter overconfident; 0.003 is kept.
- **Viewer:** `npm run replay:view` is a local map with timeline, cuts and side-by-side GNSS vs prediction; see
  `tools/replay/README.md`.

## 11. Tuning values and what they depend on

| Value                         | Default | Depends on               | Handling                                         |
| ----------------------------- | ------- | ------------------------ | ------------------------------------------------ |
| GNSS position/course lag      | 0 s     | phone model, iOS         | measured online (§7.3)                           |
| GNSS speed lag                | 1.0 s   | phone model, iOS         | fixed; results barely change between 0.4 and 1.6 s |
| Gyro noise                    | 0.003 rad/s | mount, car (not the gyro) | from `replay:bench`; re-check with more phones/mounts |
| Handling thresholds           | 8°, 1.5 rad/s, 1.5 s | mount, road | from logged mounted drives                    |
| Gyro bias prior               | 0.0005 rad/s | CoreMotion          | learned at every stop                            |
| OBD speed scale `k_s`         | 1 ± 0.03 | car, tyres              | learned online; persist per VIN (§7.4)           |

All tuning so far comes from one phone, one mount and one car. Logs from a second iPhone generation and mount are
needed to check them (`replay:bench`).

## 12. Verification targets

1. `replay:bench` after any navigator change: no worse than §10 at 60/120 s. Max error ÷ σ stays between 0.5 and 2.
2. Jammed drives: the EKF starts by alignment once distinct coarse fixes span ≥ 150 m; ≥ 75 % of later coarse fixes
   fall inside their own radius.
3. Standstill: heading change < 0.5° over a 60 s stop, including handling the phone while parked.
4. The GNSS lag estimate lies within ±0.1 s of the per-drive turn fit on every drive with ≥ 6 turn windows.
5. Unit tests (`src/nav/__tests__`, synthetic drives) pass; lint and typecheck pass.
6. Field (after §9): during a real jamming episode the map dot keeps moving, and its radius covers the true position.
   - **Truth:** the first satellite fixes after the outage, compared with `nav_estimate` at the same time. That's
     where the DR error is largest. It needs nothing done in the car; a second phone in the same car is jammed too.
   - Error during an outage is measured by `replay:bench` on clean drives (§10).

## 13. Open items

1. **Heading at outage start** (about 2° RMS) limits DR. Candidates: map matching (SPEC §3.7), longer GNSS baselines.
2. **OBD speed truncation at low speed:** could explain the ±2–3 % along-track error. Check on logs; consider a speed
   offset state (SPEC §9.2).
3. Longer outages (5 / 15 min, SPEC §7) need longer clean drives than the current logs.
4. Second phone and mount, to check the tuning values (§11).
5. Integrity (SPEC Phase 3) replaces the interim trust tracker and the EKF gate as the GNSS acceptance rule.
6. Spoofing replay: offsetting fixes in clean logs (SPEC §3.10) isn't implemented yet.
7. Replay doesn't load the stored calibration or parked pose a live session started from. `nav_estimate` and the
   `nav …` notes record them; use `--lag` and `--chain` to come close.
