// VehicleLink orchestrator (docs/VEHICLE-LINK-SPEC.md §6.2, §7, §8, §9, §11).
// Pure TS: transports, discovery, and storage are injected, so the whole lifecycle
// runs in Node tests against the emulator.

import { CanMonitorCollector, formatSurvey, sliceFilter, type CanFrame, type CanSurvey, type IdSlice } from "./can-monitor";
import { CanShadow, type CanShadowStatus, type CanWindow } from "./can-shadow";
import { compareDevices, rankDevice } from "./catalog";
import type { Clock } from "./clock";
import { probeAdapter, searchProtocols, warmReset, wrongBus } from "./elm327/probe";
import { initVehicle, readVin } from "./elm327/init";
import { parseMode01 } from "./elm327/parser";
import { Elm327Session, Priority, SessionClosedError } from "./elm327/session";
import { Emitter } from "./emitter";
import { EngineStateMachine } from "./engine-state";
import { ObdPoller, interpretPoll, type PollerConfig } from "./poller";
import type {
  AdapterInfo,
  CanOff,
  ConnectedInfo,
  DiscoveredDevice,
  ElmResponse,
  EngineState,
  ExchangeEvent,
  LinkError,
  LinkEvent,
  RpmSample,
  SendFn,
  SpeedSample,
  Transport,
  TransportKind,
  VehicleInfo,
  VehicleLink,
  VehicleLinkSnapshot,
} from "./types";
import { UNKNOWN_CAR } from "./types";

export interface ScannedDevice {
  id: string;
  transport: TransportKind;
  name: string | null;
  rssi?: number;
  serviceUuids?: string[];
  lastSeenUs: number;
}

export interface DiscoveryBackend {
  /** `onStopped`: the backend ended the scan by itself (its time limit). */
  start(onUpdate: (devices: ScannedDevice[]) => void, onStopped?: () => void): void;
  stop(): void;
  pairMfi?(): Promise<void>;
  /** Ids of the MFi adapters iOS has connected right now (no scan, no prompt). */
  mfiPresent?(): string[];
}

export interface RememberedAdapter {
  id: string;
  transport: TransportKind;
  name: string | null;
  gatt?: ConnectedInfo["gatt"];
  adapter?: Omit<AdapterInfo, "connected">;
  protocolNumber?: number | null;
  /** Before the car list (`vehicleLink.cars`): the VIN this adapter last read, cleared by a missed read. */
  vin?: string | null;
  speedHz?: number;
  lastVerifiedAt: number;
}

export interface KeyValueStore {
  getJson<T>(key: string): T | null;
  setJson(key: string, value: unknown): void;
}

export interface VehicleLinkDeps {
  clock: Clock;
  createTransport(device: { id: string; transport: TransportKind; name: string | null }, remembered?: RememberedAdapter): Transport;
  discovery: DiscoveryBackend;
  store: KeyValueStore;
  pollerConfig?: Partial<PollerConfig>;
  /** Wall-clock ms for `lastVerifiedAt`. */
  nowMs?: () => number;
  /** Standby probe period while the ECU is silent (§10.3). */
  standbyProbeMs?: number;
}

const ADAPTERS_KEY = "vehicleLink.adapters";
/**
 * Adapters whose CAN monitor froze them while the car moved, with the firmware it happened on (§16.2). (Two earlier
 * keys are not read: the first held a car switched off taken for a freeze; the second, `canShadowFrozeOn`, held
 * silences while standing, which were the link dropping near home, not the adapter: 2026-10-30.)
 */
const SHADOW_FROZE_KEY = "vehicleLink.canShadowFrozeDriving";
const CARS_KEY = "vehicleLink.cars";
const STATS_INTERVAL_US = 250_000;

/** A car seen by any adapter; the list is most recent first (§9.1). */
export interface KnownCar {
  /** Null: its VIN was never read. */
  vin: string | null;
  protocolNumber: number | null;
  seenAt: number;
}

/** Ends a `probe-failed` event's detail when the probe was a reconnect's, which is retried. */
export const RECONNECTING = ", reconnecting";

const MAX_CARS = 8;
/** While the VIN isn't read: ask again after each of these waits (and once the engine runs) (§9.1). */
const VIN_RETRY_MS = [5_000, 10_000, 15_000, 30_000, 60_000, 120_000];
/** Standby on a cached protocol whose bus isn't there: search all protocols on every this many checks (§10.3). */
const SEARCH_EVERY = 4;
/** Auto-connect with several adapters remembered: each gets this long to become reachable, most recent first (§7). */
export const AUTO_CONNECT_WINDOW_MS = 8_000;
/**
 * OBD speed polls per second (§10.2). In replay, navigation at 2 Hz was no worse than at the 25–30 Hz back-to-back
 * polls, and its claimed accuracy more honest; the CAN shadow listens in between (a break costs ~160 ms on the MX+).
 */
export const OBD_SPEED_HZ = 2;
/** The shadow's counts in the snapshot at most this often (its state changes go at once). */
const CAN_STATUS_INTERVAL_US = 1_000_000;
/**
 * CAN primary (§16.3): OBD speed is passed on only when the last CAN speed is older than this (the replay's rule,
 * `withCanSpeed`).
 */
const CAN_FRESH_US = 300_000;
/** The polls wait while the last CAN speed is this fresh and at least `CAN_MOVING_KPH`: the car moves. */
const CAN_PAUSE_FRESH_US = 500_000;
/**
 * The snapshot says the wheels carry the speed (`speedFromCan`) while the last CAN speed is this fresh: standing, the
 * polls' OBD 0 comes between the monitor's windows, and the Car page flipped between the two with every sample.
 */
const CAN_CARRIES_US = 3_000_000;
const CAN_MOVING_KPH = 1;
/**
 * An OBD speed of a moving car without a fresh CAN speed: the polls wait this long once, so the monitor gets a window
 * that can bring one. On a slow link (polls answered in 60–240 ms, stops in 120–290 ms, 2026-10-15) the 2 Hz polls
 * left it 0–70 ms, too short for a fresh CAN speed, so the polls never paused: 50 s of driving through three turns
 * without the wheels. No CAN speed in it (a monitor gone deaf): the polls run at their rate, and the next such window
 * comes after `CAN_LISTEN_RETRY_US`.
 */
const CAN_LISTEN_WINDOW_US = 1_200_000;
const CAN_LISTEN_RETRY_US = 10_000_000;
/** An OBD speed this recent tells the car moves. */
const OBD_MOVING_FRESH_US = 1_000_000;

type OpenOutcome = "connected" | "unreachable" | "stopped";
type InitOutcome = "polling" | "no-vehicle" | "error";

class Cancelled extends Error {}

