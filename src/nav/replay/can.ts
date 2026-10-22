// A trip log's CAN shadow frames decoded through the car's profile (SPEC §2.1: decoded in replay).
import { CarStateDecoder, type CarStateSample } from "../odometry/can/car-state";
import { CAN_SPEED_PERIOD_US, canSpeedReading, canSpeedSamples, navigatorSpeeds, type CanSpeed } from "../odometry/can/can-speed";
import { retimeFrames } from "../odometry/can/frame-timing";
import type { WheelYawCalibration, WheelYawCalibrationConfig } from "../odometry/can/wheel-yaw-calibration";
import { WheelYawSource } from "../odometry/can/wheel-yaw-source";
import { ImuProcessor } from "../odometry/imu/imu-processor";
import { foundProfile } from "../odometry/can/discovery";
import { makeForVin, matchProfiles, profileByKey, seenIds, type Profile, type ProfileMatch, type SeenId } from "../odometry/can/profile";
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
 * (2026-10-12). A frame later than any drain is from a window the log has no record of (the app died in it) and keeps
 * its arrival: moved to the last recorded window's end, 6 min of highway (u37h65) stood at one instant and the replay
 * had no speed after it.
 */
export function busTimedFrames(trip: TripLog): NonNullable<TripLog["can"]> {
  const frames = trip.can ?? [];
  const windows = trip.canWindows;
  if (!windows?.length) return frames;
  let w = 0;
  return frames.map((f) => {
    while (w + 1 < windows.length && windows[w + 1].startUs <= f.tUs) w++;
    const win = windows[w];
    return win.startUs <= f.tUs && f.tUs > win.endUs && f.tUs - win.endUs <= DRAIN_MAX_US ? { ...f, tUs: win.endUs } : f;
  });
}

/** The latest a stop's drain arrives after the window's end: a stop waits up to 1 s for its prompt, then one more 1 s. */
const DRAIN_MAX_US = 3_000_000;

/** Null when the log has no CAN frames. `profileKey` overrides the choice ("make/mapping/dbc"). */
export function decodeTripCan(trip: TripLog, profileKey?: string): TripCan | null {
  if (!trip.can?.length) return null;
  // At the bus's times: drained frames at their window's end, each id on its period, a break at each window's end
  // (frame-timing.ts), as the app.
  const frames = retimeFrames(busTimedFrames(trip), trip.canWindows ?? []);
  const seen = seenIds(frames);
  const listened = listenedIds(trip);
  const vin = typeof trip.info.vehicle_vin === "string" ? trip.info.vehicle_vin : null;
  // A car without a profile drove on what the search found on its bus (VEHICLE-LINK-SPEC §16.6): its key in the notes.
  // Of the VIN's make, as the app made it (`CanDiscovery.useFound`): matching keeps only the make's profiles.
  const make = makeForVin(vin) ?? "unknown";
  const found = foundInLog(trip, make);
  const matches = matchProfiles(seen, vin, listened ?? undefined, found ? [found] : []);
  // A find the app had is the car's profile: it was searched for because no other fits.
  const profile = profileKey ? (profileByKey(profileKey) ?? foundProfile(profileKey, make)) : (found ?? matches[0]?.profile ?? null);
  const samples: CarStateSample[] = [];
  if (profile) {
    const decoder = new CarStateDecoder(profile);
    for (const f of frames) for (const s of decoder.push(f.tUs, f.id, f.data)) samples.push(s);
  }
  return { matches, profile, samples, listened, seen };
}

/**
 * The profile a log's notes name from a discovery, if any: the one CAN primary's note names (the speed came from it),
 * else the last one probation checked (an earlier find it refuted, the search went on).
 */
function foundInLog(trip: TripLog, make: string): Profile | null {
  const primary = trip.messages.map((m) => /^can primary: .*profile (found\/\S+)/.exec(m.text)?.[1]).find((k) => k);
  if (primary) return foundProfile(primary, make);
  const checked = trip.messages.map((m) => /^can probation: checking (found\/\S+)/.exec(m.text)?.[1]).filter((k) => k);
  return checked.length ? foundProfile(checked.at(-1)!, make) : null;
}

function canSample(s: CanSpeed): TripLog["obdSpeed"][number] {
  return { tUs: s.tUs, rxUs: s.tUs, ...canSpeedReading(s), source: "can" };
}

/** OBD speed fills in when the last CAN speed is older than this (the monitor's breaks for polls are ~0.16 s). */
const CAN_FRESH_US = 300_000;

/**
 * The trip as the navigator would drive it on CAN speed (SPEC §2.1 Stage 2): ~10 Hz samples of the mean wheel speed
 * (a profile without wheel speeds: of its speed message), `source: "can"`, where the monitor heard them, and the
 * log's OBD speed where it didn't. In reverse gear the speed is negative (`rawKph` stays the unsigned reading): the
 * navigator and the map matching move the car backwards. Null when the log has neither.
 */
