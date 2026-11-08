// The navigator on another runtime (NAVIGATOR-SPEC §9): the messages between the service's WorkerNavigatorHost and
// the worker's NavigatorRemote, which runs a LocalNavigatorHost there, and the snapshot each answer carries: what the
// service reads of the navigator, as it was after that step. Plain data both ways, copied between the runtimes.

import type { Coordinate } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import type { ByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import type { MapMatchConfig } from "@/nav/mapmatch/particle-filter";
import type { FixOutcome, NavConfig, NavEstimate, Navigator, NavMode, ParkedPose, UserPosition } from "@/nav/navigator";
import type { CanSpeedSample } from "@/nav/odometry/can/can-speed";
import type { WheelYawCalibration } from "@/nav/odometry/can/wheel-yaw-calibration";
import type { TrustState } from "@/nav/position/types";
import type { EngineState } from "@/obd/types";

import { LocalNavigatorHost, type NavInput } from "./navigator-host";

/** The road graph file, for a runtime that opens it for itself; `centre`: the frame it starts in (the region's). */
export interface GraphFile {
  key: string;
  path: string;
  centre: Coordinate;
}

/** Random access reads of files by path (modules/graph-bytes on a device). */
export interface FileBytes {
  open(path: string): number;
  size(handle: number): number;
  read(handle: number, offset: number, length: number): ArrayBuffer;
  close(handle: number): void;
}

/** Requests with an `id` are answered, in order. */
export type ToRemote =
  | { kind: "create"; navId: number; config: Partial<NavConfig>; engine: EngineState }
  | { kind: "drop" }
  | { kind: "roadGraph"; graph: GraphFile | null; config?: Partial<MapMatchConfig> }
  | { kind: "engine"; state: EngineState }
  | { kind: "wheelYaw"; on: boolean; exact?: boolean }
  | { kind: "wheels"; sample: CanSpeedSample }
  | { kind: "speedScalePrior"; ks: number; ksVar: number }
  | { kind: "position"; position: UserPosition }
  | { kind: "seedWheelYaw"; id: number; start: WheelYawCalibration }
  | { kind: "startFromPose"; id: number; pose: ParkedPose }
  | { kind: "answerPose"; id: number; here: boolean }
  | { kind: "feed"; id: number; inputs: NavInput[]; particles: boolean };

export interface FromRemote {
  /** The request answered (0: none, an error outside one). */
  id: number;
  /** The navigator the snapshot is of. */
  navId: number;
  answer?: boolean;
  /** Each fix fed: its index in the inputs, its outcome, and whether integrity passed it with GNSS trusted. */
  fixes?: [number, FixOutcome, boolean][];
  /** Null: no navigator. */
  snapshot: NavSnapshot | null;
  /** The wheels, which outlive the navigator: the last IMU sample they turned, what they learned (null: off). */
  wheels: { turnsUs: number; calibration: WheelYawCalibration | null };
  /** Filter starts and updates since the last answer, ms (any navigator's). */
  startTimes: number[];
  updateTimes: number[];
  error?: string;
}

/** What the service reads of the navigator (NavView), after a step. */
export interface NavSnapshot {
  mode: NavMode;
  estimate: NavEstimate | null;
  /** Integrity's trust at the last input fed. */
  trust: TrustState;
  lastTrustedFixUs: number | undefined;
  distanceSinceTrustedM: number | undefined;
  params: Navigator["params"];
  gnssLagS: number;
  gnssLagEstimate: Navigator["gnssLagEstimate"];
  stats: Navigator["stats"];
  initialization: Navigator["initialization"];
  parkedPose: ParkedPose | null;
  restsOnStoredPose: boolean;
  drivePose: Navigator["drivePose"];
  /** [lat, lon, weight, off-road 1/0], heaviest first: when asked. */
  particles?: [number, number, number, number][];
}

/** Particles a snapshot carries when the debug overlay asks (it draws 200). */
const SNAPSHOT_PARTICLES = 200;

/** The navigator's state as plain data. */
export function snapshotOf(nav: Navigator, trustAtUs: number, particles: boolean): NavSnapshot {
  return {
    mode: nav.mode,
    estimate: nav.estimate(),
    trust: nav.trustAt(trustAtUs),
    lastTrustedFixUs: nav.lastTrustedFixUs,
    distanceSinceTrustedM: nav.distanceSinceTrustedM,
    params: nav.params,
    gnssLagS: nav.gnssLagS,
    gnssLagEstimate: nav.gnssLagEstimate,
    stats: { ...nav.stats },
    initialization: nav.initialization,
    parkedPose: nav.parkedPose,
    restsOnStoredPose: nav.restsOnStoredPose,
    drivePose: nav.drivePose,
    ...(particles ? { particles: nav.mapMatchParticles(SNAPSHOT_PARTICLES) } : {}),
  };
}

/** A graph file read through `bytes`. */
export function fileByteSource(bytes: FileBytes, path: string): ByteSource & { close(): void } {
  const handle = bytes.open(path);
  return {
    size: bytes.size(handle),
    read(offset, length) {
      const got = new Uint8Array(bytes.read(handle, offset, length));
      if (got.byteLength !== length) throw new Error(`short read at ${offset}: ${got.byteLength} of ${length}`);
      return got;
    },
    close: () => bytes.close(handle),
  };
}

/**
 * The worker's protocol in this runtime, each message copied as between runtimes and handled in order after the one
 * before (Jest, and the replay that checks the protocol).
 */
export function inProcessLink(bytes: FileBytes): { post(m: ToRemote): void; onReply(listener: (m: FromRemote) => void): void } {
  const listeners: ((m: FromRemote) => void)[] = [];
  const remote = new NavigatorRemote({ bytes, reply: (m) => listeners.forEach((l) => l(structuredClone(m))) });
  const queue: ToRemote[] = [];
  let busy = false;
  return {
    post(m) {
      queue.push(structuredClone(m));
      if (busy) return;
      busy = true;
      while (queue.length) remote.receive(queue.shift()!);
      busy = false;
    },
    onReply: (listener) => listeners.push(listener),
  };
}

/** The navigator's side of the link: runs each request on a LocalNavigatorHost and answers. */
export class NavigatorRemote {
  private readonly host = new LocalNavigatorHost();
  private navId = 0;
  /** The latest input fed: trust is read at it. */
  private fedUs = -Infinity;
  private graph: { file: GraphFile; graph: TiledRoadGraph; close(): void } | null = null;
  /** Filter times from a filter replaced since the last answer. */
  private times = { startTimes: [] as number[], updateTimes: [] as number[] };

  constructor(private readonly o: { bytes: FileBytes; reply(m: FromRemote): void }) {}

  receive(m: ToRemote): void {
    try {
      this.handle(m);
    } catch (e) {
      this.answer("id" in m ? m.id : 0, { error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) }, false);
    }
  }

  private handle(m: ToRemote): void {
    const host = this.host;
    switch (m.kind) {
      case "create":
        this.drainTimes();
        this.navId = m.navId;
        host.create(m.config, m.engine);
        return;
      case "drop":
        host.drop();
        return;
      case "roadGraph":
        this.setRoadGraph(m.graph, m.config);
        return;
      case "engine":
        host.setEngine(m.state);
        return;
      case "wheelYaw":
        host.setWheelYaw(m.on, m.exact);
        return;
      case "wheels":
        host.addWheels(m.sample);
        return;
      case "speedScalePrior":
        host.setSpeedScalePrior(m.ks, m.ksVar);
        return;
      case "position":
        host.setPosition(m.position);
        return;
      case "seedWheelYaw":
        host.seedWheelYaw(m.start, (answer) => this.answer(m.id, { answer }, false));
        return;
      case "startFromPose":
        host.startFromPose(m.pose, (answer) => this.answer(m.id, { answer }, false));
        return;
      case "answerPose":
        host.answerPose(m.here, (answer) => this.answer(m.id, { answer }, false));
        return;
      case "feed": {
        const fixes: [number, FixOutcome, boolean][] = [];
        for (const input of m.inputs) this.fedUs = Math.max(this.fedUs, input.tUs);
        host.feed(
          m.inputs,
          (i, out, trusted) => fixes.push([i, out, trusted]),
          () => this.answer(m.id, { fixes }, m.particles),
        );
      }
    }
  }

  /** The navigator's graph: the file open already is kept (and its tiles), another one opened in its place. */
  private setRoadGraph(file: GraphFile | null, config?: Partial<MapMatchConfig>): void {
    if (this.graph && this.graph.file.key !== file?.key) {
      this.graph.close();
      this.graph = null;
    }
    if (file && !this.graph) {
      const source = fileByteSource(this.o.bytes, file.path);
      try {
        this.graph = { file, graph: new TiledRoadGraph(source, new LocalFrame(file.centre)), close: source.close };
      } catch (e) {
        source.close();
        throw e;
      }
    }
    this.drainTimes();
    this.host.setRoadGraph(this.graph, config);
  }

  /** The filter's times so far, before it is replaced. */
  private drainTimes(): void {
    const pf = this.host.nav?.mapMatcher;
    if (!pf) return;
    this.times.startTimes.push(...pf.startTimes.splice(0));
    this.times.updateTimes.push(...pf.updateTimes.splice(0));
  }

  private answer(id: number, extra: Pick<FromRemote, "answer" | "fixes" | "error">, particles: boolean): void {
    const nav = this.host.nav;
    const snapshot = nav ? snapshotOf(nav, this.fedUs, particles) : null;
    this.drainTimes();
    const times = this.times;
    this.times = { startTimes: [], updateTimes: [] };
    const calibration = this.host.wheelYaw;
    this.o.reply({
      id,
      navId: this.navId,
      ...extra,
      snapshot,
      wheels: { turnsUs: this.host.wheelTurnsUs, calibration: calibration && { ...calibration } },
      ...times,
    });
  }
}
