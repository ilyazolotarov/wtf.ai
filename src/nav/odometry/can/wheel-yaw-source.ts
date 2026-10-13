// The navigator's turning from the rear wheels instead of the phone's gyro (NAVIGATOR-SPEC §5.4): the gyro reads the
// phone, which in a hand, a pocket or sliding on a seat turns on its own; the wheels read the car. The gyro still
// teaches the wheels (WheelYawCalibrator) wherever the two agree, and fills in where no wheel sample is near.
// One code for the app (NavigatorService) and replay (`withWheelYaw`).
import type { ImuSample, Vec3 } from "../../types";
import type { CanSpeedSample } from "./can-speed";
import { DEFAULT_TRACK_M } from "./wheel-yaw";
import { WheelYawCalibrator, type WheelYawCalibration, type WheelYawCalibrationConfig } from "./wheel-yaw-calibration";

/** Wheel yaw comes this much after the gyro's (frames at the bus's time, both adapters: −40…+100 ms by drive, 2026-10-12/13). */
export const WHEEL_LAG_US = 100_000;
/** A wheel yaw sample stands for the IMU samples within this of it. */
const FRESH_US = 300_000;
/** Kept this long behind the newest sample asked for. */
const KEEP_US = 3_000_000;
/**
 * A wheel sample this near: an IMU sample without one of its own (a break in listening) stays the car's, with the
 * phone's own turning. Switching to the phone's frame and back at every break read as handling (gravity jumping by
 * the phone's tilt in its mount), the turning unknown for 1.5 s each time: twice a second on drives with the polls'
 * breaks, 12–88 s off the drawn road where the gyro was 0–2 (2026-10-12).
 */
const CAR_FRAME_US = 1_000_000;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class WheelYawSource {
  private readonly calibrator: WheelYawCalibrator;
  /** Wheel yaw samples, time order, at the wheels' time less their lag (the gyro's time). */
  private yaw: { tUs: number; radps: number }[] = [];
  /** The gyro's yaw about "up" (null: handled), time order. */
  private gyro: { tUs: number; radps: number | null }[] = [];
  private keptFrom = -Infinity;

  /**
   * `applyLearned` false: the wheels turn with the defaults (track 1.60 m, no tyre term) while the calibrator learns
   * only to be noted. Replayed against the drawn roads (2026-10-12/13, 8 seeds) the learned tyre term helped in a
   * pocket and hurt in the mount (one drive 1–161 s off the road against 37–78 with the defaults).
   */
  constructor(
    start?: WheelYawCalibration | null,
    config?: Partial<WheelYawCalibrationConfig>,
    private readonly applyLearned = true,
  ) {
    this.calibrator = new WheelYawCalibrator(start, config);
  }

  get calibration(): WheelYawCalibration {
    return this.calibrator.calibration;
  }

  /**
   * A wheel sample as it arrives: its yaw, with the calibration learned so far, for `substitute`. `learn` it in time
   * order once the gyro around it is in.
   */
  addWheels(s: CanSpeedSample): void {
    const [, , rl, rr] = s.wheelsMps;
    const w = this.applyLearned ? this.calibrator.yaw(rr - rl, s.speedMps) : (rr - rl) / DEFAULT_TRACK_M;
    const tUs = s.tUs - WHEEL_LAG_US;
    const radps = s.reverse ? -w : w;
    let i = this.yaw.length;
    while (i > 0 && this.yaw[i - 1].tUs > tUs) i--;
    this.yaw.splice(i, 0, { tUs, radps });
  }

  /** The gyro's yaw about "up" for an IMU sample (null: the phone is being handled). */
  addGyro(tUs: number, radps: number | null): void {
    this.gyro.push({ tUs, radps });
  }

  /** A wheel sample, in time order with the IMU's: the calibrator learns from the gyro around it. */
  learn(s: CanSpeedSample): boolean | null {
    const [, , rl, rr] = s.wheelsMps;
    return this.calibrator.push(s.tUs, rl, rr, this.gyroAround(s.tUs - WHEEL_LAG_US), s.reverse);
  }

  /**
   * The wheels' yaw at `tUs` (rad/s, left positive), null when no wheel sample is near: interpolated between two
   * samples up to `bridgeUs` apart, else the nearest within `FRESH_US`.
   */
  yawAt(tUs: number, bridgeUs = 2 * FRESH_US): number | null {
    const y = this.yaw;
    let hi = 0;
    while (hi < y.length && y[hi].tUs <= tUs) hi++;
    const a = y[hi - 1];
    const b = y[hi];
    if (a && b && b.tUs - a.tUs <= bridgeUs) return a.radps + ((b.radps - a.radps) * (tUs - a.tUs)) / (b.tUs - a.tUs);
    if (bridgeUs < 2 * FRESH_US) return null;
    const near = [a, b].filter((x) => x && Math.abs(x.tUs - tUs) <= FRESH_US);
    return near.length ? near[0].radps : null;
  }

  /**
   * The IMU sample as the car's: the wheels' yaw about a vertical "up", the phone's acceleration kept. The phone's own
   * tilt and turning are left out, so its movements in a hand or a pocket don't read as handling (which would have
   * the navigator take the turning for unknown, 1.5 s each time). In a break in listening the phone's own turning,
   * still in the car's frame; null (the phone's sample as it is) with no wheel sample within `CAR_FRAME_US`. Also
   * prunes what is too old to be asked for.
   */
  substitute(s: ImuSample, bridgeUs?: number): ImuSample | null {
    this.prune(s.tUs - KEEP_US);
    const radps = this.yawAt(s.tUs, bridgeUs) ?? (this.wheelsNear(s.tUs) ? WheelYawSource.gyroYaw(s) : null);
    if (radps === null) return null;
    const g = Math.hypot(s.gravity[0], s.gravity[1], s.gravity[2]) || 9.81;
    return { ...s, gyro: [0, 0, radps], gravity: [0, 0, -g] };
  }

  /** A wheel sample within `CAR_FRAME_US` of `tUs`. */
  private wheelsNear(tUs: number): boolean {
    for (let i = this.yaw.length - 1; i >= 0; i--) {
      const d = this.yaw[i].tUs - tUs;
      if (Math.abs(d) <= CAR_FRAME_US) return true;
      if (d < -CAR_FRAME_US) return false;
    }
    return false;
  }

  /** The gyro's own yaw about "up" for an IMU sample (what `addGyro` wants when the caller has no processor's). */
  static gyroYaw(s: ImuSample): number {
    const g = Math.hypot(s.gravity[0], s.gravity[1], s.gravity[2]);
    return g > 0 ? dot(s.gyro, [-s.gravity[0] / g, -s.gravity[1] / g, -s.gravity[2] / g]) : s.gyro[2];
  }

  private gyroAround(tUs: number): number | null {
    let sum = 0;
    let n = 0;
    for (let i = this.gyro.length - 1; i >= 0 && this.gyro[i].tUs >= tUs - 50_000; i--) {
      const g = this.gyro[i];
      if (g.tUs > tUs + 50_000) continue;
      if (g.radps === null) return null;
      sum += g.radps;
      n++;
    }
    return n ? sum / n : null;
  }

  private prune(beforeUs: number): void {
    if (beforeUs - this.keptFrom < 1_000_000) return;
    this.keptFrom = beforeUs;
    let i = 0;
    while (i < this.yaw.length && this.yaw[i].tUs < beforeUs) i++;
    if (i) this.yaw.splice(0, i);
    i = 0;
    while (i < this.gyro.length && this.gyro[i].tUs < beforeUs) i++;
    if (i) this.gyro.splice(0, i);
  }
}