export class VehicleLinkCore implements VehicleLink {
  private snapshot: VehicleLinkSnapshot = {
    link: "idle",
    error: null,
    devices: [],
    discovering: false,
    activeDeviceId: null,
    adapter: null,
    vehicle: null,
    protocolSearch: false,
    tryingSinceMs: null,
    engine: "unknown",
    lastSpeed: null,
    lastRpm: null,
    stats: null,
  };
  private listeners = new Set<() => void>();
  private speed = new Emitter<[SpeedSample]>();
  private rpm = new Emitter<[RpmSample]>();
  private engineEvents = new Emitter<[EngineState, number]>();
  private exchanges = new Emitter<[ExchangeEvent]>();
  private linkEvents = new Emitter<[LinkEvent]>();

  private scanned = new Map<string, ScannedDevice>();
  /** Bumped by every scan start and stop: a backend's "stopped" belongs to the scan it started. */
  private discoveryRun = 0;
  private gen = 0;
  /** The `gen` a reconnect loop runs for (§6.2): a second link loss meanwhile doesn't start another. */
  private reconnecting: number | null = null;
  private transport: Transport | null = null;
  private session: Elm327Session | null = null;
  private poller: ObdPoller | null = null;
  private engine: EngineStateMachine;
  private unsubscribers: (() => void)[] = [];
  private lastStatsUs = 0;
  private reiniting = false;
  /** The CAN monitor went silent while standing: a freeze, or the car switched off (§16.2). */
  private rpmPeriods: Partial<PollerConfig> = {};
  /** Bumped by every init: a VIN retry belongs to the init that started it. */
  private initSeq = 0;
  /** Bumped by a user's connect/disconnect and by each auto-connect round: an older round stops. */
  private autoRun = 0;
  private roundRun: number | null = null;
  /** The ECU init pinned for speed (`ATCRA`), restored after a CAN monitor. */
  private pinnedEcu: number | null = null;
  /** While the CAN monitor runs, the adapter's output goes here instead of the link events. */
  private monitorSink: ((text: string, rxUs: number) => void) | null = null;
  /** Ids the CAN monitor listens to (picked for the car, §16.4); null: off. */
  private canShadowIds: number[] | null = null;
  /** False while the car's profile is on probation (§16.5): CAN speed doesn't carry the navigation. */
  private canTrusted = true;
  private shadow: CanShadow | null = null;
  /** A replaced shadow still listening: its output is its own until the next command stops it. */
  private retiredShadow: CanShadow | null = null;
  private lastCanStatusUs = 0;
  private canFrames = new Emitter<[CanFrame[]]>();
  private canWindows = new Emitter<[CanWindow]>();
  private canBufferFull = new Emitter<[CanWindow]>();
  private lastCanSpeed: { tUs: number; raw: number } | null = null;
  /** The last OBD speed (arrival), for CAN primary's pause. */
  private lastObdSpeed: { rxUs: number; raw: number } | null = null;
  /** CAN primary: the long window given to the monitor (until), and when the last one brought no CAN speed. */
  private listenUntilUs: number | null = null;
  private listenFailedUs = -Infinity;

  constructor(private readonly deps: VehicleLinkDeps) {
    this.engine = new EngineStateMachine((state, tUs) => this.onEngineChange(state, tUs));
    this.refreshDevices();
  }

  // ---- VehicleLink: state ----

  getSnapshot = (): VehicleLinkSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  onSpeed = (l: (s: SpeedSample) => void) => this.speed.on(l);
  onRpm = (l: (s: RpmSample) => void) => this.rpm.on(l);
  onEngineState = (l: (e: EngineState, tUs: number) => void) => this.engineEvents.on(l);
  onExchange = (l: (e: ExchangeEvent) => void) => this.exchanges.on(l);
  onLinkEvent = (l: (e: LinkEvent) => void) => this.linkEvents.on(l);
  /** CAN shadow frames, in arrival batches (§16.2). */
  onCanFrames = (l: (frames: CanFrame[]) => void) => this.canFrames.on(l);
  /** Each CAN shadow listening window, when it closes. */
  onCanWindow = (l: (w: CanWindow) => void) => this.canWindows.on(l);
  /** A CAN shadow window ended with BUFFER FULL: its ids send more than the link carries (§16.3). */
  onCanBufferFull = (l: (w: CanWindow) => void) => this.canBufferFull.on(l);

  // ---- VehicleLink: discovery ----

  startDiscovery(): void {
    if (this.snapshot.discovering) return;
    this.update({ discovering: true });
    const run = ++this.discoveryRun;
    this.deps.discovery.start(
      (devices) => {
        for (const d of devices) this.scanned.set(d.id, d);
        this.refreshDevices();
      },
      () => {
        // The scan this call started ran out; a later one is its own.
        if (run === this.discoveryRun && this.snapshot.discovering) this.update({ discovering: false });
      },
    );
  }

  stopDiscovery(): void {
    if (!this.snapshot.discovering) return;
    this.discoveryRun++;
    this.deps.discovery.stop();
    this.update({ discovering: false });
  }

  async pairMfi(): Promise<void> {
    await this.deps.discovery.pairMfi?.();
  }

  forget(deviceId: string): void {
    this.saveRemembered(this.remembered().filter((a) => a.id !== deviceId));
    if (this.snapshot.activeDeviceId === deviceId) void this.disconnect();
    this.refreshDevices();
  }

  /**
   * Connect to a remembered adapter, if any (§7 auto-connect). The connect waits for the adapter
   * to become reachable: an MFi adapter joins iOS only a few seconds after the car wakes it, often
   * after the app is opened. A failed attempt is retried. With one adapter remembered it waits for
   * it; with several, the most recently verified goes first and each gets `AUTO_CONNECT_WINDOW_MS`,
   * round after round, until one is reachable. Adapters on a `skip` transport are left for the driver to connect.
   */
  async autoConnect(skip: readonly TransportKind[] = []): Promise<boolean> {
    if (this.roundRun === this.autoRun) return true;
    if (this.snapshot.activeDeviceId && this.snapshot.link !== "error") return true;
    const list = this.remembered()
      .filter((a) => !skip.includes(a.transport))
      .sort((a, b) => b.lastVerifiedAt - a.lastVerifiedAt);
    if (list.length === 0) return false;
    if (list.length === 1) await this.connect(list[0].id, { wait: true });
    else {
      this.update({ tryingSinceMs: (this.deps.nowMs ?? Date.now)() });
      await this.inTurn(list);
    }
    return true;
  }

  /** The car's VIN: the connected one (null: a car not known on its protocol), else the last car seen. */
  expectedVin(): string | null {
    const vehicle = this.snapshot.vehicle;
    return vehicle ? vehicle.vin : (this.cars()[0]?.vin ?? null);
  }

  /** The key what is kept per car is stored under: `expectedVin`, `UNKNOWN_CAR` for a car without one; null: no car. */
  expectedCar(): string | null {
    const vehicle = this.snapshot.vehicle;
    const last = this.cars()[0];
    if (!vehicle && !last) return null;
    return this.expectedVin() ?? UNKNOWN_CAR;
  }

