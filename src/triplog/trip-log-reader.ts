// Trip log → typed sensor streams for replay (SPEC §3.10). Schema: ./schema.ts.

import type { GnssFix, ImuSample, ObdSpeedSample, Vec3 } from "../nav/types";
import {
  END_REASONS,
  ENGINE_STATE_CODES,
  GNSS_FLAGS,
  LOG_TAGS,
  NAV_MAPMATCH_STATE_CODES,
  NAV_MODE_CODES,
  NAV_POSE_CODES,
  NAV_SOURCE_CODES,
  NAV_TRUST_CODES,
  ROUTE_MANEUVER_CODES,
  ROUTE_REASON_CODES,
  ROUTE_STATE_CODES,
  ROUTE_STATUS_CODES,
  TRIP_EVENTS,
  type NavEstimateRecord,
  type NavMapMatchRecord,
  type NavRouteManeuverRecord,
  type NavRoutePointRecord,
  type NavRouteProgressRecord,
  type NavRouteRecord,
} from "./schema";
import { readULog, type RecordValue, type ULogRecord } from "./ulog/reader";

const PID_SPEED = 0x0d;
const PID_RPM = 0x0c;
/** `ELM_STATUS_CODES[0]`. */
const STATUS_OK = 0;

export interface TripLog {
  startUs: number;
  info: Record<string, RecordValue>;
  imu: ImuSample[];
  /** Raw magnetic field, µT, phone frame (absent in logs before it was recorded). */
  mag: { tUs: number; field: Vec3 }[];
  obdSpeed: ObdSpeedSample[];
  gnss: GnssFix[];
  engine: { tUs: number; state: string }[];
  rpm: { tUs: number; rpm: number }[];
  /** Trip events; `reason` only on `end`. */
  events: { tUs: number; event: string; reason?: string }[];
  /** Uptime ↔ wall clock pairs (interpolate between them). */
  timeSync: { tUs: number; utcUs: number }[];
  /** Text log lines except the ELM transcript: link events, markers, app notes. */
  messages: { tUs: number; tag: string; text: string }[];
  /** What the map showed (absent in logs before the navigator was wired in). */
  navEstimate: (Omit<NavEstimateRecord, "timestampUs"> & { tUs: number })[];
  /** Map matching in the app (absent in logs before it ran there); `top` without the NaN padding. */
  navMapMatch: (Omit<NavMapMatchRecord, "timestampUs"> & { tUs: number })[];
  /** Routes planned, their polylines and maneuvers, and guidance along them (absent before routing). */
  navRoute: (Omit<NavRouteRecord, "timestampUs"> & { tUs: number })[];
  navRoutePoints: (Omit<NavRoutePointRecord, "timestampUs"> & { tUs: number })[];
  navRouteManeuvers: (Omit<NavRouteManeuverRecord, "timestampUs"> & { tUs: number })[];
  navRouteProgress: (Omit<NavRouteProgressRecord, "timestampUs"> & { tUs: number })[];
  truncated: boolean;
}

const nameOf = (table: Record<string, number>, code: number) =>
  Object.keys(table).find((k) => table[k] === code) ?? `code_${code}`;

const num = (r: ULogRecord, key: string) => r[key] as number;
const vec3 = (r: ULogRecord, key: string): Vec3 => {
  const v = r[key] as number[];
  return [v[0], v[1], v[2]];
};
const valid = (v: number) => (Number.isFinite(v) ? v : undefined);

