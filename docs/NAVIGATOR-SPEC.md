# wtf.ai — Stage 1 Navigator Specification

Status: draft v3 (2026-10-04), field-tested. Implements SPEC.md Phase 2 (TS EKF + replay) and the parts of Phase 4 (calibration) that
need no UI. Source of truth for coding agents. Inputs come from [TRIP-LOGGER-SPEC.md](TRIP-LOGGER-SPEC.md) streams;
the vehicle link is specified in [VEHICLE-LINK-SPEC.md](VEHICLE-LINK-SPEC.md).

## 1. Goal

Turn OBD speed, phone gyro and CoreLocation fixes into one position with an honest uncertainty, including while GNSS is
jammed:

1. Keep the position moving by dead reckoning (DR) when GNSS is lost, with a radius that grows the way the error does.
2. Start without a GNSS course, which jamming takes away, by using whatever coarse fixes iOS still gives.
3. Calibrate itself online (gyro bias, speed scale, GNSS timing), so tuning doesn't depend on one phone or car.
4. Be developed and measured on Windows by replaying real trip logs.

## 2. Status (2026-10-04)

- **Implemented:** `src/nav` (pure TS), replay CLI, browser viewer and outage benchmark (`tools/replay`), 30+ unit
  tests.
- **Measured** on 14 real drives: CX-5 KF, OBDLink MX+, iPhone 13 (iOS 26), phone in a mount, Slavutych. Of these,
  10 have clean GNSS, 1 is jammed then clean, and 3 are jammed throughout.
- **Wired into the app** (§9) and **field-tested** on the 7 drives of 2026-10-04 (§9.1), one of them jammed
  throughout.

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

- **Fix filtering:** fixes worse than 2 km are ignored. A coarse fix that moved less than 2 % of its accuracy since
  the previous fix is a repeat and is skipped.
  - iOS repeats Wi-Fi positions with sub-metre jitter (≤ 0.8 % of their accuracy in the logs). Counted as new, six
    of them turned the heading by 22° on a jammed drive.
  - Dense-area Wi-Fi at ±7–15 m moves 0.4–1.7 m between fixes, which is new information: an absolute 2 m rule
    skipped 52 such fixes on one drive and cost outage accuracy.
  - Satellite repeats while parked are kept, because they are real measurements.
- **Frame:** local ENU plane, re-anchored when the position is more than 5 km from its origin.

## 5. Odometry inputs

### 5.1 Gyro (`odometry/imu/imu-processor.ts`)

- Yaw rate = gyro · up (up = −gravity), so it doesn't depend on how the phone sits in the mount. Counter-clockwise
  is positive.
- **Handling detection:** the gyro is invalid while the phone moves in the mount or in a hand. Triggers:
  - Gravity direction differs from its 3 s average by more than 8°.
  - The rotation off the vertical, averaged as a vector over 0.1 s, exceeds 1.0 rad/s.

  Each trigger holds for 1.5 s. Thresholds come from mounted driving, which stays under 4°.
  - Bumps shake the phone back and forth: the vector mean stays ≤ 0.7 rad/s with ≤ 4° net rotation. Every real
    handling in 14 drives reached ≥ 1.4 rad/s and ≥ 7.6°.
  - The first version averaged the magnitude, which bumps pushed to 1.6–2.0 rad/s: 6 false triggers while driving
    in 4 of 14 drives. Each added ~20° of heading σ (0.3 rad/√s over 1.5 s). On the jammed drive the radius reached
    370 m instead of 90 m, while the heading stayed within ~5° (§7.5).
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
- **Frozen** at the first handling while parked. The driver often takes the phone out and walks off with it while
  the ECU is still awake (2 of 7 drives on 2026-10-04). The fixes then follow the driver, and without the freeze
  the saved pose would follow them too. A fix that rejects an unverified pose also drops the frozen one.