  // ---- VehicleLink: connection ----

  async connect(deviceId: string, options?: { wait?: boolean }): Promise<void> {
    this.autoRun++;
    // A new attempt (the user's Connect, auto-connect starting over): its own time to get ready.
    this.update({ tryingSinceMs: (this.deps.nowMs ?? Date.now)() });
    await this.open(deviceId, options);
  }

  async disconnect(): Promise<void> {
    this.autoRun++;
    const emulated = this.transport?.kind === "emulator";
    await this.close();
    this.update({ tryingSinceMs: null });
    // A simulated car is gone with its adapter: it stands. A real adapter's silence keeps the last speed (the
    // navigator's link-loss rules), but an emulator switched off mid-drive would otherwise drive on at its last speed.
    if (emulated) {
      const t = this.deps.clock.nowUs();
      const stop: SpeedSample = { txUs: t, rxUs: t, tUs: t, speedMps: 0, raw: 0 };
      this.speed.emit(stop);
      this.update({ lastSpeed: stop, speedFromCan: false });
    }
  }

  /** `windowMs`: give up (and return "unreachable") if the transport doesn't connect within it. */
  private async open(deviceId: string, options?: { wait?: boolean; windowMs?: number }): Promise<OpenOutcome> {
    await this.close();
    const gen = ++this.gen;
    const remembered = this.remembered().find((a) => a.id === deviceId);
    const scanned = this.scanned.get(deviceId);
    const device = scanned ?? remembered;
    if (!device) {
      this.update({ link: "error", error: { code: "device-not-found" } });
      return "stopped";
    }
    this.update({
      link: "connecting",
      error: null,
      activeDeviceId: deviceId,
      adapter: null,
      vehicle: null,
      lastSpeed: null,
      speedFromCan: false,
      lastRpm: null,
      stats: null,
      canOff: null,
    });
    this.event("connect", device.name ?? deviceId);
    const transport = this.deps.createTransport(
      { id: device.id, transport: device.transport, name: device.name },
      remembered,
    );
    this.transport = transport;
    this.unsubscribers.push(transport.onLinkLost((reason) => this.onLinkLost(gen, reason)));
    this.unsubscribers.push(
      transport.onUnsolicited((text, rxUs) => {
        if (this.monitorSink) this.monitorSink(text, rxUs);
        else if (this.shadow?.running) this.shadow.onText(text, rxUs);
        else if (this.retiredShadow?.running) this.retiredShadow.onText(text, rxUs);
        else this.linkEvents.emit({ type: "unsolicited", tUs: rxUs, detail: text });
      }),
    );
    let info: ConnectedInfo | null;
    try {
      const connecting = transport.connect({ wait: options?.wait });
      if (options?.windowMs === undefined) {
        info = await connecting;
      } else {
        connecting.catch(() => undefined); // rejected as cancelled when the window closes first
        info = await Promise.race([connecting, this.deps.clock.sleep(options.windowMs).then(() => null)]);
      }
    } catch (error) {
      if (options?.windowMs === undefined || gen !== this.gen) {
        this.handleFailure(gen, error);
        return "stopped";
      }
      info = null; // e.g. unknown to iOS right now: the next adapter's turn
    }
    if (gen !== this.gen) return "stopped";
    if (info === null) {
      await this.close();
      return "unreachable";
    }
    try {
      await this.runSession(gen, info, { id: device.id, transport: device.transport, name: device.name }, remembered);
    } catch (error) {
      this.handleFailure(gen, error);
    }
    return "connected";
  }

  /**
   * Several adapters remembered: the most recent first, each for one window, round after round. After a round
   * nobody answered in, a remembered MFi adapter iOS reports connected goes next: everyone before it had a turn.
   */
  private async inTurn(list: RememberedAdapter[]): Promise<void> {
    const run = ++this.autoRun;
    this.roundRun = run;
    try {
      for (let round = 0; run === this.autoRun; round++) {
        // Everyone once per round: a present MFi adapter jumps the queue, but takes one turn, not every slot.
        const tried = new Set<string>();
        for (let i = 0; i < list.length && run === this.autoRun; i++) {
          const present = round > 0 ? (this.deps.discovery.mfiPresent?.() ?? []) : [];
          const next =
            list.find((a) => a.transport === "mfi" && present.includes(a.id) && !tried.has(a.id)) ?? list.find((a) => !tried.has(a.id))!;
          tried.add(next.id);
          const startedUs = this.deps.clock.nowUs();
          const outcome = await this.open(next.id, { wait: true, windowMs: AUTO_CONNECT_WINDOW_MS });
          if (outcome !== "unreachable" || run !== this.autoRun) return;
          if (round === 0) this.event("auto-connect", `${next.name ?? next.id} not reachable in ${AUTO_CONNECT_WINDOW_MS / 1000} s`);
          // A quick failure still takes its window: no busy loop.
          const leftMs = AUTO_CONNECT_WINDOW_MS - (this.deps.clock.nowUs() - startedUs) / 1000;
          if (leftMs > 0) await this.deps.clock.sleep(leftMs);
        }
      }
    } finally {
      if (this.roundRun === run) this.roundRun = null;
    }
  }

  private async close(): Promise<void> {
    this.gen++;
    const transport = this.transport;
    if (!transport && !this.session && this.snapshot.activeDeviceId === null) return;
    await this.teardownSession();
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers = [];
    this.transport = null;
    if (transport) {
      await transport.disconnect().catch(() => undefined);
      this.event("disconnect");
    }
    this.engine.reset(this.deps.clock.nowUs());
    this.update({ link: "idle", activeDeviceId: null, stats: null });
  }

  send: SendFn = async (command, opts) => {
    const session = this.requireSession();
    return session.send(command, { timeoutMs: opts?.timeoutMs, priority: Priority.Control });
  };

  async exclusive<T>(fn: (send: SendFn) => Promise<T>): Promise<T> {
    const session = this.requireSession();
    return session.exclusive((send) => fn((command, opts) => send(command, { timeoutMs: opts?.timeoutMs })));
  }

  // ---- Dev knobs ----

  /**
   * CAN primary (§16.2–16.3): listen to these ids while the ECU is awake, frames to the trip log, the speed decoded
   * from them (`pushCanSpeed`) to the navigator instead of OBD's; while it shows the car moving nothing is polled, so
   * the monitor listens without breaks. Standing (or without fresh CAN speed) the polls run as always, the monitor in
   * their breaks, and with them the engine state. Null or empty: off. STN adapters on a CAN car only.
   */
  setCanShadow(ids: number[] | null): void {
    const next = ids && ids.length > 0 ? ids : null;
    if (JSON.stringify(next) === JSON.stringify(this.canShadowIds)) return;
    this.canShadowIds = next;
    if (this.poller) this.attachShadow();
  }

