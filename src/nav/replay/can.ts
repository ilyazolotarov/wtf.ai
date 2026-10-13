// A trip log's CAN shadow frames decoded through the car's profile (SPEC §2.1: decoded in replay).
import { CarStateDecoder, type CarStateSample } from "../odometry/can/car-state";
import { CAN_SPEED_PERIOD_US, canSpeedReading, canSpeedSamples, type CanSpeedSample } from "../odometry/can/can-speed";
import { wheelYawSamples } from "../odometry/can/wheel-yaw";
import { WheelYawCalibrator, type WheelYawCalibration, type WheelYawCalibrationConfig } from "../odometry/can/wheel-yaw-calibration";
import { ImuProcessor } from "../odometry/imu/imu-processor";
import { matchProfiles, profileByKey, seenIds, type Profile, type ProfileMatch, type SeenId } from "../odometry/can/profile";
import type { TripLog } from "../../triplog/trip-log-reader";

export interface TripCan {
  /** Profiles that fit the frames, best first (only the VIN's make when the log has a VIN). */
  matches: ProfileMatch[];
  profile: Profile | null;
  samples: CarStateSample[];
  /** Ids the shadow listened for (from the log's `can_shadow`), or null when it isn't known. */
  listened: Set<number> | null;
  seen: Map<number, SeenId>;
}

export function listenedIds(trip: TripLog): Set<number> | null {
  const text = String(trip.info.can_shadow ?? "");
  const ids = text.split(/[\s,;]+/).filter((p) => /^(0x)?[0-9a-f]{1,8}$/i.test(p));
  return ids.length ? new Set(ids.map((p) => parseInt(p.replace(/^0x/i, ""), 16))) : null;
}


/**
 * The frames at when the bus carried them, as near as the log tells: one that arrived after its window ended (the
 * stop's drain, sent before the stop character reached the adapter) at the window's end. On the vLinker a stop
 * without an answer was retried after 1 s, and the frames it drained, arriving then, put a turn's start a second late
 * (2026-10-12).
 */
export function busTimedFrames(trip: TripLog): NonNullable<TripLog["can"]> {
  const frames = trip.can ?? [];
  const windows = trip.canWindows;
  if (!windows?.length) return frames;
  let w = 0;
  return frames.map((f) => {
    while (w + 1 < windows.length && windows[w + 1].startUs <= f.tUs) w++;
    const win = windows[w];
    return win.startUs <= f.tUs && f.tUs > win.endUs ? { ...f, tUs: win.endUs } : f;
  });
}

/** Null when the log has no CAN frames. `profileKey` overrides the choice ("make/mapping/dbc"). */
export function decodeTripCan(trip: TripLog, profileKey?: string): TripCan | null {
  if (!trip.can?.length) return null;
  const frames = busTimedFrames(trip);
  const seen = seenIds(frames);
  const listened = listenedIds(trip);
  const vin = typeof trip.info.vehicle_vin === "string" ? trip.info.vehicle_vin : null;
  const matches = matchProfiles(seen, vin, listened ?? undefined);
  const profile = profileKey ? profileByKey(profileKey) : (matches[0]?.profile ?? null);
  const samples: CarStateSample[] = [];
  if (profile) {
    const decoder = new CarStateDecoder(profile);
    for (const f of frames) for (const s of decoder.push(f.tUs, f.id, f.data)) samples.push(s);
  }
  return { matches, profile, samples, listened, seen };
}

function canSample(s: CanSpeedSample): TripLog["obdSpeed"][number] {
  return { tUs: s.tUs, rxUs: s.tUs, ...canSpeedReading(s), source: "can" };
}

/** OBD speed fills in when the last CAN speed is older than this (the monitor's breaks for polls are ~0.16 s). */
const CAN_FRESH_US = 300_000;

/**
 * The trip as the navigator would drive it on CAN wheel speeds (SPEC §2.1 Stage 2, replay only): ~10 Hz samples of
 * the mean wheel speed, `source: "can"`, where the monitor heard them, and the log's OBD speed where it didn't. In
 * reverse gear the speed is negative (`rawKph` stays the unsigned reading): the navigator and the map matching move
 * the car backwards. Null when the log has no wheel speeds.
 */
export function withCanSpeed(trip: TripLog, profileKey?: string): TripLog | null {
  // Already on CAN speed (`canPrimaryInput`, or twice asked): as it is.
  if (trip.obdSpeed.some((s) => s.source === "can")) return trip;
  const can = decodeTripCan(trip, profileKey);
  const speeds = can ? canSpeedSamples(can.samples) : [];
  if (!speeds.length) return null;
  const merged: TripLog["obdSpeed"] = [];
  let ci = 0;
  let lastCanUs = -Infinity;
  for (const o of trip.obdSpeed) {
    while (ci < speeds.length && speeds[ci].tUs <= o.tUs) {
      const s = speeds[ci++];
      merged.push(canSample(s));
      lastCanUs = s.tUs;
    }
    if (o.tUs - lastCanUs > CAN_FRESH_US) merged.push(o);
  }
  for (; ci < speeds.length; ci++) merged.push(canSample(speeds[ci]));
  return { ...trip, obdSpeed: merged };
}

/** A wheel yaw sample stands for the IMU samples within this of it (the monitor's breaks for polls are ~0.16 s). */
const YAW_FRESH_US = 300_000;
/** Wheel yaw comes this much after the gyro's (2026-10-12, both adapters: 0–120 ms). */
const WHEEL_LAG_US = 100_000;

