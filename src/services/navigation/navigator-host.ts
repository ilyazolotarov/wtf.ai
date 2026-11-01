// Where the navigator runs (NAVIGATOR-SPEC §9): `NavigatorService` drives it through a host, in-process
// (`LocalNavigatorHost`: the replay, Jest) or on the navigator's worker runtime, which runs a LocalNavigatorHost of its
// own. The host takes the inputs the service's reorder window put in time order, and the service's commands; the
// service reads the navigator through `nav`, which in-process is the navigator itself.

import type { CompassCalibration } from "@/nav/compass/compass";
import type { MapMatchConfig } from "@/nav/mapmatch/particle-filter";
import { Navigator, type FixOutcome, type NavConfig, type ParkedPose, type UserPosition } from "@/nav/navigator";
import type { CanSpeedSample } from "@/nav/odometry/can/can-speed";
import type { WheelYawCalibration } from "@/nav/odometry/can/wheel-yaw-calibration";
import { WheelYawSource } from "@/nav/odometry/can/wheel-yaw-source";
import { ImuProcessor } from "@/nav/odometry/imu/imu-processor";
import type { GnssFix, ImuSample, MagSample, ObdSpeedSample } from "@/nav/types";
import type { EngineState } from "@/obd/types";
import type { ActiveRoadGraph } from "@/services/offline-map/road-graph-file";

/** A fix delivered later than this behind the navigator is dropped (its state history spans 3 s). */
const LATE_FIX_MAX_US = 2_000_000;

/** An input to the navigator, in time order with the others. */
export type NavInput =
  | { tUs: number; imu: ImuSample }
  | { tUs: number; mag: MagSample }
  | { tUs: number; obd: ObdSpeedSample }
  | { tUs: number; wheels: CanSpeedSample }
  | { tUs: number; fix: GnssFix };

/** What the service reads of the navigator. */
export type NavView = Pick<
  Navigator,
  | "mode"
  | "estimate"
  | "trustAt"
  | "lastTrustedFixUs"
  | "distanceSinceTrustedM"
  | "params"
  | "gnssLagS"
  | "gnssLagEstimate"
  | "stats"
  | "initialization"
  | "parkedPose"
  | "restsOnStoredPose"
  | "drivePose"
  | "compassTrust"
  | "compassHeading"
  | "compassCheckDiffs"
  | "compassCalibrations"
  | "mapMatchParticles"
> & {
  /** The filter's start and update times, drained by `MapMatchTiming` (null: no filter). */
  readonly mapMatcher: { updateTimes: number[]; startTimes: number[] } | null;
};

/** A replay looking in: each navigator as it is made, each fix's outcome, the time of each input it took. */
export interface NavObserver {
  navigator?(nav: Navigator): void;
  fix?(fix: GnssFix, outcome: FixOutcome): void;
  /** The navigator took an input of this time (IMU, OBD speed or a fix). */
  fed?(tUs: number): void;
}

export interface NavigatorHost {
  /** The navigator as last known (null: none). */
  readonly nav: NavView | null;
  /** The last IMU sample the rear wheels turned (µs). */
  readonly wheelTurnsUs: number;
  /** What the wheels learned (null: wheel yaw off). */
  readonly wheelYaw: WheelYawCalibration | null;
  /** A new navigator in place of the one before. */
  create(config: Partial<NavConfig>, engine: EngineState): void;
  /** No navigator any more (the service stopped). */
  drop(): void;
  setRoadGraph(graph: ActiveRoadGraph | null, config?: Partial<MapMatchConfig>): void;
  setEngine(state: EngineState): void;
  /** The navigator's turning from the rear wheels (§5.4); on: a new wheel source, which outlives the navigator. */
  setWheelYaw(on: boolean): void;
  /** The wheels start from a stored tyre term (`seeded`: they hadn't learned yet). */
  seedWheelYaw(start: WheelYawCalibration, then: (seeded: boolean) => void): void;
  /** A wheel sample as it arrives, for the IMU around it; it comes again in `feed`, in time order, to learn from. */
  addWheels(s: CanSpeedSample): void;
  setSpeedScalePrior(ks: number, ksVar: number): void;
  setCompassCalibrations(cals: readonly CompassCalibration[]): void;
  setPosition(p: UserPosition): void;
  startFromPose(pose: ParkedPose, then: (started: boolean) => void): void;
  answerPose(here: boolean, then: (answered: boolean) => void): void;
  /**
   * Inputs in time order: `fix` for each fix the navigator took (`i`, its index in `inputs`; `trusted`: integrity
   * passed it and trusts GNSS at its time), then `done`.
   */
  feed(inputs: readonly NavInput[], fix: (i: number, out: FixOutcome, trusted: boolean) => void, done: () => void): void;
}

