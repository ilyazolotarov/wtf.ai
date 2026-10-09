// A trip as the app without an adapter would drive it (experiment): its OBD speed replaced by the phone-only speed
// (odometry/imu/imu-speed.ts), from the IMU and, when not jammed, satellite GNSS speed. Samples arrive like an OBD
// poll; reverse reads 0, as the CX-5's ECU does (NAVIGATOR-SPEC §5.2), so the navigator's manoeuvre logic applies.

import type { TripLog } from "../../triplog/trip-log-reader";
import { ImuSpeedEstimator, type ImuSpeedConfig, type PhoneMount } from "../odometry/imu/imu-speed";
import { isSatelliteFix } from "../types";

const POLL_US = 200_000;

/**
 * `mounts`: the phone mount per car, as the app would store it: read at the start (the car's last drive), written at
 * the end. Omitted, every drive learns it from its own turns.
 */
export function withPhoneSpeed(
  trip: TripLog,
  config: Partial<ImuSpeedConfig> = {},
  mounts?: Map<string, PhoneMount>,
  useGnss = true,
  /** Experiment only: scale the drive's phone speed so its distance matches OBD's (what a perfect scale would give). */
  oracleScale = false,
): TripLog {
  const car = String(trip.info.vehicle_vin ?? trip.info.obd_protocol ?? "car");
  const est = new ImuSpeedEstimator(config, {}, mounts?.get(car) ?? null);
  const gnss = useGnss ? trip.gnss.filter(isSatelliteFix) : [];
  let gi = 0;
  let nextUs = -Infinity;
  const obdSpeed: TripLog["obdSpeed"] = [];
  for (const s of trip.imu) {
    while (gi < gnss.length && gnss[gi].tUs <= s.tUs) {
      const g = gnss[gi++];
      est.updateSpeed(g.speedMps!, Math.max(0.3, g.speedAccMps ?? 1));
    }
    const o = est.process(s);
    if (s.tUs < nextUs) continue;
    nextUs = s.tUs + POLL_US;
    if (!Number.isFinite(o.speedMps)) continue;
    const speedMps = o.direction === -1 ? 0 : Math.max(0, o.speedMps);
    const rawKph = Math.round(speedMps * 3.6);
    obdSpeed.push({ tUs: s.tUs, rxUs: s.tUs, speedMps: rawKph / 3.6, rawKph });
  }
  if (oracleScale) {
    const dist = (xs: TripLog["obdSpeed"]) => xs.reduce((sum, x, i) => (i ? sum + x.speedMps * Math.min(2.5, (x.tUs - xs[i - 1].tUs) / 1e6) : sum), 0);
    const k = dist(obdSpeed) > 0 ? dist(trip.obdSpeed) / dist(obdSpeed) : 1;
    for (const x of obdSpeed) {
      x.rawKph = Math.round(x.rawKph * k);
      x.speedMps = x.rawKph / 3.6;
    }
  }
  const learned = est.mount;
  if (mounts && learned) mounts.set(car, learned);
  return { ...trip, obdSpeed, rpm: [] };
}
