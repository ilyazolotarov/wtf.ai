// Trip log schema, version 1 (docs/TRIP-LOGGER-SPEC.md §6). Changes must stay additive;
// a breaking change bumps WTF_LOG_VERSION and the Python reader.

import type { ULogFormat } from "./ulog/format";

export const WTF_LOG_VERSION = 1;

const ts = { type: "uint64_t", name: "timestamp" } as const;

export const OBD_PID: ULogFormat = {
  name: "obd_pid",
  fields: [
    ts,
    { type: "uint32_t", name: "latency_us" },
    { type: "uint8_t", name: "mode" },
    { type: "uint8_t", name: "pid" },
    { type: "uint8_t", name: "status" },
    { type: "uint8_t", name: "n_bytes" },
    { type: "uint8_t", name: "data", count: 4 },
    { type: "uint16_t", name: "ecu" },
    { type: "float", name: "value" },
  ],
};

export const GNSS: ULogFormat = {
  name: "gnss",
  fields: [
    ts,
    { type: "int64_t", name: "utc_us" },
    { type: "double", name: "lat_deg" },
    { type: "double", name: "lon_deg" },
    { type: "float", name: "alt_msl_m" },
    { type: "float", name: "alt_ellipsoid_m" },
    { type: "float", name: "h_acc_m" },
    { type: "float", name: "v_acc_m" },
    { type: "float", name: "speed_mps" },
    { type: "float", name: "speed_acc_mps" },
    { type: "float", name: "course_rad" },
    { type: "float", name: "course_acc_rad" },
    { type: "uint32_t", name: "delivery_delay_us" },
    { type: "uint8_t", name: "flags" },
  ],
};

export const IMU_MOTION: ULogFormat = {
  name: "imu_motion",
  fields: [
    ts,
    { type: "float", name: "gyro_rad_s", count: 3 },
    { type: "float", name: "user_accel_m_s2", count: 3 },
    { type: "float", name: "gravity_m_s2", count: 3 },
    { type: "float", name: "attitude_q", count: 4 },
  ],
};

export const GYRO_RAW: ULogFormat = {
  name: "gyro_raw",
  fields: [ts, { type: "float", name: "gyro_rad_s", count: 3 }],
};

export const ACCEL_RAW: ULogFormat = {
  name: "accel_raw",
  fields: [ts, { type: "float", name: "accel_m_s2", count: 3 }],
};

/** Raw (uncalibrated) magnetic field, µT, phone frame. Logged only (SPEC §2). */
export const MAG_RAW: ULogFormat = {
  name: "mag_raw",
  fields: [ts, { type: "float", name: "mag_ut", count: 3 }],
};

export const ENGINE_STATE: ULogFormat = {
  name: "engine_state",
  fields: [ts, { type: "uint8_t", name: "state" }],
};

export const TRIP_EVENT: ULogFormat = {
  name: "trip_event",
  fields: [ts, { type: "uint8_t", name: "event" }, { type: "uint8_t", name: "reason" }],
};

export const LINK_STATS: ULogFormat = {
  name: "link_stats",
  fields: [
    ts,
    { type: "float", name: "speed_hz" },
    { type: "float", name: "latency_p50_ms" },
    { type: "float", name: "latency_p95_ms" },
    { type: "uint16_t", name: "errors" },
    { type: "uint8_t", name: "link_state" },
    { type: "float", name: "battery_v" },
  ],
};

export const TIME_SYNC: ULogFormat = {
  name: "time_sync",
  fields: [ts, { type: "int64_t", name: "utc_us" }],
};

/** What the map showed: every position the navigator service published (NAVIGATOR-SPEC §9). */
export const NAV_ESTIMATE: ULogFormat = {
  name: "nav_estimate",
  fields: [
    ts,
    { type: "double", name: "lat_deg" },
    { type: "double", name: "lon_deg" },
    { type: "float", name: "accuracy_m" },
    { type: "float", name: "heading_rad" },
    { type: "float", name: "heading_sigma_rad" },
    { type: "float", name: "speed_mps" },
    { type: "float", name: "speed_scale" },
    { type: "float", name: "gnss_lag_s" },
    { type: "uint32_t", name: "behind_us" },
    { type: "uint8_t", name: "mode" },
    { type: "uint8_t", name: "source" },
    { type: "uint8_t", name: "trust" },
    { type: "uint8_t", name: "parked_pose" },
  ],
};

/** Number of map-match hypotheses kept per `nav_mapmatch` record (heaviest first; NaN-padded). */
export const MAPMATCH_TOP = 3;

/** Map matching at each `nav_estimate` while a road graph is set (MAPMATCH-SPEC §11). */
export const NAV_MAPMATCH: ULogFormat = {
  name: "nav_mapmatch",
  fields: [
    ts,
    { type: "uint8_t", name: "state" },
    { type: "uint8_t", name: "clusters" },
    { type: "uint16_t", name: "particles" },
    { type: "uint32_t", name: "update_us" },
    { type: "uint32_t", name: "graph_built" },
    { type: "float", name: "weight", count: MAPMATCH_TOP },
    { type: "double", name: "lat_deg", count: MAPMATCH_TOP },
    { type: "double", name: "lon_deg", count: MAPMATCH_TOP },
    { type: "float", name: "heading_rad", count: MAPMATCH_TOP },
    { type: "float", name: "spread_m", count: MAPMATCH_TOP },
  ],
};