/** The navigator in this runtime: each call done when it returns. */
export class LocalNavigatorHost implements NavigatorHost {
  private navigator: Navigator | null = null;
  /** The navigator's turning from the wheels (§5.4): the source, while on. */
  private wheels: WheelYawSource | null = null;
  /** The gyro as the navigator would read it, for the wheels to learn from. */
  private readonly gyroProc = new ImuProcessor();
  /** Time of the last input fed to the navigator. */
  private fedUs = -Infinity;
  private turnsUs = -Infinity;

  /** `longTasks`: the navigator's work is labelled on the thread it blocks (src/services/long-tasks.ts). */
  constructor(private readonly o: { observer?: NavObserver; longTasks?: { label<T>(name: string, fn: () => T): T } } = {}) {}

  get nav(): Navigator | null {
    return this.navigator;
  }

  get wheelTurnsUs(): number {
    return this.turnsUs;
  }

  get wheelYaw(): WheelYawCalibration | null {
    return this.wheels?.calibration ?? null;
  }

  create(config: Partial<NavConfig>, engine: EngineState): void {
    const nav = new Navigator(config);
    nav.setWheelYaw(this.wheels !== null);
    nav.setEngine(engine);
    this.navigator = nav;
    this.fedUs = -Infinity;
    this.o.observer?.navigator?.(nav);
  }

  drop(): void {
    this.navigator = null;
  }

  setRoadGraph(graph: ActiveRoadGraph | null, config?: Partial<MapMatchConfig>): void {
    this.navigator?.setRoadGraph(graph?.graph ?? null, config);
  }

  setEngine(state: EngineState): void {
    this.navigator?.setEngine(state);
  }

  setWheelYaw(on: boolean): void {
    this.wheels = on ? new WheelYawSource() : null;
    this.navigator?.setWheelYaw(on);
  }

  seedWheelYaw(start: WheelYawCalibration, then: (seeded: boolean) => void): void {
    then(this.wheels?.seed(start) ?? false);
  }

  addWheels(s: CanSpeedSample): void {
    this.wheels?.addWheels(s);
  }

  setSpeedScalePrior(ks: number, ksVar: number): void {
    this.navigator?.setSpeedScalePrior(ks, ksVar);
  }

  setCompassCalibrations(cals: readonly CompassCalibration[]): void {
    this.navigator?.setCompassCalibrations(cals);
  }

  setPosition(p: UserPosition): void {
    this.navigator?.setPosition(p);
  }

  startFromPose(pose: ParkedPose, then: (started: boolean) => void): void {
    then(this.navigator?.startFromPose(pose) ?? false);
  }

  answerPose(here: boolean, then: (answered: boolean) => void): void {
    then(this.navigator?.answerPose(here) ?? false);
  }

  feed(inputs: readonly NavInput[], fix: (i: number, out: FixOutcome, trusted: boolean) => void, done: () => void): void {
    const nav = this.navigator;
    if (nav) {
      const tasks = this.o.longTasks;
      if (tasks) tasks.label("mm update", () => this.run(nav, inputs, fix));
      else this.run(nav, inputs, fix);
    }
    done();
  }

  private run(nav: Navigator, inputs: readonly NavInput[], fix: (i: number, out: FixOutcome, trusted: boolean) => void): void {
    const observer = this.o.observer;
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const late = input.tUs < this.fedUs;
      if ("fix" in input) {
        // A fix delivered late can still update from the navigator's state history.
        if (late && this.fedUs - input.tUs > LATE_FIX_MAX_US) continue;
        const out = nav.onGnss(input.fix);
        observer?.fix?.(input.fix, out);
        fix(i, out, out.integrity === "ok" && nav.trustAt(input.tUs) === "TRUSTED");
      } else if (late) {
        continue;
      } else if ("wheels" in input) {
        // In time order with the IMU's: the gyro around it is in.
        this.wheels?.learn(input.wheels);
        continue;
      } else if ("imu" in input) {
        const w = this.wheels;
        if (w) {
          const o = this.gyroProc.process(input.imu);
          w.addGyro(input.tUs, o.valid ? o.yawRate : null);
          const car = w.substitute(input.imu);
          if (car) this.turnsUs = input.tUs;
          nav.onImu(car ?? input.imu);
        } else nav.onImu(input.imu);
      } else if ("mag" in input) {
        // The compass reads the phone's field against the IMU's "up": with the car's IMU in its place (wheel yaw) it
        // would learn a mounting from the field turned with the phone, and keep it. Off meanwhile.
        if (!this.wheels) nav.onMag(input.mag);
      } else {
        nav.onObdSpeed(input.obd);
      }
      this.fedUs = Math.max(this.fedUs, input.tUs);
      if (!("mag" in input)) observer?.fed?.(input.tUs);
    }
  }
}
