// Deterministic synthetic drive for navigator tests: ground truth plus the sensor streams
// the phone would log (IMU 100 Hz, OBD speed 20 Hz, CoreLocation 1 Hz).

import type { TripLog } from "../../triplog/trip-log-reader";
import { Compass, type CompassCalibration } from "../compass/compass";
import type { Coordinate } from "../geo";
import { LocalFrame } from "../geo/local-frame";
import type { GnssFix, ImuSample, MagSample, ObdSpeedSample } from "../types";

export interface DriveSegment {
  durationS: number;
  /** Speed at the end of the segment (linear ramp from the previous one). */
  speedMps: number;
  /** Counter-clockwise (left turn) positive. */
  yawRateDegS: number;
}

export interface SyntheticOptions {
  segments: DriveSegment[];
  origin?: Coordinate;
  startHeadingRad?: number;
  /** clean: satellite fixes with speed and course; coarse: Wi-Fi-like fixes, position only. */
  gnss?: "clean" | "coarse" | "none";
  gnssSigmaM?: number;
  /** CoreLocation reports this late (position/course; speed 0.6 s later still). Real drives: ~0. */
  gnssLagS?: number;
  /** OBD reads true speed × this, quantized to 1 km/h. */
  obdScale?: number;
  gyroBiasRadS?: number;
  gyroNoiseRadS?: number;
  /** Phone in hand during [fromS, toS): tilt swinging up to `tiltRad` (0.5 Hz), plus a spin. */
  handling?: { fromS: number; toS: number; tiltRad: number; yawRateRadS?: number };
  /** Raw magnetometer at 20 Hz: Earth's field (19 µT horizontal, 46 µT down) plus a constant offset. */
  magnetometer?: { offsetUt?: [number, number, number] };
  seed?: number;
}

export interface TruthPoint {
  tUs: number;
  lat: number;
  lon: number;
  /** Clockwise from north. */
  psi: number;
  speedMps: number;
}

export interface SyntheticDrive {
  trip: TripLog;
  truth: TruthPoint[];
  truthAt(tUs: number): TruthPoint;
}

function rng(seed: number) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
  return { uniform, gauss };
}

