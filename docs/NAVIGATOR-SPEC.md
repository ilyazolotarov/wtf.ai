# wtf.ai — Navigator Specification

The sensor fusion in `src/nav`: the EKF, heading initialization, online calibration, GNSS integrity, and how the app
and the replay drive it. Inputs come from [TRIP-LOGGER-SPEC.md](TRIP-LOGGER-SPEC.md) streams; the adapter is
[VEHICLE-LINK-SPEC.md](VEHICLE-LINK-SPEC.md); map matching is [MAPMATCH-SPEC.md](MAPMATCH-SPEC.md). Source of truth
for coding agents.

## 1. Goal

Turn the car's speed, the phone gyro and the phone's location fixes into one position with an honest uncertainty,
including while GNSS is jammed:

1. Keep the position moving by dead reckoning (DR) when GNSS is lost, with a radius that grows the way the error does.
2. Start without a GNSS course, which jamming takes away, using whatever coarse fixes the phone still gives.
3. Calibrate itself online (gyro bias, speed scale, GNSS timing), so tuning doesn't depend on one phone or car.
4. Be developed and measured on Windows by replaying real trip logs: the replay runs what the app runs.

## 2. Status

Built, wired into the app and field-tested on two cars and testers' phones; the replay reproduces the phone's dot
(§10). Open items: §13.

## 3. Inputs (`src/nav/types.ts`)

| Input | Source | Rate | Notes |
| --- | --- | --- | --- |
| `ImuSample` | CoreMotion device motion (`xArbitraryZVertical`) / Android SensorManager normalized to it | 100 Hz | gyro, gravity, user acceleration; device frame |
| `ObdSpeedSample` | PID `0D`, time = midpoint of tx and rx; or CAN wheel speeds (`source: "can"`) | OBD 2 Hz moving, 1 Hz parked; CAN ~10 Hz | raw km/h kept (1 km/h resolution, 0 below ~2–3 km/h) |
| `GnssFix` | `modules/sensor-capture` | ~1 Hz; jammed ~0.1 Hz | invalid fields absent; simulated fixes dropped by the reader |
| `MagSample` | raw magnetometer | 20 Hz | compass in shadow mode only (§7.6) |

- **Satellite fix vs coarse fix:** a satellite fix has a speed (0 when standing). Under jamming the phone falls back
  to Wi-Fi/cell positions with no speed, claiming ±7 m … 150 km, often repeated, with correlated errors. Accuracy
  alone can't tell the two kinds apart.
- All timestamps are monotonic uptime µs. Inputs are fed in time order (`Navigator.onImu / onObdSpeed / onGnss /
  onMag`).

## 4. Modes (`src/nav/navigator.ts`)

| Mode | Position | Uncertainty | Leaves when |
| --- | --- | --- | --- |
| `none` | — | — | first usable fix → `anchored`; parked pose (§6.1) or manual position (§6.3) → `dr` |
| `anchored` | best recent fix (heading unknown) | fix accuracy + distance driven since it | heading known (§6) → `dr` |
| `dr` | EKF | EKF covariance (reported as a 68 % radius) | 5 satellite fixes in a row fail the gate → `anchored` at the latest fix |

- **Fix filtering:** fixes worse than 2 km are ignored. A coarse fix that moved less than 2 % of its accuracy since
  the previous fix is a repeat and is skipped (the phone repeats Wi-Fi positions with sub-metre jitter; counted as new
  they turned the heading). Satellite repeats while parked are kept: they are real measurements.
- **Frame:** local ENU plane, re-anchored when the position is more than 5 km from its origin.

## 5. Odometry inputs

### 5.1 Gyro (`odometry/imu/imu-processor.ts`)

- Yaw rate = gyro · up (up = −gravity), independent of how the phone sits. Counter-clockwise is positive.
- **Handling detection:** the gyro is invalid while the phone moves in the mount or in a hand. Triggers:
  - the phone's vertical differs from its 3 s average by more than 8°. The vertical is carried by the gyro and
    pulled to gravity's over 30 s. Not gravity's own: Android's estimate leans with the car's sideways acceleration
    (16° in a turn) and read as handling it dropped up to half a drive's turning. Gravity's vertical jumping ≥ 10°
    between two samples without the gyro turning is a change of frame (§5.4), not handling;
  - the rotation off the vertical, averaged as a vector over 0.1 s, exceeds 1.0 rad/s (the vector mean: bumps shake
    the phone back and forth and stay under 0.7 rad/s; a magnitude mean triggered on bumps).

  Each trigger holds for 1.5 s. Mounted driving stays under 4° and 0.7 rad/s; real handling reaches ≥ 1.4 rad/s and
  ≥ 7.6°.
- While the gyro is invalid: if the car stands (speed 0) the heading is held; otherwise the EKF propagates without
  yaw input and with heading noise 0.3 rad/√s.
- **Quiet:** over 1 s, yaw-rate std < 0.01 rad/s, mean yaw < 0.005 rad/s, acceleration std < 0.2 m/s².
  Standstill = speed 0 + quiet for 2 s.

### 5.2 OBD speed

- Each sample updates `v = k_s · s_OBD` with σ 0.3 m/s; a raw 0 gets σ 0.8 m/s (the ECU cuts off below ~2–3 km/h).
- At standstill a zero-velocity update (σ 0.02 m/s) replaces the OBD update.
- OBD speed older than 2.5 s (link lost) is unknown: the relative track breaks, the anchored radius keeps growing at
  the last speed, the EKF speed random-walks. Last seen standing, the car stands still until a speed comes: the heading
  is held whatever the phone does (the driver walking off with it turns it in a hand without its reading as handled).
