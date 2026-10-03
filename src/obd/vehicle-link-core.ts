// VehicleLink orchestrator (docs/VEHICLE-LINK-SPEC.md §6.2, §7, §8, §9, §11).
// Pure TS: transports, discovery, and storage are injected, so the whole lifecycle
// runs in Node tests against the emulator.

import { compareDevices, rankDevice } from "./catalog";
import type { Clock } from "./clock";
import { probeAdapter, warmReset } from "./elm327/probe";
import { initVehicle } from "./elm327/init";
import { parseMode01 } from "./elm327/parser";
import { Elm327Session, Priority, SessionClosedError } from "./elm327/session";
import { Emitter } from "./emitter";
import { EngineStateMachine } from "./engine-state";
import { ObdPoller, interpretPoll, type PollerConfig } from "./poller";
import type {
  AdapterInfo,
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
  VehicleLink,
  VehicleLinkSnapshot,
} from "./types";

export interface ScannedDevice {
  id: string;
  transport: TransportKind;
  name: string | null;
  rssi?: number;
  serviceUuids?: string[];
  lastSeenUs: number;
}

export interface DiscoveryBackend {
  start(onUpdate: (devices: ScannedDevice[]) => void): void;
  stop(): void;
  pairMfi?(): Promise<void>;
}

export interface RememberedAdapter {
  id: string;
  transport: TransportKind;
  name: string | null;
  gatt?: ConnectedInfo["gatt"];
  adapter?: Omit<AdapterInfo, "connected">;
  protocolNumber?: number | null;
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
const SPEED_CAPS_KEY = "vehicleLink.speedCapsByVin";
const STATS_INTERVAL_US = 250_000;

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
  private gen = 0;
  private transport: Transport | null = null;
  private session: Elm327Session | null = null;
  private poller: ObdPoller | null = null;
  private engine: EngineStateMachine;
  private unsubscribers: (() => void)[] = [];
  private lastStatsUs = 0;
  private reiniting = false;
  private speedCapOverride: number | null = null;
  private rpmPeriods: Partial<PollerConfig> = {};

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

  // ---- VehicleLink: discovery ----

  startDiscovery(): void {
    if (this.snapshot.discovering) return;
    this.update({ discovering: true });
    this.deps.discovery.start((devices) => {
      for (const d of devices) this.scanned.set(d.id, d);
      this.refreshDevices();
    });
  }

