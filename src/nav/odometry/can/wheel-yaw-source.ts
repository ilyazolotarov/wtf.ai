// The navigator's turning from the rear wheels instead of the phone's gyro (NAVIGATOR-SPEC §5.4): the gyro reads the
// phone, which in a hand, a pocket or sliding on a seat turns on its own; the wheels read the car. The gyro still
// teaches the wheels (WheelYawCalibrator) wherever the two agree, and fills in where no wheel sample is near.
// One code for the app (NavigatorService) and replay (`withWheelYaw`).
import type { ImuSample, Vec3 } from "../../types";
import type { CanSpeedSample } from "./can-speed";
import { NO_GEAR_MIN_MPS } from "./wheel-yaw";
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
/**
 * The wheels gone silent with the car standing (ignition off, the link lost): it stands, in the car's frame, until the
 * navigator takes its speed for unknown and holds the heading itself (`obdStaleUs` 2.5 s after the speed's time, the
 * wheels' plus their lag). After 1 s the phone's sample went in as it is, its turning not read as handling (a change of
 * frame), and the driver taking the phone out turned a parked car 21–34° (r4banv, 2026-10-20).
 */
const SILENT_STANDING_US = 3_000_000;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class WheelYawSource {
  private calibrator: WheelYawCalibrator;
  /** Wheel yaw samples, time order, at the wheels' time less their lag (the gyro's time). */
  private yaw: { tUs: number; radps: number; speedMps: number; noGear: boolean }[] = [];
  /** The gyro's yaw about "up" (null: handled), time order. */
  private gyro: { tUs: number; radps: number | null }[] = [];
  private keptFrom = -Infinity;

  /**
   * The wheels turn with the calibration learned so far: the rear tyres' difference read 0.6 °/s of right turn at
   * 70 km/h on one car, the dot 9 m right of clean fixes for a minute (ebwp4t, 2026-10-18).
   */
  constructor(
    start?: WheelYawCalibration | null,
    private readonly config?: Partial<WheelYawCalibrationConfig>,
  ) {
    this.calibrator = new WheelYawCalibrator(start, config);
  }

  /** Start from this calibration (the car's, known late) while nothing is learned yet; returns whether it took it. */
  seed(start: WheelYawCalibration): boolean {
    if (this.calibrator.calibration.learnedS > 0) return false;
    this.calibrator = new WheelYawCalibrator(start, this.config);
    return true;
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
    const w = this.calibrator.yaw(rr - rl, s.speedMps);
    const tUs = s.tUs - WHEEL_LAG_US;
    const radps = s.reverse ? -w : w;
    let i = this.yaw.length;
    while (i > 0 && this.yaw[i - 1].tUs > tUs) i--;
    this.yaw.splice(i, 0, { tUs, radps, speedMps: s.speedMps, noGear: !!s.noGear });
  }

  /** The gyro's yaw about "up" for an IMU sample (null: the phone is being handled). */
  addGyro(tUs: number, radps: number | null): void {
    this.gyro.push({ tUs, radps });
  }

  /**
   * A wheel sample, in time order with the IMU's: the calibrator learns from the gyro around it. Without a gear, not
   * below `NO_GEAR_MIN_MPS`: it may be reversing.
   */
  learn(s: CanSpeedSample): boolean | null {
    const [, , rl, rr] = s.wheelsMps;
    const reverse = s.reverse || (!!s.noGear && s.speedMps < NO_GEAR_MIN_MPS);
    return this.calibrator.push(s.tUs, rl, rr, this.gyroAround(s.tUs - WHEEL_LAG_US), reverse);
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
   * still in the car's frame, unless the wheels around it read the car standing: then none. Null (the phone's sample
   * as it is) with no wheel sample within `CAR_FRAME_US`. Also prunes what is too old to be asked for.
   *
   * Standing, the phone's turning is never the car's: in this frame the navigator can't see the phone handled, and a
   * stop the phone doesn't keep quiet isn't held. The driver taking the phone out as the wheels went silent (ignition
   * off) turned a parked car 61°, and with the phone's turning at every stop (the rule at a crawl, 2026-10-16) 120°;
   * the next drive set off on another road, 83–109 s off the drawn one on every seed (nnz5ff, 2026-10-18).
   *
   * Without a gear, at a crawl the car may be reversing, which the unsigned wheels turn the other way: there the
   * phone's turning while its gyro reads it mounted, the wheels' only while it is handled (forwards being likelier).
   */
  substitute(s: ImuSample, bridgeUs?: number): ImuSample | null {
    this.prune(s.tUs - KEEP_US);
    let radps = this.yawAt(s.tUs, bridgeUs);
    if (radps !== null && this.crawlingNoGear(s.tUs) && !this.handledAt(s.tUs)) radps = WheelYawSource.gyroYaw(s);
    radps ??= this.standing(s.tUs) ? 0 : this.wheelsNear(s.tUs) ? WheelYawSource.gyroYaw(s) : null;
    if (radps === null) return null;
    const g = Math.hypot(s.gravity[0], s.gravity[1], s.gravity[2]) || 9.81;
    return { ...s, gyro: [0, 0, radps], gravity: [0, 0, -g], ...(this.handledAt(s.tUs) ? { handled: true as const } : {}) };
  }

  /** The phone's own gyro read handled at `tUs` (`addGyro` with null for that sample). */
  private handledAt(tUs: number): boolean {
    for (let i = this.gyro.length - 1; i >= 0 && this.gyro[i].tUs >= tUs; i--) if (this.gyro[i].tUs === tUs) return this.gyro[i].radps === null;
    return false;
  }

  /**
   * Every wheel sample within `CAR_FRAME_US` of `tUs` reads the car standing (there is one); or none does, and the
   * last before it, within `SILENT_STANDING_US`, read it standing.
   */
  private standing(tUs: number): boolean {
    let any = false;
    for (let i = this.yaw.length - 1; i >= 0; i--) {
      const d = this.yaw[i].tUs - tUs;
      if (d < -SILENT_STANDING_US) break;
      if (d > CAR_FRAME_US) continue;
      if (d < -CAR_FRAME_US) return any || this.yaw[i].speedMps === 0;
      if (this.yaw[i].speedMps !== 0) return false;
      any = true;
    }
    return any;
  }

  /** The wheel sample nearest `tUs` (within `FRESH_US`) has no gear and moves slower than `NO_GEAR_MIN_MPS`. */
  private crawlingNoGear(tUs: number): boolean {
    let near: { tUs: number; speedMps: number; noGear: boolean } | null = null;
    for (let i = this.yaw.length - 1; i >= 0; i--) {
      const y = this.yaw[i];
      if (y.tUs < tUs - FRESH_US) break;
      if (y.tUs <= tUs + FRESH_US && (!near || Math.abs(y.tUs - tUs) < Math.abs(near.tUs - tUs))) near = y;
    }
    return !!near && near.noGear && near.speedMps > 0 && near.speedMps < NO_GEAR_MIN_MPS;
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