- **Manoeuvres:** speed is unsigned and what an ECU reports in reverse is up to the car (the main test car reads 0).
  A net gyro turn of ≥ 30° while OBD reads 0 and the phone isn't quiet is the car manoeuvring (out of a parking
  space) by a distance the odometry didn't see: when OBD reads > 0 again the EKF position σ grows by 6 m per radian
  turned and map matching starts again around it with the gyro's heading. Not handled: an ECU reporting reverse as
  positive speed (the dead reckoning moves forward instead of back).

### 5.3 CAN wheel speed (Stage 2; `odometry/can/`)

- A speed sample from CAN is the mean of the four wheel speeds (`can-speed.ts`), averaged per 0.1 s, rounded in
  0.01 km/h steps so a standing car reads exactly 0; σ 0.1 m/s (a zero 0.3 m/s). Where the monitor didn't hear the
  wheels (its breaks for polls), OBD fills in when the last CAN sample is over 0.3 s old.
- **Reverse gear** (CAN `GEAR` R) makes the speed negative: the EKF and the relative track move the car backwards
  and the odometry chunk is `reverse` (MAPMATCH-SPEC §6.1). The §5.2 manoeuvre handling then doesn't run.
- **Frames as decoded:** one wheel sample per frame once all its wheels are read; a sample no car makes is dropped
  (one wheel changed faster than 50 km/h/s, or the wheels more than 3 km/h + half their mean apart: a line that lost
  characters). Only the mean speed is rounded; the per-wheel values stay exact (their differences are the yaw rate).