export interface WheelYawOptions {
  /** A fixed track instead of learning (no `calibrate`). */
  trackM?: number;
  profileKey?: string;
  /** The phone leaves the mount here (s since log start): the gyro before it, the wheels after. Default: from the start. */
  fromS?: number;
  /** Learn the wheels' calibration from the gyro while it is used (WheelYawCalibrator), and turn on it after. */
  calibrate?: boolean;
  calibration?: Partial<WheelYawCalibrationConfig>;
  /**
   * Between listening windows (the polls' breaks): `interpolate` the wheel yaw across (default), or keep the phone's
   * gyro there — what listening without breaks would give, on a drive whose gyro was good.
   */
  gaps?: "interpolate" | "gyro";
}

/**
 * The trip as the navigator would turn on the rear wheels' yaw (SPEC §2.1 Stage 2, replay only): from `fromS` each
 * IMU sample's rotation replaced by the wheel yaw about the phone's "up" (its gravity kept), as if the gyro read
 * exactly the car's turning — what a phone held in a hand or in a pocket would need. Where no wheel sample is near,
 * the phone's own gyro stays; `gyroShare` says how much of that stretch it was. Null when the log has no wheel speeds.
 */
export function withWheelYaw(
  trip: TripLog,
  options: WheelYawOptions = {},
): { trip: TripLog; gyroShare: number; calibration: WheelYawCalibration | null } | null {
  const can = decodeTripCan(trip, options.profileKey);
  const speeds = can ? canSpeedSamples(can.samples) : [];
  if (!speeds.length) return null;
  const fromUs = trip.startUs + (options.fromS ?? 0) * 1e6;
  // The gyro's yaw rate per IMU sample, as the navigator reads it.
  const imuYaw = (() => {
    const p = new ImuProcessor();
    return trip.imu.map((s) => {
      const o = p.process(s);
      return { tUs: s.tUs, yaw: o.valid ? o.yawRate : null };
    });
  })();
  let gi = 0;
  const gyroAround = (tUs: number): number | null => {
    const a = tUs - WHEEL_LAG_US - 50_000;
    const b = tUs - WHEEL_LAG_US + 50_000;
    while (gi < imuYaw.length && imuYaw[gi].tUs < a) gi++;
    let sum = 0;
    let n = 0;
    for (let j = gi; j < imuYaw.length && imuYaw[j].tUs <= b; j++) {
      const y = imuYaw[j].yaw;
      if (y === null) return null;
      sum += y;
      n++;
    }
    return n ? sum / n : null;
  };
  const calibrator = options.calibrate ? new WheelYawCalibrator(null, options.calibration) : null;
  const fixed = wheelYawSamples(speeds, options.trackM);
  const yaw = speeds.map((s, i) => {
    const [, , rl, rr] = s.wheelsMps;
    if (calibrator && s.tUs < fromUs) calibrator.push(s.tUs, rl, rr, gyroAround(s.tUs), s.reverse);
    if (!calibrator) return fixed[i];
    const w = calibrator.yaw(rr - rl, s.speedMps);
    return { tUs: s.tUs, radps: s.reverse ? -w : w };
  });
  let k = 0;
  let kept = 0;
  let after = 0;
  const imu = trip.imu.map((s) => {
    if (s.tUs < fromUs) return s;
    after++;
    while (k + 1 < yaw.length && yaw[k + 1].tUs <= s.tUs) k++;
    const a = yaw[k];
    const b = yaw[k + 1];
    let radps: number | null = null;
    if (options.gaps === "gyro" && !(a.tUs <= s.tUs && b && b.tUs - a.tUs <= 2 * CAN_SPEED_PERIOD_US)) {
      kept++;
      return s;
    }
    if (a.tUs <= s.tUs && b && b.tUs - a.tUs <= 2 * YAW_FRESH_US) {
      radps = a.radps + ((b.radps - a.radps) * (s.tUs - a.tUs)) / (b.tUs - a.tUs);
    } else {
      const near = [a, b].filter((y) => y && Math.abs(y.tUs - s.tUs) <= YAW_FRESH_US);
      if (near.length) radps = near[0].radps;
    }
    if (radps === null) {
      kept++;
      return s;
    }
    const g = Math.hypot(...s.gravity);
    const up: [number, number, number] = g > 0 ? [-s.gravity[0] / g, -s.gravity[1] / g, -s.gravity[2] / g] : [0, 0, 1];
    return { ...s, gyro: [up[0] * radps, up[1] * radps, up[2] * radps] as [number, number, number] };
  });
  return { trip: { ...trip, imu }, gyroShare: after ? kept / after : 0, calibration: calibrator?.calibration ?? null };
}

/**
 * The input the app's navigator had: a log recorded with CAN primary (`can_primary: on`, VEHICLE-LINK-SPEC §16.3) has
 * OBD speed only while standing, the navigator drove on the wheels. Turned on mid-drive, the log has the feed's note
 * instead (`can primary: speed from the wheels`); before it no CAN was heard, so the whole log is as the phone had it.
 */
export function canPrimaryInput(trip: TripLog): TripLog {
  const cached = primaryInputs.get(trip);
  if (cached) return cached;
  const primary = trip.info.can_primary === "on" || trip.messages.some((m) => m.text.startsWith("can primary: speed from the wheels"));
  const input = primary ? (withCanSpeed(trip) ?? trip) : trip;
  primaryInputs.set(trip, input);
  return input;
}

/** Decoding a log's frames takes a second: once per log (the truth's odometer and the replay both ask). */
const primaryInputs = new WeakMap<TripLog, TripLog>();
