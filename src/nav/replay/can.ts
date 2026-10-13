// A trip log's CAN shadow frames decoded through the car's profile (SPEC §2.1: decoded in replay).
import { CarStateDecoder, type CarStateSample } from "../odometry/can/car-state";
import { CAN_SPEED_PERIOD_US, canSpeedReading, canSpeedSamples, type CanSpeedSample } from "../odometry/can/can-speed";
import { retimeFrames } from "../odometry/can/frame-timing";
import type { WheelYawCalibration, WheelYawCalibrationConfig } from "../odometry/can/wheel-yaw-calibration";
import { WheelYawSource } from "../odometry/can/wheel-yaw-source";
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
  // At the bus's times: drained frames at their window's end, each id on its period, a break at each window's end
  // (frame-timing.ts), as the app.
  const frames = retimeFrames(busTimedFrames(trip), trip.canWindows ?? []);
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

/** The app's navigator runs this far behind with turning from the wheels: a wheel sample is in before it is asked for. */
export const WHEEL_YAW_DELAY_US = 500_000;

export interface WheelYawOptions {
  profileKey?: string;
  /** The phone leaves the mount here (s since log start): the gyro before it, the wheels after. Default: from the start. */
  fromS?: number;
  /**
   * Learn the wheels' calibration from the gyro (WheelYawCalibrator) and turn on it: until `fromS` (the phone leaves
   * the mount), or with `fromS` 0 all along, wherever the two agree — the app with the phone mounted. Without it the
   * defaults (track 1.60 m, no tyre term).
   */
  calibrate?: boolean;
  calibration?: Partial<WheelYawCalibrationConfig>;
  /**
   * Between listening windows (the polls' breaks): `interpolate` the wheel yaw across (default), or keep the phone's
   * gyro there — what listening without breaks would give, on a drive whose gyro was good.
   */
  gaps?: "interpolate" | "gyro";
}

/**
 * The trip as the navigator would turn on the rear wheels' yaw (NAVIGATOR-SPEC §5.4) — the app's `WheelYawSource`, fed
 * as the app feeds it: each wheel sample in at its time, learnt from in time order, each IMU sample taken
 * `WHEEL_YAW_DELAY_US` later as the car's (`substitute`). Where no wheel sample is near, the phone's own IMU sample
 * stays; `gyroShare` says how much of that stretch it was. Null when the log has no wheel speeds.
 */
export function withWheelYaw(
  trip: TripLog,
  options: WheelYawOptions = {},
): { trip: TripLog; gyroShare: number; calibration: WheelYawCalibration | null } | null {
  const can = decodeTripCan(trip, options.profileKey);
  const speeds = can ? canSpeedSamples(can.samples) : [];
  if (!speeds.length) return null;
  const fromUs = trip.startUs + (options.fromS ?? 0) * 1e6;
  const learnAll = !options.fromS;
  const src = new WheelYawSource(null, options.calibration);
  const proc = new ImuProcessor();
  const bridgeUs = options.gaps === "gyro" ? 2 * CAN_SPEED_PERIOD_US : undefined;
  const imu: TripLog["imu"] = new Array(trip.imu.length);
  let kept = 0;
  let after = 0;
  let out = 0;
  const emitUntil = (tUs: number) => {
    for (; out < trip.imu.length && trip.imu[out].tUs <= tUs; out++) {
      const s = trip.imu[out];
      if (s.tUs < fromUs) {
        imu[out] = s;
        continue;
      }
      after++;
      const car = src.substitute(s, bridgeUs);
      if (!car) kept++;
      imu[out] = car ?? s;
    }
  };
  let k = 0;
  for (const s of trip.imu) {
    for (; k < speeds.length && speeds[k].tUs <= s.tUs; k++) {
      src.addWheels(speeds[k]);
      if (options.calibrate && (learnAll || speeds[k].tUs < fromUs)) src.learn(speeds[k]);
    }
    const o = proc.process(s);
    src.addGyro(s.tUs, o.valid ? o.yawRate : null);
    emitUntil(s.tUs - WHEEL_YAW_DELAY_US);
  }
  for (; k < speeds.length; k++) src.addWheels(speeds[k]);
  emitUntil(Infinity);
  return { trip: { ...trip, imu }, gyroShare: after ? kept / after : 0, calibration: options.calibrate ? src.calibration : null };
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
