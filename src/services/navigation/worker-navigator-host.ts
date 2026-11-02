// The navigator on its worker runtime (NAVIGATOR-SPEC §9), as the service sees it: requests go over the link to the
// worker's NavigatorRemote, and the service reads the snapshot that came with the latest answer. The work after a
// feed (each fix's bookkeeping, the publish) runs when its answer arrives.

import type { MapMatchConfig } from "@/nav/mapmatch/particle-filter";
import { Navigator, type FixOutcome, type NavConfig, type ParkedPose, type UserPosition } from "@/nav/navigator";
import type { CanSpeedSample } from "@/nav/odometry/can/can-speed";
import type { WheelYawCalibration } from "@/nav/odometry/can/wheel-yaw-calibration";
import type { EngineState } from "@/obd/types";
import type { ActiveRoadGraph } from "@/services/offline-map/road-graph-file";

import type { NavigatorHost, NavInput, NavView } from "./navigator-host";
import { snapshotOf, type FromRemote, type NavSnapshot, type ToRemote } from "./navigator-remote";

/** The way to the worker; answers come back in the order of the requests. */
export interface RemoteLink {
  post(m: ToRemote): void;
  onReply(listener: (m: FromRemote) => void): void;
}

/** The debug overlay asked for particles this recently: answers carry them. */
const PARTICLES_WANTED_MS = 2_000;

/** The navigator as its latest snapshot shows it. */
class SnapshotView implements NavView {
  constructor(
    private s: NavSnapshot,
    readonly mapMatcher: { updateTimes: number[]; startTimes: number[] },
    private readonly wantParticles: () => void,
  ) {
    this.update(s);
  }

  update(s: NavSnapshot): void {
    this.s = s;
  }

  get mode() {
    return this.s.mode;
  }
  estimate() {
    return this.s.estimate;
  }
  /** Trust at the last input fed, whatever the time asked: the worker reads it as it steps. */
  trustAt() {
    return this.s.trust;
  }
  get lastTrustedFixUs() {
    return this.s.lastTrustedFixUs;
  }
  get distanceSinceTrustedM() {
    return this.s.distanceSinceTrustedM;
  }
  get params() {
    return this.s.params;
  }
  get gnssLagS() {
    return this.s.gnssLagS;
  }
  get gnssLagEstimate() {
    return this.s.gnssLagEstimate;
  }
  get stats() {
    return this.s.stats;
  }
  get initialization() {
    return this.s.initialization;
  }
  get parkedPose() {
    return this.s.parkedPose;
  }
  get restsOnStoredPose() {
    return this.s.restsOnStoredPose;
  }
  get drivePose() {
    return this.s.drivePose;
  }
  /** The particles the latest answer carried; asking makes the next answers carry them. */
  mapMatchParticles(max: number): [number, number, number, number][] {
    this.wantParticles();
    return (this.s.particles ?? []).slice(0, max);
  }
}

export class WorkerNavigatorHost implements NavigatorHost {
  private view: SnapshotView | null = null;
  /** The navigator the service talks to: answers about an earlier one are dropped. */
  private navId = 0;
  private nextId = 1;
  private readonly waiting = new Map<number, (m: FromRemote) => void>();
  private wheels: FromRemote["wheels"] = { turnsUs: -Infinity, calibration: null };
  private wheelYawOn = false;
  /** Filter times from every answer, drained by the service's MapMatchTiming. */
  private readonly times = { updateTimes: [] as number[], startTimes: [] as number[] };
  private particlesUntilMs = -Infinity;

  constructor(
    private readonly link: RemoteLink,
    private readonly o: { nowMs(): number; error(text: string): void },
  ) {
    link.onReply((m) => this.reply(m));
  }

  get nav(): NavView | null {
    return this.view;
  }

  get wheelTurnsUs(): number {
    return this.wheels.turnsUs;
  }

  get wheelYaw(): WheelYawCalibration | null {
    return this.wheels.calibration;
  }

  create(config: Partial<NavConfig>, engine: EngineState): void {
    this.navId++;
    this.link.post({ kind: "create", navId: this.navId, config, engine });
    // Until the first answer: the navigator as the worker's starts, before any input.
    const fresh = new Navigator(config);
    fresh.setWheelYaw(this.wheelYawOn);
    fresh.setEngine(engine);
    this.view = new SnapshotView(snapshotOf(fresh, -Infinity, false), this.times, () => {
      this.particlesUntilMs = this.o.nowMs() + PARTICLES_WANTED_MS;
    });
  }

  drop(): void {
    this.navId++;
    this.link.post({ kind: "drop" });
    this.view = null;
  }

  setRoadGraph(graph: ActiveRoadGraph | null, config?: Partial<MapMatchConfig>): void {
    if (graph && !graph.file) {
      this.o.error(`nav worker: the road graph ${graph.key} has no file to open`);
      return;
    }
    this.link.post({ kind: "roadGraph", graph: graph && { key: graph.key, ...graph.file! }, config });
  }

  setEngine(state: EngineState): void {
    this.link.post({ kind: "engine", state });
  }

  setWheelYaw(on: boolean): void {
    this.wheelYawOn = on;
    this.link.post({ kind: "wheelYaw", on });
  }

  seedWheelYaw(start: WheelYawCalibration, then: (seeded: boolean) => void): void {
    this.request((id) => ({ kind: "seedWheelYaw", id, start }), (m) => then(!!m.answer));
  }

  addWheels(sample: CanSpeedSample): void {
    this.link.post({ kind: "wheels", sample });
  }

  setSpeedScalePrior(ks: number, ksVar: number): void {
    this.link.post({ kind: "speedScalePrior", ks, ksVar });
  }

  setPosition(position: UserPosition): void {
    this.link.post({ kind: "position", position });
  }

  startFromPose(pose: ParkedPose, then: (started: boolean) => void): void {
    const navId = this.navId;
    this.request((id) => ({ kind: "startFromPose", id, pose }), (m) => then(m.navId === navId && !!m.answer));
  }

  answerPose(here: boolean, then: (answered: boolean) => void): void {
    const navId = this.navId;
    this.request((id) => ({ kind: "answerPose", id, here }), (m) => then(m.navId === navId && !!m.answer));
  }

  feed(inputs: readonly NavInput[], fix: (i: number, out: FixOutcome, trusted: boolean) => void, done: () => void): void {
    const navId = this.navId;
    // A fix goes without the record the service keeps of it.
    const sent = inputs.map((x) => ("fix" in x ? { tUs: x.tUs, fix: x.fix } : x));
    const particles = this.o.nowMs() < this.particlesUntilMs;
    this.request(
      (id) => ({ kind: "feed", id, inputs: sent, particles }),
      (m) => {
        // Fed to a navigator replaced since: what it made of the fixes is about that one.
        if (m.navId === navId) for (const [i, out, trusted] of m.fixes ?? []) fix(i, out, trusted);
        done();
      },
    );
  }

  private request(make: (id: number) => ToRemote, then: (m: FromRemote) => void): void {
    const id = this.nextId++;
    this.waiting.set(id, then);
    this.link.post(make(id));
  }

  private reply(m: FromRemote): void {
    if (m.error) this.o.error(`nav worker: ${m.error}`);
    this.wheels = m.wheels;
    this.times.startTimes.push(...m.startTimes);
    this.times.updateTimes.push(...m.updateTimes);
    if (m.navId === this.navId && m.snapshot) this.view?.update(m.snapshot);
    const then = this.waiting.get(m.id);
    if (!then) return;
    this.waiting.delete(m.id);
    then(m);
  }
}