  stopDiscovery(): void {
    if (!this.snapshot.discovering) return;
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
   * Connect to the most recently verified adapter, if any (§7 auto-connect). The connect
   * waits for the adapter to become reachable: an MFi adapter joins iOS only a few seconds
   * after the car wakes it, often after the app is opened. A failed attempt is retried.
   */
  async autoConnect(): Promise<boolean> {
    if (this.snapshot.activeDeviceId && this.snapshot.link !== "error") return true;
    const last = this.lastRemembered();
    if (!last) return false;
    await this.connect(last.id, { wait: true });
    return true;
  }

  /** The car's VIN: the connected one, else the one auto-connect expects (its adapter's last car). */
  expectedVin(): string | null {
    return this.snapshot.vehicle?.vin || this.lastRemembered()?.vin || null;
  }

  // ---- VehicleLink: connection ----

  async connect(deviceId: string, options?: { wait?: boolean }): Promise<void> {
    await this.disconnect();
    const gen = ++this.gen;
    const remembered = this.remembered().find((a) => a.id === deviceId);
    const scanned = this.scanned.get(deviceId);
    const device = scanned ?? remembered;
    if (!device) {
      this.update({ link: "error", error: { code: "device-not-found" } });
      return;
    }
    this.update({
      link: "connecting",
      error: null,
      activeDeviceId: deviceId,
      adapter: null,
      vehicle: null,
      lastSpeed: null,
      lastRpm: null,
      stats: null,
    });
    this.event("connect", device.name ?? deviceId);
    const transport = this.deps.createTransport(
      { id: device.id, transport: device.transport, name: device.name },
      remembered,
    );
    this.transport = transport;
    this.unsubscribers.push(transport.onLinkLost((reason) => this.onLinkLost(gen, reason)));
    this.unsubscribers.push(
      transport.onUnsolicited((text, rxUs) => this.linkEvents.emit({ type: "unsolicited", tUs: rxUs, detail: text })),
    );
    try {
      const info = await transport.connect(options);
      this.check(gen);
      await this.runSession(gen, info, { id: device.id, transport: device.transport, name: device.name }, remembered);
    } catch (error) {
      this.handleFailure(gen, error);
    }
  }

  async disconnect(): Promise<void> {
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

  /** Override the speed cap (null → per-VIN cap or the safety ceiling). */
  setSpeedCapOverride(hz: number | null): void {
    this.speedCapOverride = hz;
    this.poller?.setSpeedCap(this.speedCapFor(this.snapshot.vehicle?.vin ?? null));
  }

  /** Store the per-VIN cap derived from ECU refresh analysis (§10.2). */
  setSpeedCapForVin(vin: string, hz: number | null): void {
    const caps = this.deps.store.getJson<Record<string, number>>(SPEED_CAPS_KEY) ?? {};
    if (hz === null) delete caps[vin];
    else caps[vin] = hz;
    this.deps.store.setJson(SPEED_CAPS_KEY, caps);
    this.poller?.setSpeedCap(this.speedCapFor(this.snapshot.vehicle?.vin ?? null));
  }

  setRpmPeriods(periods: Partial<Pick<PollerConfig, "rpmPeriodRunningMs" | "rpmPeriodEngineOffMs" | "rpmPeriodIgnitionOffMs">>): void {
    this.rpmPeriods = { ...this.rpmPeriods, ...periods };
    this.poller?.setRpmPeriods(periods);
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
  ): Promise<void> {
    const session = new Elm327Session(this.transport!);
    this.session = session;
    this.unsubscribers.push(session.exchanges.on((r) => this.onSessionExchange(r)));

    this.update({ link: "probing" });
    const probe = await probeAdapter((c, o) => session.send(c, o), { protocol: remembered?.protocolNumber });
    this.check(gen);
    if (!probe.ok) {
      this.event("probe-failed", probe.failedStep);
      await this.transport?.disconnect().catch(() => undefined);
      this.update({ link: "error", error: { code: "not-elm327", message: `probe failed at ${probe.failedStep}` } });
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

    if (probe.vehiclePresent) await this.initAndPoll(gen);
    else await this.standby(gen);
  }

  private async standby(gen: number): Promise<void> {
    this.engine.onObdResponse(false, this.deps.clock.nowUs());
    this.update({ link: "standby" });
    const period = this.deps.standbyProbeMs ?? 5000;
    while (true) {
      await this.deps.clock.sleep(period);
      this.check(gen);
      const r = await this.requireSession().send("0100", { timeoutMs: 10000, priority: Priority.Rpm });
      this.check(gen);
      if (r.status === "ok" && parseMode01(r.lines, 0x00, 4).length > 0) {
        await this.initAndPoll(gen);
        return;
      }
    }
  }

  private async initAndPoll(gen: number): Promise<void> {
    const session = this.requireSession();
    this.update({ link: "initializing" });
    const remembered = this.remembered().find((a) => a.id === this.snapshot.activeDeviceId);
    const init = await session.exclusive((send) =>
      initVehicle(send, { cachedProtocol: remembered?.protocolNumber ?? null }),
    );
    this.check(gen);
    if (!init.ok) {
      if (init.error === "no-speed-pid") {
        this.update({ link: "error", error: { code: "no-speed-pid", message: "vehicle doesn't report speed (PID 0D)" } });
        return;
      }
      await this.standby(gen);
      return;
    }
    const adapter = this.snapshot.adapter ? { ...this.snapshot.adapter, capabilities: init.capabilities } : null;
    this.update({ vehicle: init.vehicle, adapter });
    this.patchRemembered({ protocolNumber: init.protocolNumber, vin: init.vehicle.vin, adapter: adapter ?? undefined });
    this.event("initialized", `${init.vehicle.protocol ?? "?"} ${init.poll.speedCommand}`);

    const poller = new ObdPoller(
      session,
      this.deps.clock,
      this.engine,
      {
        ...this.deps.pollerConfig,
        ...this.rpmPeriods,
        speedCommand: init.poll.speedCommand,
        rpmCommand: init.poll.rpmCommand,
        maxSpeedHz: this.speedCapFor(init.vehicle.vin),
      },
      {
        onSpeed: (s) => this.onSpeedSample(s),
        onRpm: (s) => this.onRpmSample(s),
        onBattery: (v) => {
          if (this.snapshot.adapter) this.update({ adapter: { ...this.snapshot.adapter, batteryV: v } });
        },
        onNeedsReinit: (reason) => void this.reinit(gen, reason),
      },
    );
    this.poller = poller;
    poller.start();
    this.update({ link: this.engine.state === "ignition-off" ? "standby" : "polling" });
  }

  private async reinit(gen: number, reason: string): Promise<void> {
    if (this.reiniting || gen !== this.gen) return;
    this.reiniting = true;
    this.event("reinit", reason);
    try {
      await this.poller?.stop();
      this.poller = null;
      this.check(gen);
      await warmReset((c, o) => this.requireSession().send(c, o));
      await this.initAndPoll(gen);
    } catch (error) {
      this.handleFailure(gen, error);
    } finally {
      this.reiniting = false;
    }
  }

  private onLinkLost(gen: number, reason: string): void {
    if (gen !== this.gen) return;
    this.event("link-lost", reason);
    void (async () => {
      await this.teardownSession();
      this.engine.reset(this.deps.clock.nowUs());
      this.update({ link: "reconnecting", stats: null });
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
          );
          return;
        } catch (error) {
          if (error instanceof Cancelled || gen !== this.gen) return;
          if (error instanceof SessionClosedError) continue;
          await this.deps.clock.sleep(delayMs);
          delayMs = Math.min(delayMs * 2, 30000);
        }
      }
    })();
  }