  /**
   * The monitor is on this session and hasn't failed: only then can CAN carry the speed. Otherwise (no ids, an adapter
   * or car that can't, a failed monitor) the polls are all there is, and nothing pauses them.
   */
  private get canPrimary(): boolean {
    return this.canTrusted && this.shadow !== null && this.shadow.status.state !== "failed";
  }

  /**
   * A profile on probation (§16.5): the monitor listens and its speed is decoded, but the navigator keeps OBD's speed
   * and the polls run at their rate while the car moves, so the two can be compared. True again once it passed.
   */
  setCanTrusted(on: boolean): void {
    this.canTrusted = on;
    if (!on) {
      this.listenUntilUs = null;
      this.lastCanSpeed = null;
      if (this.snapshot.speedFromCan) this.update({ speedFromCan: false });
    }
  }

  /** A CAN speed sample (`source: "can"`, negative in reverse), from the frames this link's shadow heard. */
  pushCanSpeed(s: SpeedSample): void {
    if (!this.canPrimary || !this.poller?.isRunning) return;
    this.lastCanSpeed = { tUs: s.tUs, raw: s.raw };
    // A moving car proves the ECU awake, and while it moves no poll would tell the engine state otherwise. Standing,
    // the bus speaks after the ECU is off: its 0 proves nothing (the polls' silence tells ignition-off).
    this.engine.onSpeed(s.tUs, Math.abs(s.raw), true);
    this.onSpeedSample({ ...s, source: "can" });
  }

  /**
   * CAN primary: no poll now (§16.3). The car moves on fresh CAN speed; or OBD says it moves and the monitor has its
   * one long window to bring a CAN speed (`CAN_LISTEN_WINDOW_US`).
   */
  private canCarriesSpeed(nowUs: number): boolean {
    if (!this.canPrimary) {
      this.listenUntilUs = null;
      return false;
    }
    if (this.canSpeedFresh(nowUs, CAN_PAUSE_FRESH_US) && this.lastCanSpeed!.raw >= CAN_MOVING_KPH) {
      this.listenUntilUs = null;
      return true;
    }
    if (this.listenUntilUs !== null) {
      if (nowUs < this.listenUntilUs) return true;
      this.listenUntilUs = null;
      this.listenFailedUs = nowUs;
      return false;
    }
    const o = this.lastObdSpeed;
    if (o === null || o.raw < CAN_MOVING_KPH || nowUs - o.rxUs > OBD_MOVING_FRESH_US) return false;
    if (nowUs - this.listenFailedUs < CAN_LISTEN_RETRY_US) return false;
    this.listenUntilUs = nowUs + CAN_LISTEN_WINDOW_US;
    return true;
  }

  /** CAN speed fresh within `maxAgeUs` of `tUs`. */
  private canSpeedFresh(tUs: number, maxAgeUs: number): boolean {
    return this.canPrimary && this.lastCanSpeed !== null && tUs - this.lastCanSpeed.tUs <= maxAgeUs;
  }

  setRpmPeriods(periods: Partial<Pick<PollerConfig, "rpmPeriodRunningMs" | "rpmPeriodEngineOffMs" | "rpmPeriodIgnitionOffMs">>): void {
    this.rpmPeriods = { ...this.rpmPeriods, ...periods };
    this.poller?.setRpmPeriods(periods);
  }

  /**
   * Listen to the CAN bus for `durationMs` with polling paused, then poll again (§16, developer survey). STN
   * adapters on a CAN car only. `ids` null: every id, which a busy 500 kbit/s bus can overrun (`BUFFER FULL`).
   * `slice`: instead, the ids whose top `bits` bits (of 11 or 29) are `prefix` (discovery's survey, §16.6).
   */
  async monitorCan(opts: { ids: number[] | null; durationMs: number; slice?: IdSlice }): Promise<CanSurvey> {
    const transport = this.transport;
    if (!transport?.writeRaw || !/^STN/i.test(this.snapshot.adapter?.chip ?? "")) throw new Error("needs an STN adapter");
    const protocol = this.remembered().find((a) => a.id === this.snapshot.activeDeviceId)?.protocolNumber ?? null;
    if (protocol === null || protocol < 6 || protocol > 9) throw new Error("needs a car on CAN (protocol 6–9)");
    if (this.monitorSink) throw new Error("the monitor is running");
    const idDigits = protocol === 7 || protocol === 9 ? 8 : 3;
    const hex = (n: number, digits: number) => n.toString(16).toUpperCase().padStart(digits, "0");
    const collector = new CanMonitorCollector(idDigits);
    const survey = await this.requireSession().exclusive(async (send) => {
      let running = false;
      try {
        await send("ATH1", { timeoutMs: 1000 });
        // The speed ECU's ATCRA is the CAN hardware filter, which STM obeys too: clear it (and all custom filters).
        await send("ATAR", { timeoutMs: 1000 });
        await send("STCMM0", { timeoutMs: 1000 }); // listen only, no ACKs (the default; older firmware may answer ?)
        const zero = "0".repeat(idDigits);
        const mask = idDigits === 3 ? "7FF" : "1FFFFFFF";
        const filters = opts.slice
          ? [sliceFilter(opts.slice, idDigits === 3 ? 11 : 29)].map((f) => `${hex(f.id, idDigits)},${hex(f.mask, idDigits)}`)
          : opts.ids === null
            ? [`${zero},${zero}`]
            : opts.ids.map((id) => `${hex(id, idDigits)},${mask}`);
        for (const f of filters) {
          // STFAP: the name before STFPA, on older firmware.
          const added = (await send(`STFPA${f}`, { timeoutMs: 1000 })).status === "ok" || (await send(`STFAP${f}`, { timeoutMs: 1000 })).status === "ok";
          if (!added) throw new Error(`pass filter ${f} refused`);
        }
        this.monitorSink = (text, rxUs) => collector.push(text, rxUs);
        const startUs = this.deps.clock.nowUs();
        running = true;
        await transport.writeRaw!("STM\r");
        await this.deps.clock.sleep(opts.durationMs);
        // Any character stops it: the rest of the output, STOPPED, the prompt.
        const stop = await send("", { timeoutMs: 2000 });
        running = false;
        collector.push(stop.raw, stop.rxUs);
        collector.end(stop.rxUs);
        return collector.survey((stop.txUs - startUs) / 1000);
      } finally {
        // A character sent into a running monitor only stops it (and is lost): stop it before the commands.
        if (running) await send("", { timeoutMs: 2000 }).catch(() => undefined);
        await send("ATAR", { timeoutMs: 1000 }).catch(() => undefined);
        if (this.pinnedEcu !== null) await send(`ATCRA${hex(this.pinnedEcu, 3)}`, { timeoutMs: 1000 }).catch(() => undefined);
        await send("ATH0", { timeoutMs: 1000 }).catch(() => undefined);
        this.monitorSink = null;
      }
    });
    this.event("can-monitor", formatSurvey(survey).join("; "));
    return survey;
  }