- **Needs the VIN.** On 2026-10-04 it was never used: the VIN was read on 1 of 7 drives (VEHICLE-LINK-SPEC §9.1,
  now fixed). Every drive started anchored for 72–264 s, though the car always stood within 3–9 m of where the
  last one ended.
- **Reversing:** the CX-5 reads OBD 0 while reversing (VEHICLE-LINK-SPEC §10.4). Reversing into a parking space
  turns the saved heading in place without moving the position (5–15 m).
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

### 7.5 Magnetometer (logged, not used; SPEC §2)

Measured on the 7 drives of 2026-10-04 (`mag_raw`, 19.4 Hz):

- **Field:** about 160 µT raw against Earth's ~50 µT: a large constant offset (the phone's own and the car's). The
  heading-dependent part is 17–19 µT, Earth's horizontal field in Slavutych, so the car hardly distorts it.
- **Calibration:** horizontal components in a gravity-levelled frame fixed to the phone, fitted against GNSS course
  as offset + rotation + scale (4 parameters, linear least squares).
- **Error** with the calibration from the other drives:
  - median 4–18°, p90 12–31° per drive;
  - under 90° for every sample, except where the GNSS course itself was wrong at low speed;
  - over the first 200 m after pulling away, median 5–24°;
  - within one mounting of the phone, 4–6°.
- **What moves it:** taking the phone out of the mount and back, ~6 µT (15–20°); starting the engine, 2–4 µT.
- On the jammed drive it agreed with the DR heading within ~5° until near-repeated coarse fixes turned it (§4).
- **So:** it picks the travel direction along a road at a jammed start with a wide margin, and could be a weak
  absolute heading (σ ≈ 25°).

### 7.6 Compass (`compass/compass.ts`, replay only)

- **Input:** `Navigator.onMag` (raw field), the IMU's gravity and yaw rate, `setCompassCalibration` from earlier
  drives; `compassCalibration` is what to keep for the next drive.
- **Model** (§7.5): levelled horizontal field = offset + rotation and scale of Earth's field, in a frame fixed to
  the phone (the axis nearest the horizontal, projected). Kept as the fit's normal equations, so drives add up.
  Holds only for the mounting it was learned in: tilted more than 10° from it, there is no heading.
- **Learning:** once a second while the EKF heading σ ≤ 3°, at ≥ 4 m/s, driving straight (< 3° over the 1 s
  window), with the phone in its mount. A fit needs 60 samples over 5 of 8 heading sectors: alone, only the two
  longest drives of 2026-10-04 reached that; pooled, all drives do.
- **Trust:** a stored calibration starts `unverified` and is judged on its own (what the drive learns doesn't
  correct it before the check). The first 10 learning moments compare it with the EKF heading: median > 45° →
  `rejected`, the stored one is dropped and the drive's own learning takes over; else `confirmed`. Measured:
  calibrations from the other drives were confirmed on all 6 drives that could check (median 3–20° off);
  turned 90° or 180°, rejected within the first 10 checks on 4 of 6. On the other two the turned calibration
  was never used before the drive learned its own.
- **Kept for the next drive** with `confirmed`: everything in it was learned or confirmed on this drive. A drive that
  never checked its stored calibration (no known heading while driving straight) keeps it unconfirmed; the next
  drive still checks it, but hands out no heading until it passes.