export function withCanSpeed(trip: TripLog, profileKey?: string, fromUs = -Infinity): TripLog | null {
  // Already on CAN speed (`canPrimaryInput`, or twice asked): as it is.
  if (trip.obdSpeed.some((s) => s.source === "can")) return trip;
  const can = decodeTripCan(trip, profileKey);
  // The wheels, else the speed message: what the app's feed decodes (can-speed-feed.ts).
  const speeds = can?.profile ? navigatorSpeeds(can.samples, can.profile).filter((s) => s.tUs >= fromUs) : [];
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

const PRIMARY_NOTE = "can primary: speed from the wheels";
/** Notes of a drive whose CAN speed carried nothing until a pass: probation's (§16.5) and discovery's (§16.6). */
const ON_OBD_NOTES = ["can probation: ", "can discovery: "];

/**
 * From when the app's navigator drove on the wheels (µs; -Infinity: the whole log), null: never. A log recorded with
 * CAN primary (`can_primary: on`, VEHICLE-LINK-SPEC §16.3) did all along (before the feed's note no CAN was heard);
 * turned on mid-drive, from the feed's note (`can primary: speed from the wheels`). A drive with probation (§16.5:
 * checking, or a fail remembered from an earlier drive) or discovery (§16.6) in its notes carried the speed only from
 * that note, a pass; without one, never: the frames heard were the check's or the search's.
 */
export function canPrimaryFromUs(trip: TripLog): number | null {
  const note = trip.messages.find((m) => m.text.startsWith(PRIMARY_NOTE));
  if (trip.messages.some((m) => ON_OBD_NOTES.some((n) => m.text.startsWith(n)))) return note?.tUs ?? null;
  return trip.info.can_primary === "on" || note ? -Infinity : null;
}

/**
 * The input the app's navigator had: a log recorded with CAN primary has OBD speed only while standing, the navigator
 * drove on the wheels from `canPrimaryFromUs`; before it, the log as the phone had it.
 */
export function canPrimaryInput(trip: TripLog): TripLog {
  const cached = primaryInputs.get(trip);
  if (cached) return cached;
  const fromUs = canPrimaryFromUs(trip);
  const input = fromUs !== null ? (withCanSpeed(trip, undefined, fromUs) ?? trip) : trip;
  primaryInputs.set(trip, input);
  return input;
}

/** Decoding a log's frames takes a second: once per log (the truth's odometer and the replay both ask). */
const primaryInputs = new WeakMap<TripLog, TripLog>();

/** The app's OBD poller read the speed about this often while the car moved (2026-10 logs, both adapters). */
export const OBD_POLL_HZ = 2;
/** Half a poll's round trip: when the answer reached the phone after the sample time (latency p50 20-90 ms). */
const OBD_HALF_LATENCY_US = 15_000;
/** No speed this long before a poll (the link lost, the ECU asleep): no answer, as the poller would have had none. */
const OBD_SOURCE_STALE_US = 1_000_000;

/**
 * The speed as OBD polls would have read it instead of the wheels (research, the viewer's Experiment): `hz` polls a
 * second, each the speed then (the wheels where the shadow heard them, the log's OBD where not) in whole km/h, 0 in
 * reverse as the test car's ECU reads it (another car's may not), none where the log has no speed (the link lost),
 * fed as OBD (`source` absent). What CAN primary buys over OBD on the same drive. The frames stay, so the wheels' yaw
 * is a separate choice.
 */
export function obdFromCan(trip: TripLog, hz = OBD_POLL_HZ): TripLog {
  const speeds = canPrimaryInput(trip).obdSpeed;
  const obdSpeed: TripLog["obdSpeed"] = [];
  if (speeds.length) {
    const stepUs = 1e6 / hz;
    let i = 0;
    for (let tUs = speeds[0].tUs; tUs <= speeds[speeds.length - 1].tUs; tUs += stepUs) {
      while (i + 1 < speeds.length && speeds[i + 1].tUs <= tUs) i++;
      if (tUs - speeds[i].tUs > OBD_SOURCE_STALE_US) continue;
      // Reversing, this car's PID 0D reads 0 (CAN gives the wheels negative there).
      const rawKph = speeds[i].speedMps < 0 ? 0 : Math.round(speeds[i].speedMps * 3.6);
      obdSpeed.push({ tUs, speedMps: rawKph / 3.6, rawKph, rxUs: tUs + OBD_HALF_LATENCY_US });
    }
  }
  return {
    ...trip,
    info: { ...trip.info, can_primary: "off" },
    // Not CAN primary any more: the app replay must not decode the wheels into the speed again.
    messages: trip.messages.filter((m) => !m.text.startsWith(PRIMARY_NOTE)),
    obdSpeed,
  };
}