  async dispose(): Promise<void> {
    this.stopDiscovery();
    await this.disconnect();
    this.listeners.clear();
  }

  // ---- internals ----


  private async runSession(
    gen: number,
    info: ConnectedInfo,
    device: { id: string; transport: TransportKind; name: string | null },
    remembered: RememberedAdapter | undefined,
    /** A reconnect of the adapter in use: a probe that fails is retried (it may still be frozen), not an error. */
    reconnect = false,
  ): Promise<void> {
    const session = new Elm327Session(this.transport!);
    this.session = session;
    this.unsubscribers.push(session.exchanges.on((r) => this.onSessionExchange(r)));

    this.update({ link: "probing" });
    const probe = await probeAdapter((c, o) => session.send(c, o), {
      protocol: remembered?.protocolNumber,
      onSearch: (active) => this.update({ protocolSearch: active }),
    });
    this.check(gen);
    if (!probe.ok) {
      // Under a reconnect it is retried, no fault yet: the detail says so (Sentry leaves those out).
      this.event("probe-failed", reconnect ? `${probe.failedStep}${RECONNECTING}` : probe.failedStep);
      if (reconnect) throw new Error(`probe failed at ${probe.failedStep}`);
      await this.transport?.disconnect().catch(() => undefined);
      // An adapter this phone used before that answers nothing at all: most likely another phone with the app holds
      // it (2026-10-13: two phones in one car took the MX+ from each other), or it locked up.
      const silent = probe.silent && remembered?.adapter !== undefined;
      this.update({
        link: "error",
        error: silent ? { code: "adapter-silent", message: "no answer to the reset" } : { code: "not-elm327", message: `probe failed at ${probe.failedStep}` },
      });
      return;
    }
    probe.warnings.forEach((w) => this.event("probe-warning", w));
    const adapter: AdapterInfo = {
      deviceId: device.id,
      transport: device.transport,
      name: device.name,
      elmVersion: probe.elmVersion,
      description: probe.description,
      chip: probe.chip,
      suspectedClone: probe.suspectedClone,
      batteryV: probe.batteryV,
      capabilities: remembered?.adapter?.capabilities ?? {
        responseCount: false,
        adaptiveTiming2: false,
        physicalAddressing: false,
      },
      connected: info,
    };
    this.update({ adapter });
    this.remember(device, adapter, info);
    this.event("verified", probe.elmVersion ?? undefined);

    if (probe.foundProtocol !== null) this.adoptProtocol(remembered?.protocolNumber ?? 0, probe.foundProtocol);
    if (probe.vehiclePresent && (await this.initAndPoll(gen)) !== "no-vehicle") return;
    await this.standby(gen, this.cachedProtocol());
  }

  /** The protocol the active adapter remembers for its car; 0: none. */
  private cachedProtocol(): number {
    return this.remembered().find((a) => a.id === this.snapshot.activeDeviceId)?.protocolNumber ?? 0;
  }

  /**
   * Wait for the ECU (§10.3). A cached protocol whose bus isn't there (bus errors, not NO DATA) may be
   * another car's: every few checks, all protocols are searched.
   */
  private async standby(gen: number, cachedProtocol: number = 0): Promise<void> {
    this.enterStandby();
    const period = this.deps.standbyProbeMs ?? 5000;
    const send = (command: string, opts?: { timeoutMs?: number }) => this.requireSession().send(command, { ...opts, priority: Priority.Rpm });
    let wrong = 0;
    while (true) {
      await this.deps.clock.sleep(period);
      this.check(gen);
      const search = cachedProtocol !== 0 && wrong % SEARCH_EVERY === SEARCH_EVERY - 1;
      let found: boolean;
      if (search) {
        this.update({ protocolSearch: true });
        const protocol = await searchProtocols(send).finally(() => this.update({ protocolSearch: false }));
        found = protocol !== null;
        if (protocol !== null) this.adoptProtocol(cachedProtocol, protocol);
        wrong++;
      } else {
        const r = await send("0100", { timeoutMs: 10000 });
        found = r.status === "ok" && parseMode01(r.lines, 0x00, 4).length > 0;
        wrong = wrongBus(r.status) ? wrong + 1 : 0;
      }
      this.check(gen);
      // An init that finds no car after all (the ECU's last answer was the one to 0100): back to the checks, in
      // this loop, not a nested one.
      if (found) {
        if ((await this.initAndPoll(gen)) !== "no-vehicle") return;
        this.enterStandby();
      } else if (search) await send(`ATSP${cachedProtocol.toString(16).toUpperCase()}`, { timeoutMs: 1000 });
    }
  }

  /** The ECU is silent (no answer, or an init that found no car): waiting for it. */
  private enterStandby(): void {
    this.engine.onObdResponse(false, this.deps.clock.nowUs());
    this.update({ link: "standby" });
  }

  /**
   * A search found the car on another protocol than the cached one: cache it now, so the init and any later check
   * use it. Searching again (or trying the old one first) breaks a K-line session that has just come up: on the
   * Logan (2026-10-05) init went CAN ERROR → search → UNABLE TO CONNECT four times, 77 s to the first poll.
   */
  private adoptProtocol(cached: number, found: number): void {
    this.event("protocol-search", `protocol ${cached.toString(16).toUpperCase()} failed; ${found ? found.toString(16).toUpperCase() : "another"} answered`);
    this.patchRemembered({ protocolNumber: found || null });
  }