- **Use:** only the particle filter's jammed start (MAPMATCH-SPEC §8.2). A jammed drive can't check the compass
  before it has a heading from elsewhere: the calibration is trusted on the last drive's word. Not covered: the
  phone turned in its mount at the same tilt (the tilt check doesn't see it); turned 90° or 180°, it gave 3 wrong
  map starts in 180 benchmark sessions (MAPMATCH-SPEC §8.2).
- **Next: shadow mode in the app** (decided 2026-10-04). The app runs the compass but doesn't navigate with it,
  until real drives show how often a stored calibration is wrong (the phone turned in its mount at the same tilt
  is the case nothing catches).
  - `NavigatorService` feeds `mag_raw` to `Navigator.onMag` and stores `compassCalibration` per VIN, next to the
    parked pose and `k_s`; the next drive loads it with `setCompassCalibration`.
  - A navigator option (shadow / on) keeps the compass heading away from the particle filter in shadow; learning
    and the trust check run as in replay.
  - Logged per drive (app notes, so replay and `triplog` read them): at each filter start with the heading
    unknown, the compass heading and its trust; once the heading is known, the compass minus the known heading,
    and the trust verdict at the end of the drive.
  - A replay summary over the logs: how often the stored calibration was confirmed or rejected, and how far off
    it was at the starts. Re-seat the phone on purpose once to see the check work.
  - Switch to `on` only if those numbers hold up; otherwise drop the compass.
- **Not yet:** a heading prior for alignment (§6), re-fitting the offset from gyro turns after the phone is
  re-seated.

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

### 9.1 Field results (2026-10-04, 7 drives, `nav_estimate`)

- **Clean GNSS:** the map was a median 0.9–2.3 m from the moving satellite fixes (p95 2.8–6.3 m). Its radius
  (median 1.6–2.2 m) is slightly small for a 68 % circle. The navigator ran 305 ms behind (p99 313 ms).
- **Jammed throughout** (3afby6: 9 min, 2.7 km, no satellite fix): the navigator kept running from the previous
  drive, so it dead-reckoned from the first second. It ended 26 m from the next drive's first satellite fixes (the
  car stood there), with a radius of ±64 m. 32 of 35 coarse fixes fell inside their own radius.
  - Replay can't carry a navigator over between drives. `--chain` (starting from the parked pose) gives 48 m. With
    the changes of §4 and §5.1 it gives 57 m (±81 m), and the worst radius is 93 m instead of 370 m.
- **Walking off with the phone** (2 drives): the link drops when the phone leaves Bluetooth range; GNSS shows
  2–7 km/h while OBD reads 0. One drive reset to `anchored` (5 fixes failed the gate). Handled by the frozen pose
  (§6.1); `replay:bench` skips such windows (§10).
- **GNSS lag** measured on the device: −0.05 to −0.2 s, saved per phone. **Speed scale:** saved only with a VIN.

## 10. Replay and benchmark (`src/nav/replay`, `tools/replay`)

- **Replay:** merges the three streams in time order and runs the navigator. It scores each fix before its update
  (pre-fix error) and can withhold GNSS: `--cut start:len`, or `--open-loop` from the heading fix to the end.
- **Held-out fixes:**
  - They are scored at a fixed lag (`truthLagS`, default 0), so variants of the navigator's own lag share one
    yardstick.
  - Only satellite fixes ≤ 10 m count as truth.
- **`npm run replay:bench`:**
  - Outages of 60/120/240 s on a 30 s grid of log time, from 10 s after the EKF starts. A window counts when the
    held-out satellite fixes cover ≥ 80 % of it and the car drives ≥ 200 m.
  - A window is skipped when ≥ 5 satellite fixes in it move while OBD reads 0 or is silent: the phone left the car
    with the driver (q8tfjs, 9qw8wn, qfger8). A reverse makes 3–5 such fixes, so far never inside a window.
  - The grid is fixed so that a change that moves the EKF start by a few seconds still scores the same windows.
    With the grid relative to the start, an 8 s shift moved the 120 s median by 5 m.
  - Reports max and end error (median, p90), error per km, and max error ÷ predicted σ.
  - Windows overlap, so small differences are noise.
- **First 7 drives** (2026-10-03, 56 windows; window grid relative to the EKF start):

| Outage | Median distance | Max error median / p90 | Max error ÷ σ |
| ------ | --------------- | ---------------------- | ------------- |
| 60 s   | 0.65 km         | 11 / 21 m              | 1.5           |
| 120 s  | 1.3 km          | 20 / 31 m              | 0.9           |
| 240 s  | 2.1 km          | 37 / 88 m              | 0.6           |