export function syntheticDrive(o: SyntheticOptions): SyntheticDrive {
  const r = rng(o.seed ?? 1);
  const frame = new LocalFrame(o.origin ?? { lat: 51.52, lon: 30.76 });
  const startUs = 1_000_000_000;
  const dt = 0.01;
  const lag = o.gnssLagS ?? 0;
  const sigma = o.gnssSigmaM ?? (o.gnss === "coarse" ? 40 : 3);
  const bias = o.gyroBiasRadS ?? 0;
  const gyroNoise = o.gyroNoiseRadS ?? 0.003;

  const truth: TruthPoint[] = [];
  const imu: ImuSample[] = [];
  const obdSpeed: ObdSpeedSample[] = [];
  const gnss: GnssFix[] = [];
  const mag: MagSample[] = [];
  const magOffset = o.magnetometer?.offsetUt ?? [45, 135, 60];

  let e = 0;
  let n = 0;
  let psi = o.startHeadingRad ?? 0;
  let v = 0;
  let step = 0;
  for (const seg of o.segments) {
    const v0 = v;
    const steps = Math.round(seg.durationS / dt);
    for (let k = 0; k < steps; k++, step++) {
      const tS = step * dt;
      const tUs = startUs + Math.round(tS * 1e6);
      v = v0 + ((seg.speedMps - v0) * (k + 1)) / steps;
      const yawCcw = v > 0 ? (seg.yawRateDegS * Math.PI) / 180 : 0;
      psi -= yawCcw * dt;
      e += v * Math.sin(psi) * dt;
      n += v * Math.cos(psi) * dt;
      const c = frame.toCoordinate(e, n);
      truth.push({ tUs, lat: c.lat, lon: c.lon, psi, speedMps: v });

      const h = o.handling && tS >= o.handling.fromS && tS < o.handling.toS ? o.handling : null;
      const tilt = h ? h.tiltRad * Math.sin(Math.PI * (tS - h.fromS)) : 0;
      imu.push({
        tUs,
        gyro: [0, 0, yawCcw + bias + gyroNoise * r.gauss() + (h?.yawRateRadS ?? 0)],
        gravity: [0, 9.80665 * Math.sin(tilt), -9.80665 * Math.cos(tilt)],
        userAccel: [0.02 * r.gauss(), 0.02 * r.gauss(), 0.02 * r.gauss()],
      });
      if (o.magnetometer && step % 5 === 0) {
        // The phone lies flat with x forward: in (forward, left) Earth's horizontal field is
        // B·(cos ψ, sin ψ) for a heading ψ clockwise from north; z (up) sees the vertical field.
        mag.push({
          tUs,
          field: [magOffset[0] + 19 * Math.cos(psi) + 0.5 * r.gauss(), magOffset[1] + 19 * Math.sin(psi) + 0.5 * r.gauss(), magOffset[2] - 46 + 0.5 * r.gauss()],
        });
      }
      if (step % 5 === 0) {
        const rawKph = Math.round(v * 3.6 * (o.obdScale ?? 1));
        obdSpeed.push({ tUs, speedMps: rawKph / 3.6, rawKph });
      }
    }
  }

  const truthAt = (tUs: number): TruthPoint => {
    const i = Math.min(truth.length - 1, Math.max(0, Math.round((tUs - startUs) / (dt * 1e6)) - 1));
    return truth[i];
  };

  if (o.gnss !== "none") {
    const endUs = truth[truth.length - 1].tUs;
    for (let tUs = startUs + 1_000_000; tUs <= endUs; tUs += 1_000_000) {
      const p = truthAt(tUs - lag * 1e6);
      const [pe, pn] = frame.toEnu(p);
      const c = frame.toCoordinate(pe + sigma * r.gauss(), pn + sigma * r.gauss());
      if (o.gnss === "coarse") {
        gnss.push({ tUs, lat: c.lat, lon: c.lon, hAccM: sigma * 1.5 });
      } else {
        const sp = truthAt(tUs - (lag + 0.6) * 1e6).speedMps;
        gnss.push({
          tUs,
          lat: c.lat,
          lon: c.lon,
          hAccM: sigma * 1.5,
          speedMps: sp,
          speedAccMps: 0.3,
          courseRad: sp > 1 ? (p.psi + 2 * Math.PI) % (2 * Math.PI) : undefined,
          courseAccRad: sp > 1 ? 0.05 : undefined,
        });
      }
    }
  }

  return {
    trip: { startUs, info: {}, imu, mag, obdSpeed, gnss, engine: [], rpm: [], events: [], timeSync: [], messages: [], navEstimate: [], navMapMatch: [], navRoute: [], navRoutePoints: [], navRouteManeuvers: [], navRouteProgress: [], truncated: false },
    truth,
    truthAt,
  };
}

/**
 * A compass calibration for `magnetometer` drives (default offset): the flat phone turned through
 * every heading twice, driving straight at each, as if the EKF knew the heading.
 */
export function syntheticCompassCalibration(offsetUt: [number, number, number] = [45, 135, 60]): CompassCalibration {
  const compass = new Compass();
  let tUs = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let deg = 0; deg < 360; deg += 10) {
      const psi = (deg * Math.PI) / 180;
      for (let k = 0; k < 120; k++, tUs += 10_000) {
        compass.onImu(tUs, [0, 0, 1], 0, true);
        if (k % 5 === 0) compass.onMag(tUs, [offsetUt[0] + 19 * Math.cos(psi), offsetUt[1] + 19 * Math.sin(psi), offsetUt[2] - 46]);
      }
      compass.observe(psi);
    }
  }
  return compass.calibration!;
}