  private async teardownSession(): Promise<void> {
    const poller = this.poller;
    const session = this.session;
    this.poller = null;
    this.session = null;
    session?.close();
    await poller?.stop().catch(() => undefined);
  }

  private handleFailure(gen: number, error: unknown): void {
    if (error instanceof Cancelled || error instanceof SessionClosedError || gen !== this.gen) return;
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code;
    const linkError: LinkError =
      code === "bluetooth-off" || code === "bluetooth-unauthorized" || code === "no-uart-service" || code === "device-not-found"
        ? { code, message }
        : { code: "other", message };
    this.event("error", message);
    this.update({ link: "error", error: linkError });
  }

  private check(gen: number): void {
    if (gen !== this.gen) throw new Cancelled();
  }

  private requireSession(): Elm327Session {
    if (!this.session) throw new Error("no adapter session");
    return this.session;
  }

  private onSessionExchange(r: ElmResponse): void {
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
    this.speed.emit(s);
    this.update({ lastSpeed: s, ...this.maybeStats(s.rxUs) });
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

  private speedCapFor(vin: string | null): number {
    if (this.speedCapOverride !== null) return this.speedCapOverride;
    const caps = this.deps.store.getJson<Record<string, number>>(SPEED_CAPS_KEY) ?? {};
    return (vin && caps[vin]) || Infinity;
  }

  private lastRemembered(): RememberedAdapter | undefined {
    return [...this.remembered()].sort((a, b) => b.lastVerifiedAt - a.lastVerifiedAt)[0];
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
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }
}