- **14 drives** (2026-10-04, fixed grid, the same windows before and after the changes of §4 and §5.1; map
  matching on, so the EKF can start from the map):

| Outage | Windows | Max error median / p90, before | After | End error median / p90, after | Max error ÷ σ, after |
| ------ | ------- | ------------------------------ | ----- | ----------------------------- | -------------------- |
| 60 s   | 59      | 12.4 / 35.8 m                  | 11.7 / 34.5 m  | 8.8 / 27.0 m         | 2.3                  |
| 120 s  | 50      | 24.6 / 74.3 m                  | 24.7 / 64.7 m  | 20.6 / 56.0 m        | 2.3                  |
| 240 s  | 36      | 67.3 / 128.7 m                 | 59.3 / 123.7 m | 36.0 / 107.6 m       | 2.3                  |

  - The new drives are harder. j5m8tq (7 km at up to 70 km/h) loses 50–90 m in 1–2 min, nearly all cross-track:
    its heading is 2–3° off at the outage start while σ_ψ claims 0.6–1°. In one outage the error grows from 2° to
    9° through gentle curves and a sharp turn, while the distance stays within 1 %. Cause not found (§13.8).
  - On the 7 older drives the changes are neutral: 60 and 120 s identical, 240 s median 27.6 → 31.8 m and p90
    80 → 73 m. Max error ÷ σ at 240 s went from 0.5 to 0.9, because false handling no longer inflates σ.
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
   **Met** on 2026-10-04 (§9.1): 26 m off after 2.7 km jammed, radius ±64 m.
   - **Truth:** the first satellite fixes after the outage, compared with `nav_estimate` at the same time. That's
     where the DR error is largest. It needs nothing done in the car; a second phone in the same car is jammed too.
   - Error during an outage is measured by `replay:bench` on clean drives (§10).

## 13. Open items

1. **Heading at outage start** (about 2° RMS) limits DR. Candidates: map matching (SPEC §3.7), longer GNSS baselines.
2. ~~OBD speed truncation at low speed~~: ruled out on 8 clean drives. GNSS − OBD grows with speed (0.04 km/h at
   14 km/h, 0.9 km/h at 55 km/h): a scale of 1.019 with a −0.23 km/h offset. The scale varies by drive,
   1.005–1.022 even back to back; `k_s` learns it per drive.
3. Longer outages (5 / 15 min, SPEC §7) need longer clean drives than the current logs.
4. Second phone and mount, to check the tuning values (§11).
5. Integrity (SPEC Phase 3) replaces the interim trust tracker and the EKF gate as the GNSS acceptance rule.
6. Spoofing replay: offsetting fixes in clean logs (SPEC §3.10) isn't implemented yet.
7. Replay doesn't load the stored calibration or parked pose a live session started from. `nav_estimate` and the
   `nav …` notes record them; use `--lag` and `--chain` to come close. Nor can it carry the navigator over from
   the previous drive, as the app did on the jammed drive of §9.1.
8. **Overconfident heading at speed** (j5m8tq, §10): 2–3° off at the outage start against σ_ψ 0.6–1°, and
   growing through curves at ~70 km/h. Candidates: the phone slipping in the mount at speed, gyro scale in sharp
   turns, GNSS course lag at speed. Max error ÷ σ is 2.3 over 14 drives (target 0.5–2, §12.1).
9. **Alignment is overconfident** on the new drives (simulated jams, MAPMATCH-SPEC §8.1): 9 of 28 alignment
   starts are over 10° off, the worst 43° at 4.9σ.
10. **Reversing reads OBD 0** on the CX-5 (VEHICLE-LINK-SPEC §10.4), so the car turns in place in the model. It
    could be detected from OBD 0 + the gyro turning + the phone steady in the mount; its speed is still unknown.
11. **Compass shadow mode** (§7.6): wire the compass into the app without navigating with it, and collect how often
    the stored calibration is wrong on real drives before switching it on.