  /**
   * Init the car and start the poller. "no-vehicle": the init found no car; the caller goes (back) to standby.
   * "error": the link is in error (the car has no speed PID).
   */
  private async initAndPoll(gen: number): Promise<InitOutcome> {
    const session = this.requireSession();
    this.update({ link: "initializing" });
    const remembered = this.remembered().find((a) => a.id === this.snapshot.activeDeviceId);
    const seq = ++this.initSeq;
    const init = await session.exclusive((send) => initVehicle(send, { cachedProtocol: remembered?.protocolNumber ?? null }));
    this.check(gen);
    if (!init.ok) {
      if (init.error === "no-speed-pid") {
        this.update({ link: "error", error: { code: "no-speed-pid", message: "vehicle doesn't report speed (PID 0D)" } });
        return "error";
      }
      return "no-vehicle";
    }
    const adapter = this.snapshot.adapter ? { ...this.snapshot.adapter, capabilities: init.capabilities } : null;
    const vehicle = this.identify(init.vehicle, init.protocolNumber);
    this.pinnedEcu = init.pinnedEcu;
    this.update({ vehicle, adapter });
    this.patchRemembered({ protocolNumber: init.protocolNumber, adapter: adapter ?? undefined });
    this.event("initialized", `${init.vehicle.protocol ?? "?"} ${init.poll.speedCommand}`);
    if (vehicle.vinSource !== "read") {
      const reply = `0902: ${init.vinReply ?? "not asked"}`;
      this.event("vin", vehicle.vin ? `not read (${reply}); the last car on protocol ${init.protocolNumber}: ${vehicle.vin}` : `not read (${reply}); a car not seen on this protocol`);
    }

    const poller = new ObdPoller(
      session,
      this.deps.clock,
      this.engine,
      {
        ...this.deps.pollerConfig,
        ...this.rpmPeriods,
        speedCommand: init.poll.speedCommand,
        rpmCommand: init.poll.rpmCommand,
        maxSpeedHz: OBD_SPEED_HZ,
      },
      {
        onSpeed: (s) => this.onSpeedSample(s),
        onRpm: (s) => this.onRpmSample(s),
        onBattery: (v) => {
          if (this.snapshot.adapter) this.update({ adapter: { ...this.snapshot.adapter, batteryV: v } });
        },
        onNeedsReinit: (reason) => void this.reinit(gen, reason),
        paused: () => this.canCarriesSpeed(this.deps.clock.nowUs()),
      },
    );
    this.poller = poller;
    poller.start();
    // The car answers again: an earlier session's error is over.
    this.update({ link: this.engine.state === "ignition-off" ? "standby" : "polling", error: null });
    this.attachShadow();
    if (vehicle.vinSource !== "read") void this.retryVin(gen, seq, init.pinnedEcu, init.protocolNumber);
    return "polling";
  }

  /**
   * The VIN from `0902`, else the last car seen on this protocol (one adapter mostly stays in one car; a car on
   * another protocol is another car). Updates the car list.
   */
  private identify(vehicle: VehicleInfo, protocolNumber: number | null): VehicleInfo {
    const cars = this.cars();
    const seenAt = (this.deps.nowMs ?? Date.now)();
    if (vehicle.vin) {
      const others = cars.filter((c) => c.vin !== vehicle.vin && !(c.vin === null && c.protocolNumber === protocolNumber));
      this.saveCars([{ vin: vehicle.vin, protocolNumber, seenAt }, ...others]);
      return { ...vehicle, vinSource: "read" };
    }
    const last = cars.find((c) => c.protocolNumber === protocolNumber);
    this.saveCars([{ vin: last?.vin ?? null, protocolNumber, seenAt }, ...cars.filter((c) => c !== last)]);
    return last?.vin ? { ...vehicle, vin: last.vin, vinSource: "remembered" } : vehicle;
  }

  /** Ask for the VIN again while polling: the read at init can miss (the engine cranking, a late reply). */
  private async retryVin(gen: number, seq: number, pinned: number | null, protocolNumber: number | null): Promise<void> {
    const stale = () => gen !== this.gen || seq !== this.initSeq || !this.poller;
    let reply = "not asked";
    for (let i = 0; i < VIN_RETRY_MS.length; i++) {
      await this.deps.clock.sleep(VIN_RETRY_MS[i]);
      // Not while cranking or with the engine off: the read that missed may have been the ECU busy starting.
      while (!stale() && this.engine.state !== "engine-running") await this.deps.clock.sleep(1000);
      if (stale()) return;
      const read = await this.requireSession()
        .exclusive((send) => readVin(send, pinned))
        .catch((e: unknown) => ({ vin: null, reply: `failed: ${e instanceof Error ? e.message : String(e)}` }));
      if (stale()) return;
      const vin = read.vin;
      reply = read.reply;
      if (!vin) continue;
      const assumed = this.snapshot.vehicle?.vin;
      const vehicle = this.identify({ ...this.snapshot.vehicle!, vin, vinSource: undefined }, protocolNumber);
      this.event("vin", `read on retry ${i + 1}${assumed && assumed !== vin ? ", not the car assumed" : ""}`);
      this.update({ vehicle });
      return;
    }
    if (stale()) return;
    this.event("vin", `not read after ${VIN_RETRY_MS.length} retries (last 0902: ${reply})`);
    const vehicle = this.snapshot.vehicle;
    if (vehicle && !vehicle.vin) this.update({ vehicle: { ...vehicle, vinSource: "missing" } });
  }

  /** `frozen`: the adapter is known to have frozen (the CAN monitor got no byte back), not the car switched off. */
  private async reinit(gen: number, reason: string, frozen = false): Promise<void> {
    if (this.reiniting || gen !== this.gen) return;
    this.reiniting = true;
    this.event("reinit", reason);
    this.shadow?.disable();
    let outcome: InitOutcome | null = null;
    try {
      // The car was moving: it didn't switch off, the adapter or its link froze (§10.5).
      const moving = frozen || (this.snapshot.lastSpeed?.raw ?? 0) > 0;
      await this.poller?.stop();
      this.poller = null;
      this.check(gen);
      if (frozen) {
        // Forensics, each answer in the transcript: ATI after a pause (an adapter still draining its buffer answers
        // by then; not a bare CR, which repeats the last command, STM), then ATWS below, then ATZ.
        await this.deps.clock.sleep(1000);
        this.check(gen);
        const ati = await this.requireSession().send("ATI", { timeoutMs: 1000 });
        this.event("frozen", ati.status === "timeout" ? "ATI: no answer 1 s after the silent stop" : `ATI answered 1 s after the silent stop: ${JSON.stringify(ati.raw.trim())}`);
      }
      // Moving, every second without speed counts: one try, then the link is reopened.
      let answered = await warmReset((c, o) => this.requireSession().send(c, o), moving ? 1 : 3);
      this.check(gen);
      if (!answered && frozen) {
        const atz = await this.requireSession().send("ATZ", { timeoutMs: 2000 });
        this.check(gen);
        answered = atz.status !== "timeout";
        this.event("frozen", answered ? `ATZ answered: ${JSON.stringify(atz.raw.trim())}` : "ATZ: no answer either");
      }
      if (!answered && moving) {
        this.event("reopen", frozen ? "no answer to ATWS after the monitor froze" : "no answer to ATWS while moving");
        await this.transport?.disconnect().catch(() => undefined);
        this.check(gen);
        this.onLinkLost(gen, "adapter silent");
        return;
      }
      outcome = await this.initAndPoll(gen);
    } catch (error) {
      this.handleFailure(gen, error);
    } finally {
      this.reiniting = false;
    }
    // The reinit is over; waiting for the car is not part of it (another reinit may be needed meanwhile).
    if (outcome === "no-vehicle") await this.standby(gen, this.cachedProtocol()).catch((error) => this.handleFailure(gen, error));
  }