export const ALL_FORMATS: readonly ULogFormat[] = [
  OBD_PID,
  GNSS,
  IMU_MOTION,
  GYRO_RAW,
  ACCEL_RAW,
  ENGINE_STATE,
  TRIP_EVENT,
  LINK_STATS,
  TIME_SYNC,
  NAV_ESTIMATE,
  MAG_RAW,
  NAV_MAPMATCH,
];

export const ENGINE_STATE_CODES = ["unknown", "ignition-off", "engine-off", "engine-running"] as const;

export const TRIP_EVENTS = {
  start: 0,
  end: 1,
  linkLost: 2,
  linkRestored: 3,
  marker: 4,
  prerollEnd: 5,
} as const;

export const END_REASONS = {
  ignitionOff: 0,
  parkedTimeout: 1,
  linkTimeout: 2,
  manual: 3,
} as const;

export type EndReason = "ignition-off" | "parked-timeout" | "link-timeout" | "manual";

export const END_REASON_CODES: Record<EndReason, number> = {
  "ignition-off": END_REASONS.ignitionOff,
  "parked-timeout": END_REASONS.parkedTimeout,
  "link-timeout": END_REASONS.linkTimeout,
  manual: END_REASONS.manual,
};

export const LINK_STATE_CODES = [
  "idle",
  "discovering",
  "connecting",
  "probing",
  "standby",
  "initializing",
  "polling",
  "reconnecting",
  "error",
] as const;

export const LOG_TAGS = {
  elm: 1,
  link: 2,
  trip: 3,
  sensors: 4,
  app: 5,
} as const;

export const NAV_MODE_CODES = ["none", "anchored", "dr"] as const;
export const NAV_SOURCE_CODES = ["gnss", "fused", "dr", "manual"] as const;
export const NAV_TRUST_CODES = ["TRUSTED", "UNTRUSTED", "REACQUIRING", "NO_FIX"] as const;
export const NAV_POSE_CODES = ["none", "unverified", "confirmed", "rejected"] as const;
export const NAV_MAPMATCH_STATE_CODES = ["off", "init", "tracking", "multimodal", "offroad"] as const;

export const GNSS_FLAGS = {
  simulated: 1,
  fromAccessory: 2,
} as const;

// ---- record shapes ----

export interface ObdPidRecord {
  /** rx time, µs uptime. */
  timestampUs: number;
  latencyUs: number;
  mode: number;
  pid: number;
  status: number;
  data: number[];
  ecu: number;
  value: number;
}

export interface GnssRecord {
  timestampUs: number;
  utcUs: number;
  latDeg: number;
  lonDeg: number;
  altMslM: number;
  altEllipsoidM: number;
  hAccM: number;
  vAccM: number;
  speedMps: number;
  speedAccMps: number;
  courseRad: number;
  courseAccRad: number;
  deliveryDelayUs: number;
  flags: number;
}

export interface NavEstimateRecord {
  /** Publish time, µs uptime. */
  timestampUs: number;
  latDeg: number;
  lonDeg: number;
  accuracyM: number;
  /** NaN when unknown. */
  headingRad: number;
  headingSigmaRad: number;
  speedMps: number;
  speedScale: number;
  gnssLagS: number;
  /** How far the navigator's state lagged the publish time (the drawn position is extrapolated over it). */
  behindUs: number;
  mode: (typeof NAV_MODE_CODES)[number];
  source: (typeof NAV_SOURCE_CODES)[number];
  trust: (typeof NAV_TRUST_CODES)[number];
  parkedPose: (typeof NAV_POSE_CODES)[number];
}

export interface NavMapMatchHypothesis {
  weight: number;
  latDeg: number;
  lonDeg: number;
  headingRad: number;
  spreadM: number;
}

export interface NavMapMatchRecord {
  /** Publish time, µs uptime (the same as the `nav_estimate` it goes with). */
  timestampUs: number;
  state: (typeof NAV_MAPMATCH_STATE_CODES)[number];
  particles: number;
  /** All hypotheses (up to 5); `top` holds the first `MAPMATCH_TOP`. */
  clusters: number;
  updateUs: number;
  /** The graph file's build time (unix s): identifies the graph version. */
  graphBuilt: number;
  top: NavMapMatchHypothesis[];
}

export interface ImuMotionRecord {
  timestampUs: number;
  gyro: readonly [number, number, number];
  userAccel: readonly [number, number, number];
  gravity: readonly [number, number, number];
  /** w, x, y, z */
  attitude: readonly [number, number, number, number];
}

export interface Vec3Record {
  timestampUs: number;
  v: readonly [number, number, number];
}

export interface LinkStatsRecord {
  timestampUs: number;
  speedHz: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  errors: number;
  linkState: number;
  batteryV: number;
}