- **Frames at bus time** (`frame-timing.ts`, the app and replay alike): each id is laid on its period (a least-squares
  line through its last 200 arrivals per listening window), one period after the last frame, never after its
  arrival nor over 0.3 s before it. A break in listening (a window's end, or 0.5 s without the id) starts the id
  again at its next arrival. The MFi link delivers in bursts, so arrival times squeezed a turn's yaw into the bursts.
- Replay: `withCanSpeed` (`nav/replay/can.ts`); `replay:bench --speed can`, `replay:regress --speed can`, the
  viewer's *Adapter: CAN wheel speeds*.

### 5.4 Wheel yaw (Stage 2; Settings → Car → *Turns from the wheels*, on by default)

The rear wheels aren't steered: (right − left) / track is the car's yaw rate whatever the phone does: the way to
navigate with the phone in a hand, a pocket or on a seat.

- **The source** (`wheel-yaw-source.ts`, one code for `NavigatorService.setWheelYaw` and replay's `withWheelYaw`):
  the CAN wheel samples give the yaw, track 1.60 m, opposite in reverse, placed 0.1 s earlier (the wheels lag the
  gyro by −40…+100 ms). Each IMU sample becomes the car's: the wheels' yaw about a vertical "up", the phone's
  acceleration kept, its tilt and turning left out, so its movements don't read as handling. In a break in listening
  the phone's own turning is used, still in the car's frame; with no wheel sample within 1 s, the phone's sample as it
  is.
- **Standing** (every wheel sample within 1 s reads 0; or the wheels went silent reading 0, at ignition off or the
  link lost, for 3 s after the last: until the navigator takes the speed for unknown and holds the heading itself,
  §5.2): no turning, never the phone's. In the car's frame the navigator can't see the phone handled, and at a stop
  the driver takes it out of the mount: its turning, taken for the car's, turned a parked car 21–120° and the next
  drive set off on another road.
- **No gyro at a crawl:** the wheels turn the car at any speed they read. Pulling out of parking spaces they matched
  the mounted gyro within 1–2°; the gyro there only brings in the phone handled.
- **The compass gets no field** meanwhile (§7.6): the IMU is then the car's, not the phone's.
- **The service** holds its inputs 0.5 s instead of 0.3 while CAN speed comes or wheel yaw is on: a wheel sample
  comes out of the feed 0.07–0.15 s after its time, one in ten over 0.3 s.
- **The tyres' difference** is learned (`wheel-yaw-calibration.ts`: over 5 s stretches, ∫ difference = track · ∫ gyro
  yaw + tyre · distance, stretches that differ from the gyro by over 3° + 10 % teaching nothing) and **applied**. A
  rear wheel reading slow by 0.1 % is 0.5 °/s of turning that isn't, at 46 km/h; one car's read 0.01–0.08 % apart from
  day to day. Kept per car (`CalibrationStore.wheelYaw`, once a drive learned it from 60 s; reloaded with its σ
  widened by 0.05 %): the next drive starts from it (`nav wheel yaw: tyres … from storage`). A phone off the mount
  for a whole drive teaches it 0.02–0.06 % too far; the next mounted drive takes it back.
- **The EKF's yaw noise** is `wheelYawNoise` (0.01 rad/s) instead of the gyro's 0.003 while the wheels turn the car
  (`Navigator.setWheelYaw`): with the tyre term applied they still drift ~2.5° per 20 s from the mounted gyro, and with
  the gyro's noise clean fixes pulled the heading back too slowly (the dot 3–9 m beside them for a minute).
- Replay: the log says `nav_wheel_yaw: on` and each switch is the note `nav wheel yaw on|off`; `replayTripInApp`
  follows them. Experiments: `--yaw wheels --yaw-from s`, `--yaw-cal`, `--yaw-gaps gyro`.

## 6. EKF (`ekf/dr-ekf.ts`), heading initialization, and where the car starts

- **State:** `E, N, ψ` (clockwise from north), `v`, `k_s`, `b_ω`, `k_ω`. Prediction at the IMU rate,
  `ψ̇ = −k_ω (ω − b_ω)`, `v` a random walk. Joseph-form updates.
- **GNSS updates** (satellite fixes only once integrity passes them, §8):
  - **Position:** σ = `h_acc / 1.5` for satellite fixes, `h_acc` for coarse ones, χ² gate 16.
  - **Speed** (satellite only): compared with the state 1.0 s earlier (Doppler smoothing).
  - **Course** (satellite only): at ≥ 4 m/s, σ = max(course accuracy, 2°).
  - **Timing:** position and course are compared with the state at fix time − GNSS lag (§7.3) from a 3 s history;
    the correction applies to the current state.
- **Coarse fixes are used** at their claimed accuracy: in real jammed drives 79–90 % landed inside their own radius
  around the DR prediction, they are the only absolute position available, and spoofing doesn't move them. They
  never count as trusted GNSS (§8).
- **Heading initialization**, whichever comes first:
  - **Course:** a satellite course at ≥ 5 m/s with course accuracy ≤ 10° (pulling away, the course can be tens of
    degrees off while claiming ±18°).
  - **Alignment** (`ekf/heading-align.ts`): the relative OBD + gyro track, in an unknown rotation, is fitted to the
    fixes (weighted 2D rotation + translation, outliers beyond 3σ dropped one at a time; fixes less than 25 m apart
    along the track count as one). Starts the EKF when the fitted heading σ ≤ 10° and the fixes span ≥ 150 m; on
    jammed drives that is after about 500 m. Position σ = fit noise + heading σ × the lever arm to the fixes.
  - **Map** (MAPMATCH-SPEC §8): the particle filter's settled road heading, usually sooner than alignment.
  - **Parked pose** (§6.1) or **manual position** (§6.3): before any fix.


### 6.1 Parked pose

- **Saved** (`Navigator.parkedPose`): position, heading and their σ while the car stands in mode `dr`, and `offRoad`
  when map matching had it off every road (a lot, a yard: the next start keeps it there, MAPMATCH-SPEC §7.2, and the
  map doesn't take `offroad` for lost there). The service stores it per VIN (`nav.parkedPoses`) at engine/ignition
  off, every 30 s while parked, and when it stops. The first speed > 0 clears it. Dead-reckoned there without a
  trusted satellite fix in the last 300 m, its σ is at least 30 m (the EKF claimed 5–7 m where the car was 12–80 m
  off, and the next drive's map matching missed the street). The pose is the EKF's, not the map's dot: saving the
  dominant map-matching hypothesis carried a wrong street into the next drive.
- **While driving** (`Navigator.drivePose`, `drive-pose.ts`): every 5 s while the car moves (fresh speed above 0) and
  the EKF runs, the same pose with the speed, in the same slot. Why: an app that dies mid-drive (iOS in the
  background, a crash, the driver swiping it away) otherwise starts again with no position: under jamming a
  Wi-Fi/cell fix kilometres wide, and a placing made from that circle was off by a street and a direction
  (2026-10-21). The pose where the car stops replaces it, without a speed; driving doesn't clear it.
- **Used while driving**, at most 2 min old (`DRIVE_POSE_MAX_AGE_S`; 2 min at 100 km/h is ±1 km, no better than the
  Wi-Fi fix): carried on along its heading at its speed for the time the app was off, σ widened by 30 % of the
  distance carried and the heading's by 1°/s (up to 45°), then started from as below. Older, only noted (`nav pose
  saved while driving N s ago: not used`). Note `nav mode dr (pose saved while driving, N s old, carried M m on at
  K km/h, ±S m, heading ±H°)`. Phone-only mode (§9.6) starts only from poses saved standing.
- **Frozen** at the first handling while parked: the driver often takes the phone out and walks off while the ECU
  is still awake, and the fixes then follow the driver. Handled only after the speed went stale (ignition off, the
  link lost), it is the pose where the car was last seen standing: with the wheels' turning the phone's own frame,
  where handling shows, comes back only then (§5.4), and the pose saved later had followed the phone.
- **Needs the VIN.** A missed VIN read assumes the last car on the protocol and retries (VEHICLE-LINK-SPEC §9.1). A
  VIN known late starts from the pose if the navigator has no position yet or the fixes agree (`startFromPose`
  accounts for the motion since the start). A car the link doesn't know (another protocol) restarts the navigator
  without the expected car's pose and calibration.
- **Used** (`Navigator.startFromPose`) when the app starts and the VIN matches (the car auto-connect will use, known
  before it connects). The EKF starts at once with σ widened by 5 m and 2°. Refused if the fixes so far disagree.
- **Checked:** until confirmed, a satellite fix that fails the EKF gate drops it, and so do 3 Wi-Fi/cell fixes in a
  row that fail it (`poseRejectCoarse`; one Wi-Fi fix isn't enough: a single ±55 m fix 850 m off threw away a correct
  pose): reset to `anchored` at that fix, the stored pose deleted. A Wi-Fi anchor doesn't refuse a pose at
  `startFromPose`; a satellite one does. Confirmed by an agreeing fix ≤ 100 m after 150 m of driving.
- **Asked:** the first Wi-Fi fix that disagrees (`pose: "doubted"`) makes the map ask "Is the car where the dot is?"
  (`PositionEstimate.poseQuestion`, with the distance). Yes confirms it (`Navigator.answerPose`); No drops it and
  anchors at that fix; unanswered, the 3-in-a-row rule applies. Notes `nav parked pose doubted …`, `… confirmed /
  rejected by the driver`.
- **Behind the car** when the app was started on the way (iOS relaunched it in the background for location within
  the last 10 min: the wake for location "Always", VEHICLE-LINK-SPEC §11, comes a few hundred metres into a drive): a
  pose older than a drive pose's 2 min isn't used (`parkedPose: "behind"`, note `nav parked pose not used: the app was
  started on the way`), the navigator starts as with no pose, and once a trip records the map says why until a
  trusted fix or a placing (`on-the-way.ts`; without a trip the driver walked or rode off with the phone, which
  relaunches the app too). Kept when the location iOS relaunched the app for, accuracy included, is within 150 m of
  it and no older than the pose or 2 min before the launch (`nav parked pose kept: … the phone is still at it`): the
  car still stands there. A pose saved within 2 min is the stop the app ended at and is used as above.
- **One per car** (by VIN): with one slot, a second car's pose replaced the main car's.
- **Not checked:** with no fix at all, nothing can tell that the car was moved while the app was off.

### 6.1a The track doubted

- **Why:** the pose checks stop at 150 m, and `accuracyM` is the filter's own spread, which stays a few metres
  however wrong the dot is. A dot can run kilometres away and stand there at ±5 m.
- **Raised** (`Navigator.positionDoubtM`): 3 Wi-Fi/cell fixes in a row (`coarseDoubtFixes`) land farther from the
  track than such fixes usually are from the car: one claiming up to 450 m, farther than its claim and 150 m; a
  wider one, past its reach (`coarseDoubtShare` 2 × the claim). A wide fix inside its reach neither counts nor
  clears.
- **Acted on:** when the three are narrow and agree (within half their mean distance), the track moves to them: the
  EKF's position becomes their mean ± half their reach, heading, speed and calibration kept, map matching starting
  over there (`DrEkf.relocate`, note `nav track lost: moved to the Wi-Fi/cell fixes …`). Not within 1 km of a trusted
  satellite fix (on the highway the Wi-Fi/cell fixes are the ones off), not while a parked pose is unconfirmed, not
  within 500 m of the driver confirming the pose or placing the car. Three, not more: on real jammed drives tracks
  are lost for real more often than three fixes agree on a wrong place; nor only while map matching tracks one road
  (a track lost on a wrong road is as sure of itself as a right one).
- Satellite fixes are not counted (integrity and the gate judge those); one the EKF takes clears the doubt, as does
  a coarse fix that agrees, or any restart of the track.
- **Published** as the dot's radius (`puckAccuracyM`, shared with the replay tools): the larger of the filter's
  spread and the doubt. Measured on every log kept (`replay:doubt`): fires on the one drive whose dot ran away, on no
  other.
- Notes `nav position doubted: …`, `… doubt cleared: …`.

### 6.2 Placed by the driver

- **Offered** only while the car stands (speed < 1 m/s): the chip "Set your position on the map" when there is no
  GPS and nothing vouches for the dot: rougher than 75 m, no direction, map matching `offroad` (not at the spot it
  parked in off the roads), or more than 5 km driven since the last trusted fix; and after "No" to "Is the car where
  the dot is?". Driving off cancels it. `accuracyM` alone was the rule once, and the chip was offerable in 3 of 20 792
  samples over two hours with the dot up to 10 km out.
- **Asked for** by the driver at any time the car stands, or before any position: **I'm here** on a dropped pin or
  on a place picked in the route screen (UI-SPEC §6, §7.1). The placing then starts at that point.
- **Placing** (UI-SPEC §6.2): the map zooms in with a centre pin; the driver drags the map until the pin is on the
  car, "Here", then taps where the front of the car points, "Confirm". A placing always has a heading: without one
  the car stayed anchored and a route started without a direction.
- **Applied** (`Navigator.setPosition`): everything about the old track is dropped except the speed scale. The EKF
  starts there (σ 10 m, 15°, init method `user`), confirmed: later fixes only pass its gate, so Wi-Fi can't move it;
  five rejected satellite fixes still reset it. Note `nav position set by the driver: lat,lon N m from the dot,
  heading …`.
- **Off the roads** when no road within 10 m runs within 30° of the car's heading (either way): a car park, a yard, a
  bay at right angles to the road it leaves by. Map matching then starts as from a pose parked off the roads
  (MAPMATCH-SPEC §7.2); started on the roads near it that fit the heading, a car placed facing a lane turned onto the
  road beside it and the dot drove on along the lane.
- **Held as the manual position** (§6.3), with or without a car connected, apart from the car's parked pose. With a
  car standing, the 30 s save keeps the navigator's pose (started from the placing) as the parked pose.

### 6.3 The manual position

- **Why:** placed with no car connected, the navigator took the placing but the map showed phone GNSS, often
  hundreds of metres off on Wi-Fi.
- **Held** (`NavigatorService`, `nav.manualPosition`: for the phone, not a car): lat, lon, heading, when placed, when
  last confirmed. It outlives the session.
- **Shown:** with no OBD speed for 10 s, the service publishes it instead of the fixes: `source: "manual"`, ±10 m,
  its heading, no speed, the latest fix still as `rawGnss`. Routing takes it as a reliable start with its heading.
  The snapshot carries `manual: { placedAt, confirmedAt, asking }`; the status pill says "Set on the map" and its
  details hold a chip "Position set manually · N min ago" with ✕ to forget it; a tap places the car again.
- **Asked:** 15 min after it was placed or last confirmed, "Are you still here?". Yes confirms it (15 min more); No
  forgets it. Until answered it is still shown.
- **Released** (a navigator started from it carries on): the car drives (OBD speed above 0; phone-only: 30 m
  measured); a trusted satellite fix within 3σ (σ = √(fix accuracy² + 10²)); 5 trusted satellite fixes in a row
  that disagree. Wi-Fi/cell fixes never release it.
- **Forgotten** (✕, or No): no longer held, and a navigator started from it starts over without it (with the parked
  pose saved since the placing deleted).
- **At a start** the newest word wins: the manual position, confirmed within 15 min, unless the car's parked pose was
  saved after it and more than 15 m from it (closer, the pose came from the placing, and the placing is the stronger
  start). Older than 15 min it isn't started from: the map asks first. A VIN known late doesn't replace a navigator
  already started from it.
- **In replays:** the app replay makes the log's placings again at their time (its `nav position set by the driver`
  notes); a position held from before the log comes with the log's `nav storage` notes (§10). The navigator-only
  `npm run replay` doesn't reproduce placings.

## 7. Calibration (online)

### 7.1 Gyro bias

Learned at standstill from the mean yaw over 1 s (σ 0.002 rad/s, gated), prior 0.0005 rad/s: CoreMotion's rate is
already bias-corrected (~0.007 °/s at standstill), and a loose prior let GNSS course errors leak into the bias.

### 7.2 Gyro scale `k_ω`

The gyro's true scale is ~1.007; the EKF learns 1.02–1.04 because at 1 Hz GNSS a timing mismatch looks like a scale
error. Fixing `k_ω = 1` didn't change the outage error, so it stays a state with a 0.02 prior. Not stored.

### 7.3 GNSS lag (`calibration/gnss-lag.ts`)

- CoreLocation's filtering differs per phone model and OS version, so the lag is measured, not hard-coded.
- 30 s windows (a new one every 10 s) with a ≥ 30° turn, ≥ 25 satellite fixes ≤ 10 m and speed ≥ 3 m/s; for each
  candidate lag (−0.5…1.5 s, step 0.05) the relative track is fitted to the fixes with a similarity transform; a
  wrong lag cuts corners, so the residual minimum marks the true lag.
- Used after 6 windows and only if the minimum isn't on the grid's edge; until then `gnssLagS` (default 0, or the
  stored value). `estimateGnssLag: false` fixes it. Measured −0.1 ± 0.1 s on the test iPhone.

### 7.4 Persistence (`src/services/navigation/calibration-store.ts`)

Learned values go to kv-store (`nav.calibration`) every 30 s and when the navigator stops; they only replace defaults
after enough data. The parked poses (`nav.parkedPoses`, by VIN) and the manual position (`nav.manualPosition`) are
kept apart.

- **GNSS lag**, per phone model (`sys_hw`) and OS version: saved once §7.3 has an estimate; a value from another
  model or version is dropped.
- **Speed scale `k_s`**, per VIN: saved once its σ ≤ 0.01 (clean GNSS gets there in 1–2 km; jammed drives don't
  save). It seeds the next EKF with σ widened by 0.01 (one car's drives learn 1.00–1.03). Within a session it
  survives an EKF reset. Under jamming `k_s` doesn't sink on real drives, and holding it or adding a speed offset
  state was worse: the scale-only model stays.
- **Compass calibrations** (§7.6), per VIN. **Phone mount** (phone-only mode, §9.6), per car or `phone`.
- **Not stored:** the gyro bias (drifts with temperature) and `k_ω`.

### 7.5 Magnetometer (logged, not used; SPEC §2)

The raw field is ~160 µT against Earth's ~50 µT (the phone's own and the car's offset); the heading-dependent part is
Earth's horizontal field, so the car hardly distorts it. Calibrated as offset + rotation + scale in a gravity-levelled
frame fixed to the phone, against GNSS course, it reads 4–18° off at the median on other drives and under 90° always;
re-seating the phone moves it 15–20°. Good enough to pick the travel direction along a road, not for navigation.

### 7.6 Compass (`compass/compass.ts`; in the app in shadow only)

- **Input:** `Navigator.onMag`, the IMU's gravity and yaw rate, `setCompassCalibrations` from earlier drives;
  `compassCalibrations` is what to keep. No field while the turning comes from the wheels (§5.4).
- **Model** (§7.5): the fit's normal equations, so drives add up. **One calibration per mounting** (the phone's
  tilt), at most 3 per car, most recent first; the active one is the one within 10° of the phone's tilt. A drive
  learns only into the mounting it sits in, or starts a new one.
- **Learning:** once a second while the EKF heading σ ≤ 3°, at ≥ 4 m/s, driving straight (< 3° over 1 s), the phone
  in its mount. A fit needs 60 samples over 5 of 8 heading sectors.
- **Trust:** a stored calibration starts `unverified`; the first 10 learning moments compare it with the EKF heading:
  median > 45° → `rejected` (dropped, the drive's own learning takes over), else `confirmed`. Kept for the next drive
  as `confirmed` only when learned or confirmed on this drive. Not covered: the phone turned in its mount at the same
  tilt.
- **Use** (`compassUse`): `shadow` (default, the app) computes, checks and learns, but the particle filter never gets
  the heading; `on` (replay `--compass`) weighs it at the filter's jammed start (MAPMATCH-SPEC §8.2). The app stays in
  shadow until real drives show how often a stored calibration is wrong (`npm run replay:compass` sums the notes:
  `nav compass from storage …`, `nav compass at start: X° off (trust)`, `nav compass A → B …`, `nav compass drive:
  …`).

## 8. Integrity and trust (`integrity/integrity.ts`, SPEC §3.3)

`Navigator.onGnss` asks `GnssIntegrity.check` about every satellite fix first. A refused fix comes back as
`status: "untrusted"` with the verdict (`outside`, `jump`, `shape`, `far`, `untrusted`, `reacquiring`) and the distance
to the nearest hypothesis, and nothing uses it. The map's trust is `Navigator.trustAt(t)`.

- **What the navigator gives it:** the OBD distance and the time without OBD speed, the relative OBD + gyro track at
  the fix time (its piece changes at every break), and the dead-reckoning hypotheses: the EKF at the lag-corrected
  fix time, the map-matching clusters ≥ 5 %, or the anchor (σ + distance driven). Hypotheses only while OBD speed
  came in the last 10 s, or for 30 s after a start from a parked pose; otherwise the phone may be anywhere.
- **Checks** (`DEFAULT_INTEGRITY_CONFIG`): border; the reach from the last trusted fix (OBD × 1.05 + 3σ + 20 m, 55
  m/s while OBD speed is unknown, 3 m/s walking pace); shape within one segment (static spoofs fail it once the car
  drives 50 m); after a gap > 10 s, max(8σ, 150 m) from every hypothesis.
- **Segments:** a jump or a gap > 10 s between satellite fixes starts a new one. Refused fixes that continue their
  segment come back only on a hypothesis with σ ≤ 30 m; a fix after a jump or gap back on the dead reckoning counts
  toward the 5 that re-trust. A shape failure in a trusted segment also untrusts that segment's earlier fixes.
- **Moved like the car:** a held or refused stream whose fixes kept the car's shape for 200 m (≥ 3 tests) is trusted
  again when the dead reckoning may be wrong (after a gap, or when the EKF didn't agree with the last trusted fix as
  the spoofing began); when it did agree, only after 2 km. The fix that earns the trust resets the EKF if it gates it
  out.
- **Divergence without a jump** (the phone walking off, wrong dead reckoning) passes: it continues a trusted stream.
  The EKF's rule (5 rejected satellite fixes reset it) acts on such fixes only, so a spoofed stream can't reset the
  navigator onto itself.
- **Shown trust:** a good fix is a satellite fix integrity passed, ≤ 50 m (Wi-Fi/cell never count). No good fix for
  8 s → `NO_FIX`; regained by passed fixes ≤ 30 m arriving steadily for 5 s. While integrity refuses: `UNTRUSTED`,
  `REACQUIRING` once fixes come back (or while held after a gap). Leaked satellite fixes under jamming pass to the
  EKF while the shown state stays `NO_FIX`.
- **Trip log:** `gnss trust <state> (±N m)` on changes; `gnss integrity <verdict>: <why> (fix ±N m, N m from the dead
  reckoning)` when the verdict changes.
- **Replay:** `--spoof` and `npm run replay:spoof` (§10).

## 9. Wiring into the app (`src/services/navigation/navigator-service.ts`)

- Owns one `Navigator`; GNSS and IMU from `SensorService` (owner `navigator`), speed from `VehicleLink.onSpeed` or
  the CAN speed feed. It is the runtime's `PositionSource` (UI-SPEC §4.3).
- **Runs** while the map is on screen or a trip records. When it stops, the next start begins with a fresh navigator.
- **Input order:** inputs are held 300 ms (`REORDER_US`; 500 ms with CAN) and fed in time order: IMU arrives in
  100 ms batches, fixes ~50 ms late. A fix more than 2 s behind is dropped; one more than 10 s old on delivery is
  CoreLocation's cache and is dropped with a note.
- **Display:** the DR position is extrapolated along the heading to "now" (≤ 1 s).
- A new VIN starts a new navigator. At start the VIN is `VehicleLinkCore.expectedVin()`: the connected car's, else
  the last car seen, so the parked pose applies before the adapter connects.
- **Mapping to `PositionEstimate`:** mode `dr` → `source: 'fused'` while trust is `TRUSTED` and a satellite fix was
  accepted in the last 3 s, else `'dr'`; `anchored` → `'gnss'` with the grown radius; `rawGnss` = the latest fix;
  `distanceSinceTrustedM` from OBD; `alternatives` the other map-matching hypotheses.
- **Without OBD speed** (no adapter, or none for 10 s): phone GNSS only, published once the navigator has taken a
  fix (so a spoofed fix never flashes on the map); while integrity refuses, the last passed fix with its circle
  growing at 15 m/s. **After the navigator's own dot** (engine off, link dropped) only a satellite fix replaces it: a
  Wi-Fi/cell fix is hundreds of metres wide under jamming. With phone-only mode on, §9.6.
- **Trip log:** `nav_estimate` every published position (TRIP-LOGGER-SPEC §6.3); mode changes, resets, the parked
  pose and loaded/saved calibration as `nav …` notes; at every navigator start, car change and trip start a `nav
  storage {json}` note with what is stored, so a replay can start as the phone did (§10).
- **Simulated GNSS outage** (Developer → "GPS outage button on the map"): a "Cut GPS" chip withholds every fix from
  the navigator while `SensorService` keeps logging them; the map shows the newest withheld satellite fix as a green
  marker and a card with time, distance and the dot's distance from it. Notes `sim gnss outage on|off …`; `npm run
  replay -- --app-cuts` cuts the same windows.

### 9.6 Phone-only mode (experimental; Developer → "Navigate without an adapter")

- **What:** without OBD speed and while GNSS isn't trusted, the map shows `PhoneNavigator` (`src/nav/phone/`): the
  phone's own speed (`imu-speed.ts`) on the turn-anchored map matching (`turn-tracker.ts`). `source: 'dr'`; the
  circle is the shown hypothesis' along-road σ combined with the others' spread (≤ 1 km); other roads are
  `alternatives`. The dot is drawn as the navigator's (`steadyDot`, `position/puck.ts`): it glides instead of
  hopping.
- **Not good enough to go unattended:** off the drawn route about 44 % of the moving time on the real jammed drives
  and on simulated jammed Kyiv trips; the error compounds along a drive. A placing every ~4 min when the dot is
  100 m off brings it to ~9 %.
- **Graph:** its own reader of the active region's graph in its own frame, so the navigator's tile cache is
  untouched.
- **Start**, newest word first: the driver's placing; the newest of the car's parked pose and phone-only's own (key
  `phone`); a trusted satellite fix with a course (≥ 3 m/s). Without one it waits and the map shows phone GNSS.
- **Fixes:** a trusted satellite fix (≤ 20 m) re-anchors it at most every 2 s; untrusted satellite fixes are
  ignored. Wi-Fi/cell fixes weigh its hypotheses; one claiming ≤ 200 m also moves each road hypothesis along its
  road towards it (a Kalman update of position and speed scale). Three fixes in a row claiming ≤ 100 m, each farther
  than max(80 m, 3σ) from the best hypothesis, add hypotheses on the roads around the latest one (± 45° of the best
  one's heading, at 0.3 of its weight); without this a tracker on another road stayed there for the rest of the drive.
- **The driver's placing** restarts it there (keeping the speed scale) and is the manual position (§6.3) until 30 m of
  driving.
- **Kept:** the phone mount (`PhoneMount`, per car or `phone`); its pose when the car has stood 20 s and when the
  service stops standing.
- **On a route** (`setPhoneRoute`, the driver said they will follow it, UI-SPEC §6.3): `RouteFollower`
  (`src/nav/mapmatch/route-follower.ts`) places the car along the route by the turns it makes (a grid over distance
  and speed scale, weighed by the gyro's heading change over the last 80 m against the route's); the dot is there,
  no alternatives. The tracker keeps running and is moved to the follower's position at each stop and after each
  turn that fits (0.6). Joined when the start, a placing or a trusted fix is within 30 m (+σ) of the route heading
  along it, or a new plan within 100 m of the dot; a new plan within 300 m of the followed route carries the car on
  (the old route up to there, then the new). A turn that fits nowhere near the follower's car puts it at the route's
  nearest turn like it (up to 300 m back or max(1 km, 2 × the distance since the last fitting turn) ahead). Coarse
  fixes up to ±5 km weigh it, and one that puts the car well outside where it was taken to be (likelihood < 0.05,
  > max(500 m, 2σ)) moves it to the nearest fitting stretch. A placing or fix farther has left the route (the
  tracker alone); the tracker within 30 m of it along it for 5 s rejoins. Turns alone can't tell a driver who left
  the route: that is the driver's placing, or GPS. On the jammed city drives following their routes: off the drawn
  route 3 % of the moving time against 27 % without a route; on highways the dot lags (the phone under-reads speed at
  125–135 km/h).
- **Notes:** `nav phone-only on|off`, `nav phone-only engine on <graph>[, phone mount from storage]`, `nav phone-only
  start (<from>)`, `nav phone-only route: follows it | off it | none`. The log's `nav_phone_only` info field is the
  setting at the trip's start.

### 9.7 Phone-only research (replay)

- **Speed** (`odometry/imu/imu-speed.ts`, `replay:imuspeed`): the car's axes in the phone frame are learned from
  turns and pulling away, kept per car while the phone sits the same way. Curves measure the speed (sideways
  acceleration = v·ω, σ 1 m/s²); stops (phone quiet, vertical vibration < 0.25 m/s², no horizontal acceleration over
  0.25 s) pin it at zero; in between the forward acceleration is integrated against a gyro-tracked vertical that
  levels in 60 s (1 s at stops). Before the axes are known the speed is unknown, not 0. Its limit is the vertical:
  1–2° off gives 0.2–0.5 m/s² of false acceleration, so stretches read 0.89× OBD at the median, 0.55× at p10; the
  levelling acts as a 60 s high-pass (~7 % short between turns).
- **Map matching** (`mapmatch/turn-tracker.ts`, `replay:turns`): road hypotheses, each a position along a road with
  its own uncertainty and speed scale; a turn the gyro sees snaps each to the junctions around where it expected a
  turn whose exit turns that way (which teaches the scale); a free hypothesis dead-reckons off the roads and
  rejoins. Large errors are behind (the phone under-reads distance) or on another road, seldom far ahead; once on a
  wrong road it seldom gets back.
- **Tried without gain:** vibration and tyre frequency as speed cues; roads' usual speeds from other drives; a
  per-stretch drift state; heavy-tailed junction distances; more hypotheses; absolute heading kept from the start;
  coarse fixes weighted less; choosing per second between the tracker and the particle filter; re-injecting
  hypotheses around the best; a road-bend correction along the road; other levelling times, levelling to the stops'
  vertical, a larger bias random walk, one speed measurement per whole curve; a stop as a cue to the junction ahead.
- `replay:turns` feeds every fix as a coarse one, so its results on drives with GPS are not the app's.

### 9.8 The measured phone and driver in simulation (`src/nav/sim/phone-imu.ts`, `city-drive.ts`)

Simulated drives (MAPMATCH-SPEC §9.4) judge phone-only mode only with a phone and a driver like the real ones
(`MEASURED_PHONE_IMU`, `MEASURED_DRIVER`, `MEASURED_JAM_ARRIVALS`, from the real drives): a holder tilting the screen
~20° back (σ 7°), turned ±25°, ~0.7 m ahead of the point the car turns about; body pitch and roll with acceleration;
road slope ±1.2 % and camber ±1.1°; vibration by speed with the holder's pitch shaking the gyro 5–18 °/s at 8–16 Hz;
gyro bias ~0.01 °/s drifting 0.015 °/s over 5 min; gravity as a 20 s complementary filter that leans in curves;
a driver accelerating 0.4–0.7 m/s² at the median, wobbling 10–12 % while cruising, crawling and queueing; under
jamming Wi-Fi fixes ~2 a minute in bursts and cell fixes ~4 a minute claiming ~1.4 km. Not reproduced: handling, yards
and car parks, the speed's long-stretch drift sign. `sim:drives --simple` is the older simulator (a flat phone reading
the yaw rate, class speeds, stops at junctions), which makes the phone's speed trivially good.

## 10. Replay and benchmark (`src/nav/replay`, `tools/replay`)

- **Two replays:** `replayTrip` runs the navigator alone (the benchmarks measure the navigator); `replayTripInApp`
  (`src/services/navigation/app-replay.ts`) runs the app's own `NavigatorService`, fed as on the phone (IMU in 100 ms
  batches, OBD at its reply, fixes after their delivery delay) on a virtual clock: its dot is what the service
  publishes, and the parked pose, stored calibration, placings and simulated outages are the app's code. The viewer
  and `replay:regress` use it, so a fix in the app needs no copy in the replay. The dot's rule is
  `src/nav/position/puck.ts`.
- **Forks:** `TripReplay` feeds a drive in steps and forks an independent copy of the navigator (`Navigator.fork`, a
  deep copy sharing only the road graph), which can then take an outage of its own; a fork's result must equal a
  replay with the same cuts from the start (`fork.test.ts`), so navigator state keeps no closures (`deep-copy.ts`
  refuses them).
- **Starting as the phone did:** a replay seeds its storage from the log's `nav storage` notes (`seedFromLog`), and
  `npm run replay:parity` compares its dot with the phone's `nav_estimate`: with the navigation code unchanged since
  the log's build they must agree (p90 ≤ 3 m), else the replay doesn't reproduce the app.
- **Held-out fixes** are scored at a fixed lag (`truthLagS`, default 0); only satellite fixes ≤ 10 m count as truth.
- **`npm run replay:bench`:** outages of 60/120/240 s on a fixed 30 s grid from 10 s after the EKF starts; a window
  counts when the held-out satellite fixes cover ≥ 80 % of it and the car drives ≥ 200 m; windows where the phone
  left the car (≥ 5 satellite fixes moving while OBD reads 0) are skipped. Reports max and end error (median, p90),
  error per km, max error ÷ predicted σ (0.5–2 is honest), and the share of held-out fixes inside the drawn circle
  (honest ≈ 68 %; the fairer check once map matching bounds the error). Windows overlap, so small differences are
  noise.
- **`npm run replay:spoof`** (§8): on each clean drive, 60 s windows every 120 s, replayed once per spoof kind
  (`src/nav/replay/spoof.ts`: static 5 km and 300 m, abroad, following the car 1 km and 150 m off, static after 60 s
  of jamming) and once cut (the control). Per kind: first spoofed fix refused, spoofed fixes used, time until trust
  is back, the dot's error when GPS returns, real fixes refused. `--any-start` also spoofs before the heading is
  known.
- **`npm run replay:regress`** (the check for every change, MAPMATCH-SPEC §10.2) and the **viewer**
  (`npm run replay:view`): `tools/replay/README.md`.

## 11. Tuning values and what they depend on

| Value | Default | Depends on | Handling |
| --- | --- | --- | --- |
| GNSS position/course lag | 0 s | phone model, OS | measured online (§7.3), stored per model |
| GNSS speed lag | 1.0 s | phone model, OS | fixed; results barely change between 0.4 and 1.6 s |
| Gyro noise | 0.003 rad/s | mount, car | from `replay:bench`; ≤ 0.001 makes the filter overconfident |
| Handling thresholds | 8°, 1.0 rad/s, 1.5 s | mount, road | from logged mounted drives |
| Gyro bias prior | 0.0005 rad/s | CoreMotion | learned at every stop |
| Speed scale `k_s` | 1 ± 0.03 | car, tyres | learned online; persisted per VIN (§7.4) |
| OBD σ / zero σ | 0.3 / 0.8 m/s | ECU | CAN: 0.1 / 0.3 m/s |

All tuning comes from one iPhone, one mount and one car; testers' logs (Android phones) check it with
`replay:regress --testers`.

## 12. Verification targets

1. `replay:regress` after any navigator change: no drive worse on parked and drawn starts (several seeds); cold
   must not fall apart.
2. `replay:bench`: max error ÷ σ between 0.5 and 2; the truth inside the drawn circle ≈ 68 %.
3. Jammed drives: the EKF starts from the map or alignment once distinct coarse fixes span ≥ 150 m; ≥ 75 % of later
   coarse fixes fall inside their own radius.
4. Standstill: heading change < 0.5° over a 60 s stop, including handling the phone while parked.
5. `replay:spoof`: the first spoofed fix of every kind refused, no spoofed fix used, trust back within 10 s of the
   spoof's end, no real fix refused on clean drives.
6. `replay:parity`: the app replay reproduces the phone's dot (p90 ≤ 3 m) for logs built from the current code.
7. Unit tests (`src/nav/__tests__`), lint and typecheck pass.

## 13. Open items

1. **Overconfident after a course-only start** on some drives (max error ÷ σ 2.5–6 per drive): course updates at
   ≥ 4 m/s count as independent while their errors last from fix to fix. Candidate: rate-limit or inflate them at
   speed.
2. Longer outages (5–15 min) need longer clean drives than the logs have; Cut GPS on a long drive keeps the real
   fixes as truth.
3. Compass in shadow (§7.6): collect how often a stored calibration is wrong before switching it on, or drop it.
4. Wheel yaw (§5.4): the tyres' term needs learning that a phone in a pocket can't spoil before it leaves
   experimental.
5. Reverse on cars that report reverse speed as positive, and on OBD-only cars that read 0 (the car turns in place
   in the model).