  private onLinkLost(gen: number, reason: string): void {
    if (gen !== this.gen) return;
    this.event("link-lost", reason);
    if (this.reconnecting === gen) {
      // Lost again while the reconnect loop's session was probing or initializing: that session is over (its
      // pending command rejects, and the loop connects again); a second loop would run two sessions on one adapter.
      void this.teardownSession();
      this.update({ link: "reconnecting", stats: null, speedFromCan: false });
      return;
    }
    this.reconnecting = gen;
    void (async () => {
      await this.teardownSession();
      this.engine.reset(this.deps.clock.nowUs());
      this.update({ link: "reconnecting", stats: null, speedFromCan: false });
      try {
        await this.reconnectLoop(gen);
      } finally {
        if (this.reconnecting === gen) this.reconnecting = null;
      }
    })();
  }

  /** Connect the transport again and run a session on it, until one holds or the link is closed. */
  private async reconnectLoop(gen: number): Promise<void> {
    let delayMs = 1000;
    while (gen === this.gen) {
      try {
        const info = await this.transport!.connect();
        if (gen !== this.gen) return;
        this.event("link-restored");
        const device = this.snapshot.adapter;
        const remembered = this.remembered().find((a) => a.id === this.snapshot.activeDeviceId);
        await this.runSession(
          gen,
          info,
          { id: this.snapshot.activeDeviceId!, transport: device?.transport ?? this.transport!.kind, name: device?.name ?? null },
          remembered,
          true,
        );
        return;
      } catch (error) {
        if (error instanceof Cancelled || gen !== this.gen) return;
        if (error instanceof SessionClosedError) continue;
        // A probe that failed left its session behind.
        await this.teardownSession();
        await this.deps.clock.sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 30000);
      }
    }
  }

  private async teardownSession(): Promise<void> {
    const poller = this.poller;
    const session = this.session;
    this.poller = null;
    this.session = null;
    this.shadow = null;
    this.retiredShadow = null;
    session?.close();
    await poller?.stop().catch(() => undefined);
  }

  private handleFailure(gen: number, error: unknown): void {
    if (error instanceof Cancelled || error instanceof SessionClosedError || gen !== this.gen) return;
    const message = error instanceof Error ? error.message : String(error);
    // The link was lost under it (a reinit waiting for an answer as the adapter powers down): the reconnect is on it,
    // and this failure is only that loss again, not an error to show.
    if (this.reconnecting === gen) {
      this.event("failed-while-reconnecting", message);
      return;
    }
    const code = (error as { code?: string })?.code;
    const linkError: LinkError =
      code === "bluetooth-off" || code === "bluetooth-unauthorized" || code === "no-uart-service" || code === "device-not-found"
        ? { code, message }
        : { code: "other", message, ...(code ? { nativeCode: code } : {}) };
    // The snapshot first: the event's listeners read the error's code from it.
    this.update({ link: "error", error: linkError });
    this.event("error", message);
  }

  private check(gen: number): void {
    if (gen !== this.gen) throw new Cancelled();
  }

  private requireSession(): Elm327Session {
    if (!this.session) throw new Error("no adapter session");
    return this.session;
  }

  /** The CAN shadow on this session, when asked for and possible: an STN adapter on a CAN car (§16.2). */
  private attachShadow(): void {
    const session = this.session;
    if (!session) return;
    const old = this.shadow;
    old?.disable();
    this.retiredShadow = old?.running ? old : null;
    const ids = this.canShadowIds;
    const protocol = this.remembered().find((a) => a.id === this.snapshot.activeDeviceId)?.protocolNumber ?? null;
    let shadow: CanShadow | null = null;
    const transport = this.transport;
    const why = !transport?.writeRaw || !/^STN/i.test(this.snapshot.adapter?.chip ?? "")
      ? "needs an STN adapter"
      : protocol === null || protocol < 6 || protocol > 9
        ? "needs a car on CAN"
        : null;
    const adapter = this.snapshot.adapter;
    const froze = adapter && this.shadowFroze()[adapter.deviceId];
    const firmware = froze && froze === adapter.chip ? froze : null;
    const canOff: CanOff | null = why === "needs an STN adapter" ? "adapter" : why ? "car" : firmware ? "firmware" : null;
    if (ids) {
      if (why) this.event("can-shadow", `off: ${why}`);
      else if (firmware) this.event("can-shadow", `off: the adapter froze in the monitor on this firmware (${firmware})`);
      else {
        const gen = this.gen;
        shadow = new CanShadow({
          clock: this.deps.clock,
          writeRaw: (text) => transport!.writeRaw!(text),
          ids,
          idDigits: protocol === 7 || protocol === 9 ? 8 : 3,
          pinnedEcu: this.pinnedEcu,
          awake: () => this.engine.state === "engine-running" || this.engine.state === "engine-off",
          onFrames: (frames) => this.canFrames.emit(frames),
          onWindow: (w) => this.canWindows.emit(w),
          onBufferFull: (w) => this.canBufferFull.emit(w),
          onEvent: (detail) => this.event("can-shadow", detail),
          onStatus: (status) => this.onCanStatus(status),
          onFailed: (_reason, silent) => {
            if (!silent) {
              void this.restoreAfterShadow();
              return;
            }
            // Not again on this adapter until its firmware changes (§16.2), only while the car moves: it isn't switched
            // off at speed, and no other phone is taking the adapter. Standing, the silence is the car switched off,
            // the link dropping or another phone near home (every silence of 2026-10-20..30 was at 0 km/h, and the
            // link dropped within a second of each): the link is recovered and the monitor goes on next time.
            if (adapter?.chip && (this.snapshot.lastSpeed?.raw ?? 0) > 0) {
              this.markShadowFroze({ deviceId: adapter.deviceId, chip: adapter.chip });
            }
            // Recover the link now rather than after the polls time out.
            void this.reinit(gen, "adapter silent in the CAN monitor", true);
          },
        });
      }
    }
    this.shadow = shadow;
    session.setIdleMonitor(shadow);
    if (old && !shadow) void this.restoreAfterShadow();
    this.update({ canShadow: shadow?.status ?? null, canOff });
  }

  /** Adapter id → the chip and firmware (`STN2255 v5.10.3`) it froze on in the CAN monitor. */
  private shadowFroze(): Record<string, string> {
    return this.deps.store.getJson<Record<string, string>>(SHADOW_FROZE_KEY) ?? {};
  }

  private markShadowFroze(froze: { deviceId: string; chip: string }): void {
    this.event("can-shadow", `froze the adapter: off on ${froze.chip} from now on`);
    this.update({ canOff: "firmware" });
    this.deps.store.setJson(SHADOW_FROZE_KEY, { ...this.shadowFroze(), [froze.deviceId]: froze.chip });
  }

  /** The adapter as the init left it: no pass filters, headers off, the speed ECU pinned. */
  private async restoreAfterShadow(): Promise<void> {
    const session = this.session;
    const pinned = this.pinnedEcu;
    await session
      ?.exclusive(async (send) => {
        await send("ATAR", { timeoutMs: 1000 });
        if (pinned !== null) await send(`ATCRA${pinned.toString(16).toUpperCase()}`, { timeoutMs: 1000 });
        await send("ATH0", { timeoutMs: 1000 });
      })
      .catch(() => undefined);
  }

  private onCanStatus(status: CanShadowStatus): void {
    const prev = this.snapshot.canShadow;
    const now = this.deps.clock.nowUs();
    const changed = !prev || prev.state !== status.state || prev.failure !== status.failure;
    if (!changed && now - this.lastCanStatusUs < CAN_STATUS_INTERVAL_US) return;
    this.lastCanStatusUs = now;
    this.update({ canShadow: status });
  }

  private onSessionExchange(r: ElmResponse): void {
    this.shadow?.onExchange(r);
    const poll = interpretPoll(r);
    const event: ExchangeEvent = poll
      ? {
          ...r,
          status: poll.status,
          pollPid: poll.pid,
          pollBytes: poll.bytes ?? undefined,
          pollEcu: poll.ecu ?? undefined,
          pollValue: poll.value,
        }
      : r;
    this.exchanges.emit(event);
  }

  private onSpeedSample(s: SpeedSample): void {
    if (s.source !== "can") this.lastObdSpeed = { rxUs: s.rxUs, raw: s.raw };
    // CAN primary: OBD's speed only fills in where CAN's is stale (the poll of a standing car, a monitor gone deaf).
    if (s.source !== "can" && this.canSpeedFresh(s.tUs, CAN_FRESH_US)) {
      this.update({ speedFromCan: true, ...this.maybeStats(s.rxUs) });
      return;
    }
    this.speed.emit(s);
    this.update({ lastSpeed: s, speedFromCan: this.canSpeedFresh(s.tUs, CAN_CARRIES_US), ...this.maybeStats(s.rxUs) });
  }

  private onRpmSample(s: RpmSample): void {
    this.rpm.emit(s);
    this.update({ lastRpm: s });
  }

  private maybeStats(nowUs: number): Partial<VehicleLinkSnapshot> {
    if (!this.poller || nowUs - this.lastStatsUs < STATS_INTERVAL_US) return {};
    this.lastStatsUs = nowUs;
    const stats = this.poller.stats.snapshot(nowUs);
    return { stats };
  }

  private onEngineChange(state: EngineState, tUs: number): void {
    this.engineEvents.emit(state, tUs);
    const patch: Partial<VehicleLinkSnapshot> = { engine: state };
    if (this.poller?.isRunning) {
      patch.link = state === "ignition-off" ? "standby" : "polling";
      patch.stats = this.poller.stats.snapshot(tUs);
    }
    this.update(patch);
  }

  /** Cars seen, most recent first; before the list existed, the VINs adapters remembered. */
  private cars(): KnownCar[] {
    const stored = this.deps.store.getJson<KnownCar[]>(CARS_KEY);
    if (stored) return stored;
    return [...this.remembered()]
      .sort((a, b) => b.lastVerifiedAt - a.lastVerifiedAt)
      .filter((a) => a.vin)
      .map((a) => ({ vin: a.vin!, protocolNumber: a.protocolNumber ?? null, seenAt: a.lastVerifiedAt }));
  }

  private saveCars(cars: KnownCar[]): void {
    this.deps.store.setJson(CARS_KEY, cars.slice(0, MAX_CARS));
  }

  private remembered(): RememberedAdapter[] {
    return this.deps.store.getJson<RememberedAdapter[]>(ADAPTERS_KEY) ?? [];
  }

  private saveRemembered(list: RememberedAdapter[]): void {
    this.deps.store.setJson(ADAPTERS_KEY, list);
  }

  private remember(
    device: { id: string; transport: TransportKind; name: string | null },
    adapter: AdapterInfo,
    info: ConnectedInfo,
  ): void {
    const list = this.remembered();
    const previous = list.find((a) => a.id === device.id);
    const { connected: _connected, ...adapterFields } = adapter;
    const entry: RememberedAdapter = {
      ...previous,
      id: device.id,
      transport: device.transport,
      name: device.name,
      gatt: info.gatt ?? previous?.gatt,
      adapter: adapterFields,
      lastVerifiedAt: (this.deps.nowMs ?? Date.now)(),
    };
    this.saveRemembered([entry, ...list.filter((a) => a.id !== device.id)]);
    this.refreshDevices();
  }

  private patchRemembered(patch: Partial<RememberedAdapter> & { adapter?: AdapterInfo }): void {
    const id = this.snapshot.activeDeviceId;
    if (!id) return;
    const list = this.remembered();
    const entry = list.find((a) => a.id === id);
    if (!entry) return;
    const { adapter, ...rest } = patch;
    const adapterFields = adapter ? (({ connected: _c, ...a }) => a)(adapter) : entry.adapter;
    this.saveRemembered(list.map((a) => (a.id === id ? { ...a, ...rest, adapter: adapterFields } : a)));
  }

  private refreshDevices(): void {
    const remembered = this.remembered();
    const rememberedIds = new Set(remembered.map((a) => a.id));
    const devices: DiscoveredDevice[] = [];
    for (const r of remembered) {
      const seen = this.scanned.get(r.id);
      devices.push({
        id: r.id,
        transport: r.transport,
        name: seen?.name ?? r.name,
        rssi: seen?.rssi,
        lastSeenUs: seen?.lastSeenUs ?? 0,
        ...rankDevice({ name: seen?.name ?? r.name, serviceUuids: seen?.serviceUuids, remembered: true }),
      });
    }
    for (const d of this.scanned.values()) {
      if (rememberedIds.has(d.id)) continue;
      devices.push({
        id: d.id,
        transport: d.transport,
        name: d.name,
        rssi: d.rssi,
        lastSeenUs: d.lastSeenUs,
        ...rankDevice({ name: d.name, serviceUuids: d.serviceUuids }),
      });
    }
    devices.sort(compareDevices);
    this.update({ devices });
  }

  private event(type: string, detail?: string): void {
    this.linkEvents.emit({ type, tUs: this.deps.clock.nowUs(), detail });
  }

  private update(patch: Partial<VehicleLinkSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    // Ready ends the try; a link that starts trying (from ready or from nothing) starts it. Idle between auto-connect's
    // turns keeps it, so the UI's timeout counts the whole wait.
    // A step forward restarts it: the adapter answers (probing), the car answers (initializing).
    const ready = next.link === "polling" && !!next.vehicle?.vin;
    const trying = next.link !== "idle" && next.link !== "error";
    const stepped = next.link !== this.snapshot.link && (next.link === "probing" || next.link === "initializing");
    if (ready) next.tryingSinceMs = null;
    else if (!("tryingSinceMs" in patch) && trying && (next.tryingSinceMs === null || stepped)) next.tryingSinceMs = (this.deps.nowMs ?? Date.now)();
    this.snapshot = next;
    this.listeners.forEach((l) => l());
  }
}