export function readTripLog(bytes: Uint8Array): TripLog {
  const log = readULog(bytes);
  const rows = (name: string) => log.data[name] ?? [];

  const imu = rows("imu_motion").map((r) => ({
    tUs: num(r, "timestamp"),
    gyro: vec3(r, "gyro_rad_s"),
    gravity: vec3(r, "gravity_m_s2"),
    userAccel: vec3(r, "user_accel_m_s2"),
  }));

  const mag = rows("mag_raw").map((r) => ({ tUs: num(r, "timestamp"), field: vec3(r, "mag_ut") }));

  const obdSpeed = rows("obd_pid")
    .filter((r) => num(r, "mode") === 1 && num(r, "pid") === PID_SPEED && num(r, "status") === STATUS_OK)
    .map((r) => {
      const rawKph = (r.data as number[])[0];
      // Sample time = midpoint of tx and rx; the record timestamp is rx (TRIP-LOGGER-SPEC §6).
      return { tUs: num(r, "timestamp") - num(r, "latency_us") / 2, speedMps: rawKph / 3.6, rawKph };
    })
    .sort((a, b) => a.tUs - b.tUs);

  const gnss = rows("gnss")
    .filter((r) => (num(r, "flags") & GNSS_FLAGS.simulated) === 0 && Number.isFinite(num(r, "h_acc_m")))
    .map((r): GnssFix => {
      const speed = valid(num(r, "speed_mps"));
      return {
        tUs: num(r, "timestamp"),
        lat: num(r, "lat_deg"),
        lon: num(r, "lon_deg"),
        hAccM: num(r, "h_acc_m"),
        speedMps: speed !== undefined && speed >= 0 ? speed : undefined,
        speedAccMps: valid(num(r, "speed_acc_mps")),
        courseRad: valid(num(r, "course_rad")),
        courseAccRad: valid(num(r, "course_acc_rad")),
      };
    })
    .sort((a, b) => a.tUs - b.tUs);

  const engine = rows("engine_state").map((r) => ({
    tUs: num(r, "timestamp"),
    state: ENGINE_STATE_CODES[num(r, "state")] ?? `code_${num(r, "state")}`,
  }));

  const rpm = rows("obd_pid")
    .filter((r) => num(r, "mode") === 1 && num(r, "pid") === PID_RPM && num(r, "status") === STATUS_OK)
    .map((r) => ({ tUs: num(r, "timestamp") - num(r, "latency_us") / 2, rpm: num(r, "value") }));

  const events = rows("trip_event").map((r) => {
    const event = nameOf(TRIP_EVENTS, num(r, "event"));
    return { tUs: num(r, "timestamp"), event, ...(event === "end" ? { reason: nameOf(END_REASONS, num(r, "reason")) } : {}) };
  });

  const timeSync = rows("time_sync").map((r) => ({ tUs: num(r, "timestamp"), utcUs: num(r, "utc_us") }));

  const messages = log.logs
    .filter((m) => m.tag !== LOG_TAGS.elm)
    .map((m) => ({ tUs: m.timestampUs, tag: m.tag === null ? "" : nameOf(LOG_TAGS, m.tag), text: m.text }));

  const navEstimate = rows("nav_estimate").map((r) => ({
    tUs: num(r, "timestamp"),
    latDeg: num(r, "lat_deg"),
    lonDeg: num(r, "lon_deg"),
    accuracyM: num(r, "accuracy_m"),
    headingRad: num(r, "heading_rad"),
    headingSigmaRad: num(r, "heading_sigma_rad"),
    speedMps: num(r, "speed_mps"),
    speedScale: num(r, "speed_scale"),
    gnssLagS: num(r, "gnss_lag_s"),
    behindUs: num(r, "behind_us"),
    mode: NAV_MODE_CODES[num(r, "mode")] ?? "none",
    source: NAV_SOURCE_CODES[num(r, "source")] ?? "gnss",
    trust: NAV_TRUST_CODES[num(r, "trust")] ?? "NO_FIX",
    parkedPose: NAV_POSE_CODES[num(r, "parked_pose")] ?? "none",
  }));

  const navMapMatch = rows("nav_mapmatch").map((r) => {
    const weight = r.weight as number[];
    const lat = r.lat_deg as number[];
    const lon = r.lon_deg as number[];
    const heading = r.heading_rad as number[];
    const spread = r.spread_m as number[];
    return {
      tUs: num(r, "timestamp"),
      state: NAV_MAPMATCH_STATE_CODES[num(r, "state")] ?? "off",
      particles: num(r, "particles"),
      clusters: num(r, "clusters"),
      updateUs: num(r, "update_us"),
      updates: { count: num(r, "update_count"), totalUs: num(r, "update_total_us"), maxUs: num(r, "update_max_us") },
      graphBuilt: num(r, "graph_built"),
      top: weight
        .map((w, i) => ({ weight: w, latDeg: lat[i], lonDeg: lon[i], headingRad: heading[i], spreadM: spread[i] }))
        .filter((c) => Number.isFinite(c.weight)),
    };
  });

  const navRoute = rows("nav_route").map((r) => ({
    tUs: num(r, "timestamp"),
    planId: num(r, "plan_id"),
    reason: ROUTE_REASON_CODES[num(r, "reason")] ?? "new",
    status: ROUTE_STATUS_CODES[num(r, "status")] ?? "cancelled",
    fromLatDeg: num(r, "from_lat_deg"),
    fromLonDeg: num(r, "from_lon_deg"),
    fromHeadingRad: num(r, "from_heading_rad"),
    toLatDeg: num(r, "to_lat_deg"),
    toLonDeg: num(r, "to_lon_deg"),
    lengthM: num(r, "length_m"),
    durationS: num(r, "duration_s"),
    offStartM: num(r, "off_start_m"),
    offEndM: num(r, "off_end_m"),
    states: num(r, "states"),
    tiles: num(r, "tiles"),
    planMs: num(r, "plan_ms"),
    wallMs: num(r, "wall_ms"),
    slices: num(r, "slices"),
    points: num(r, "points"),
    maneuvers: num(r, "maneuvers"),
    graphBuilt: num(r, "graph_built"),
  }));
  const navRoutePoints = rows("nav_route_point").map((r) => ({
    tUs: num(r, "timestamp"),
    planId: num(r, "plan_id"),
    index: num(r, "index"),
    latDeg: num(r, "lat_deg"),
    lonDeg: num(r, "lon_deg"),
  }));
  const navRouteManeuvers = rows("nav_route_maneuver").map((r) => ({
    tUs: num(r, "timestamp"),
    planId: num(r, "plan_id"),
    index: num(r, "index"),
    kind: ROUTE_MANEUVER_CODES[num(r, "kind")] ?? "depart",
    exit: num(r, "exit"),
    latDeg: num(r, "lat_deg"),
    lonDeg: num(r, "lon_deg"),
    atM: num(r, "at_m"),
    turnRad: num(r, "turn_rad"),
  }));
  const navRouteProgress = rows("nav_route_progress").map((r) => ({
    tUs: num(r, "timestamp"),
    planId: num(r, "plan_id"),
    state: ROUTE_STATE_CODES[num(r, "state")] ?? "on",
    nextIndex: num(r, "next_index"),
    alongM: num(r, "along_m"),
    offM: num(r, "off_m"),
    remainingM: num(r, "remaining_m"),
    remainingS: num(r, "remaining_s"),
    toNextM: num(r, "to_next_m"),
  }));

  return {
    startUs: log.startUs,
    info: log.info,
    imu,
    mag,
    obdSpeed,
    gnss,
    engine,
    rpm,
    events,
    timeSync,
    messages,
    navEstimate,
    navMapMatch,
    navRoute,
    navRoutePoints,
    navRouteManeuvers,
    navRouteProgress,
    truncated: log.truncated,
  };
}
