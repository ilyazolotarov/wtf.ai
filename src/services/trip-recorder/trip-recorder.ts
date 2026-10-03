// Trip recorder (docs/TRIP-LOGGER-SPEC.md §3, §4, §6): trip detection, pre-roll,
// ULog writer lifecycle, trip index. Runs for the app's lifetime, independent of screens.

import { Emitter } from "@/obd/emitter";
import { ELM_STATUS_CODES, type EngineState, type ExchangeEvent, type LinkState } from "@/obd/types";
import type { KeyValueStore, VehicleLinkCore } from "@/obd/vehicle-link-core";
import { haversineM } from "@/nav/geo";
import {
  END_REASON_CODES,
  ENGINE_STATE_CODES,
  LINK_STATE_CODES,
  LOG_TAGS,
  TRIP_EVENTS,
  type EndReason,
  type GnssRecord,
} from "@/triplog/schema";
import {
  DEFAULT_TRIP_CONFIG,
  TripDetector,
  type RecorderState,
  type StartReason,
} from "@/triplog/trip-detector";
import { TripLogWriter } from "@/triplog/trip-log-writer";

import type { SensorService } from "../sensor-capture/sensor-service";
import type { TripFiles } from "./trip-files";

export interface TripSettings {
  imuRateHz: 50 | 100;
  rawImu: boolean;
  parkedTimeoutMin: number;
  linkTimeoutMin: number;
  lingerMin: number;
}

export const DEFAULT_TRIP_SETTINGS: TripSettings = {
  imuRateHz: 100,
  rawImu: false,
  parkedTimeoutMin: DEFAULT_TRIP_CONFIG.parkedTimeoutUs / 60e6,
  linkTimeoutMin: DEFAULT_TRIP_CONFIG.linkTimeoutUs / 60e6,
  lingerMin: DEFAULT_TRIP_CONFIG.lingerUs / 60e6,
};

export interface TripIndexEntry {
  id: string;
  fileName: string;
  startUtcMs: number;
  endUtcMs?: number;
  durationS?: number;
  startReason: StartReason;
  endReason?: EndReason;
  bytes: number;
  distanceM: number;
  adapterName?: string;
  complete: boolean;
}

export interface CurrentTrip {
  id: string;
  fileName: string;
  startedUs: number;
  startReason: StartReason;
  bytes: number;
  distanceM: number;
  durationS: number;
}

export interface RecorderSnapshot {
  state: RecorderState;
  current: CurrentTrip | null;
  trips: TripIndexEntry[];
  settings: TripSettings;
  freeBytes: number;
  lastError: string | null;
}

export interface TripRecorderDeps {
  link: VehicleLinkCore;
  sensors: SensorService;
  files: TripFiles;
  store: KeyValueStore;
  nowUs(): number;
  /** sys_name, ver_sw, sys_hw, sys_os_ver … (TRIP-LOGGER-SPEC §6.2). */
  appInfo(): Record<string, string>;
}

const INDEX_KEY = "trips.index";
const SETTINGS_KEY = "trips.settings";
const PREROLL_US = 30_000_000;
const MIN_FREE_BYTES = 200 * 1024 * 1024;
const LINK_UP: readonly LinkState[] = ["standby", "initializing", "polling"];

type Pending = { tUs: number; write(w: TripLogWriter): void };

function tripId(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Satellite fix: iOS reports no speed for Wi-Fi/cell fallback positions (e.g. under GNSS jamming). */
const isSatelliteFix = (f: GnssRecord) => f.speedMps >= 0 && f.hAccM < 50;

const escapeRaw = (s: string) => s.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\0/g, "");

export class TripRecorder {
  readonly events = new Emitter<[string]>();

  private snapshot: RecorderSnapshot;
  private listeners = new Set<() => void>();
  private detector: TripDetector;
  private writer: TripLogWriter | null = null;
  private current: CurrentTrip | null = null;
  private preroll: Pending[] = [];
  private lastFix: GnssRecord | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribers: (() => void)[] = [];
  private lastLinkUp = false;
  /** Tracked here: the link snapshot lags behind its engine-state event. */
  private engine: EngineState = "unknown";
  private loggedVin = "";

  constructor(private readonly deps: TripRecorderDeps) {
    const settings = { ...DEFAULT_TRIP_SETTINGS, ...(deps.store.getJson<Partial<TripSettings>>(SETTINGS_KEY) ?? {}) };
    this.detector = new TripDetector(
      {
        onStart: (reason, tUs) => this.beginTrip(reason, tUs),
        onEnd: (reason, tUs) => this.endTrip(reason, tUs),
        onState: () => this.syncSensors(),
      },
      this.detectorConfig(settings),
    );
    this.snapshot = {
      state: "idle",
      current: null,
      trips: this.reconcileIndex(),
      settings,
      freeBytes: this.safeFreeBytes(),
      lastError: null,
    };
    deps.sensors.setImuSettings({ rateHz: settings.imuRateHz, raw: settings.rawImu });
  }

  getSnapshot = (): RecorderSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start(): void {
    if (this.timer) return;
    const { link, sensors } = this.deps;
    this.unsubscribers.push(
      link.subscribe(() => this.onLinkSnapshot()),
      link.onEngineState((state, tUs) => this.onEngine(state, tUs)),
      link.onSpeed((s) => this.detector.onSpeed(s.raw, s.tUs)),
      link.onExchange((e) => this.onExchange(e)),
      link.onLinkEvent((e) => {
        this.record(e.tUs, (w) => {
          w.log(e.type === "error" || e.type === "probe-failed" ? "error" : "info", LOG_TAGS.link, e.tUs, `${e.type}${e.detail ? `: ${e.detail}` : ""}`);
          if (e.type === "link-lost") w.tripEvent(e.tUs, TRIP_EVENTS.linkLost);
          if (e.type === "link-restored") w.tripEvent(e.tUs, TRIP_EVENTS.linkRestored);
        });
      }),
      sensors.gnss.on((fix) => this.onGnss(fix)),
      sensors.imu.on((batch) => {
        for (const m of batch.motion) this.record(m.timestampUs, (w) => w.imuMotion(m));
        for (const g of batch.gyro) this.record(g.timestampUs, (w) => w.gyroRaw(g));
        for (const a of batch.accel) this.record(a.timestampUs, (w) => w.accelRaw(a));
      }),
    );
    this.timer = setInterval(() => this.tick(), 1000);
    this.engine = link.getSnapshot().engine;
    this.onLinkSnapshot();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers = [];
    if (this.writer) this.endTrip("manual", this.deps.nowUs());
    this.deps.sensors.want(false, false);
  }

  manualStart(): void {
    this.detector.manualStart(this.deps.nowUs());
  }

  manualStop(): void {
    this.detector.manualStop(this.deps.nowUs());
  }

  marker(text = "marker"): void {
    const t = this.deps.nowUs();
    this.record(t, (w) => {
      w.tripEvent(t, TRIP_EVENTS.marker);
      w.log("info", LOG_TAGS.app, t, text);
    });
  }

  updateSettings(patch: Partial<TripSettings>): void {
    const settings = { ...this.snapshot.settings, ...patch };
    this.deps.store.setJson(SETTINGS_KEY, settings);
    this.detector.config = this.detectorConfig(settings);
    this.deps.sensors.setImuSettings({ rateHz: settings.imuRateHz, raw: settings.rawImu });
    this.update({ settings });
  }

  tripUri(entry: TripIndexEntry): string {
    return this.deps.files.uri(entry.fileName);
  }

  deleteTrip(id: string): void {
    if (this.current?.id === id) return;
    const entry = this.snapshot.trips.find((t) => t.id === id);
    if (entry) this.deps.files.remove(entry.fileName);
    this.saveIndex(this.snapshot.trips.filter((t) => t.id !== id));
  }

  deleteAll(): void {
    for (const t of this.snapshot.trips) if (t.id !== this.current?.id) this.deps.files.remove(t.fileName);
    this.saveIndex(this.snapshot.trips.filter((t) => t.id === this.current?.id));
  }

  refresh(): void {
    this.update({ trips: this.reconcileIndex(), freeBytes: this.safeFreeBytes() });
  }

  // ---- inputs ----

  private onLinkSnapshot(): void {
    const snap = this.deps.link.getSnapshot();
    const vin = snap.vehicle?.vin;
    if (this.writer && vin && vin !== this.loggedVin) {
      // Read after the header was written (e.g. on reinit): later info messages override it.
      this.loggedVin = vin;
      this.record(this.deps.nowUs(), (w) => w.info("vehicle_vin", vin));
    }
    const up = LINK_UP.includes(snap.link);
    if (up !== this.lastLinkUp) {
      this.lastLinkUp = up;
      this.detector.onLink(up, this.deps.nowUs());
      this.syncSensors();
    }
  }

  private onEngine(state: EngineState, tUs: number): void {
    this.engine = state;
    const code = ENGINE_STATE_CODES.indexOf(state);
    this.record(tUs, (w) => w.engineState(tUs, code));
    this.detector.onEngine(state, tUs);
    this.syncSensors();
  }

  private onExchange(e: ExchangeEvent): void {
    const status = Math.max(0, ELM_STATUS_CODES.indexOf(e.status));
    if (e.pollPid !== undefined) {
      const bytes = e.pollBytes ?? [];
      this.record(e.rxUs, (w) => {
        w.obd({
          timestampUs: Math.round(e.rxUs),
          latencyUs: Math.max(0, Math.round(e.rxUs - e.txUs)),
          mode: 1,
          pid: e.pollPid!,
          status,
          data: bytes,
          ecu: e.pollEcu ?? 0,
          value: e.pollValue ?? NaN,
        });
        if (e.status !== "ok") w.log("warning", LOG_TAGS.elm, e.rxUs, `tx=${Math.round(e.txUs)} ${e.command} | ${escapeRaw(e.raw)}`);
      });
      return;
    }
    this.record(e.rxUs, (w) =>
      w.log(e.status === "ok" ? "info" : "warning", LOG_TAGS.elm, e.rxUs, `tx=${Math.round(e.txUs)} ${e.command} | ${escapeRaw(e.raw)}`),
    );
  }

  private onGnss(fix: GnssRecord): void {
    if (this.writer && this.current && this.lastFix && isSatelliteFix(fix) && isSatelliteFix(this.lastFix)) {
      this.current.distanceM += haversineM(
        { lat: this.lastFix.latDeg, lon: this.lastFix.lonDeg },
        { lat: fix.latDeg, lon: fix.lonDeg },
      );
    }
    this.lastFix = fix;
    this.record(fix.timestampUs, (w) => w.gnss(fix));
  }

  // ---- recording ----

  /** Write now when recording, else keep in the pre-roll ring while the ECU is awake. */
  private record(tUs: number, write: (w: TripLogWriter) => void): void {
    if (this.writer) {
      try {
        write(this.writer);
      } catch (error) {
        this.fail(error);
      }
      return;
    }
    if (this.detector.wantsPreroll) this.preroll.push({ tUs, write });
  }

  private beginTrip(reason: StartReason, tUs: number): void {
    if (this.safeFreeBytes() < MIN_FREE_BYTES) {
      this.update({ lastError: "not enough free space (< 200 MB)" });
      return;
    }
    const id = tripId();
    const start = new Date();
    const fileName = `${fileStamp(start)}_${id}${reason === "manual" ? "_manual" : ""}.ulg`;
    const link = this.deps.link.getSnapshot();
    try {
      const sink = this.deps.files.create(fileName);
      const cutoffUs = tUs - PREROLL_US;
      let firstUs = tUs;
      for (const p of this.preroll) if (p.tUs >= cutoffUs && p.tUs < firstUs) firstUs = p.tUs;
      this.writer = new TripLogWriter(sink, {
        startUs: Math.round(firstUs),
        utcUs: Math.round(Date.now() * 1000 - (this.deps.nowUs() - firstUs)),
        info: {
          ...this.deps.appInfo(),
          trip_id: id,
          start_reason: reason,
          adapter_transport: link.adapter?.transport ?? "none",
          adapter_name: link.adapter?.name ?? "",
          adapter_elm: link.adapter?.elmVersion ?? "",
          adapter_chip: link.adapter?.chip ?? "",
          obd_protocol: link.vehicle?.protocol ?? "",
          vehicle_vin: link.vehicle?.vin ?? "",
          imu_frame: "xArbitraryZVertical",
        },
      });
    } catch (error) {
      this.fail(error);
      return;
    }
    const cutoff = tUs - PREROLL_US;
    for (const p of this.preroll) if (p.tUs >= cutoff) p.write(this.writer);
    this.preroll = [];
    this.writer.tripEvent(Math.round(tUs), TRIP_EVENTS.start);
    this.writer.engineState(Math.round(tUs), ENGINE_STATE_CODES.indexOf(this.engine));
    this.loggedVin = link.vehicle?.vin ?? "";
    this.current = { id, fileName, startedUs: tUs, startReason: reason, bytes: 0, distanceM: 0, durationS: 0 };
    const entry: TripIndexEntry = {
      id,
      fileName,
      startUtcMs: start.getTime(),
      startReason: reason,
      bytes: 0,
      distanceM: 0,
      adapterName: link.adapter?.name ?? undefined,
      complete: false,
    };
    this.saveIndex([entry, ...this.snapshot.trips]);
    this.events.emit(`trip started (${reason})`);
    this.update({ current: { ...this.current }, lastError: null });
    this.syncSensors();
  }

  private endTrip(reason: EndReason, tUs: number): void {
    const writer = this.writer;
    const current = this.current;
    this.writer = null;
    this.current = null;
    if (!writer || !current) return;
    try {
      writer.tripEvent(Math.round(tUs), TRIP_EVENTS.end, END_REASON_CODES[reason]);
      writer.close();
    } catch (error) {
      this.fail(error);
    }
    const trips = this.snapshot.trips.map((t) =>
      t.id === current.id
        ? {
            ...t,
            endUtcMs: Date.now(),
            durationS: (tUs - current.startedUs) / 1e6,
            endReason: reason,
            bytes: writer.bytesWritten,
            distanceM: current.distanceM,
            complete: true,
          }
        : t,
    );
    this.saveIndex(trips);
    this.events.emit(`trip ended (${reason})`);
    this.update({ current: null, freeBytes: this.safeFreeBytes() });
    this.syncSensors();
  }

  /** Runs every second via start(); public for tests. */
  tick(): void {
    const now = this.deps.nowUs();
    this.detector.tick(now);
    this.preroll = this.preroll.filter((p) => p.tUs >= now - PREROLL_US);
    if (!this.detector.wantsPreroll && !this.writer) this.preroll = [];
    if (!this.writer || !this.current) {
      if (this.snapshot.state !== this.detector.state) this.update({ state: this.detector.state });
      return;
    }
    const link = this.deps.link.getSnapshot();
    try {
      this.writer.linkStats({
        timestampUs: Math.round(now),
        speedHz: link.stats?.speedHz ?? 0,
        latencyP50Ms: link.stats?.latencyP50Ms ?? NaN,
        latencyP95Ms: link.stats?.latencyP95Ms ?? NaN,
        errors: link.stats?.errorsLastMinute ?? 0,
        linkState: LINK_STATE_CODES.indexOf(link.link),
        batteryV: link.adapter?.batteryV ?? NaN,
      });
      this.writer.tick(now, Date.now() * 1000);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.current.bytes = this.writer.bytesWritten;
    this.current.durationS = (now - this.current.startedUs) / 1e6;
    this.update({ state: this.detector.state, current: { ...this.current } });
  }

  private syncSensors(): void {
    const state = this.detector.state;
    const recording = state === "recording";
    const preroll = this.detector.wantsPreroll;
    // Lingering keeps GNSS on so iOS keeps the app alive between trips (§4.3).
    this.deps.sensors.want(recording || preroll || state === "lingering", recording || preroll);
    if (this.snapshot.state !== state) this.update({ state });
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.update({ lastError: message });
    this.events.emit(`recorder error: ${message}`);
    if (this.writer) this.detector.manualStop(this.deps.nowUs());
  }

  // ---- index ----

  private reconcileIndex(): TripIndexEntry[] {
    let files: { name: string; size: number }[] = [];
    try {
      files = this.deps.files.list();
    } catch {
      files = [];
    }
    const index = this.deps.store.getJson<TripIndexEntry[]>(INDEX_KEY) ?? [];
    const byName = new Map(files.map((f) => [f.name, f]));
    const known = new Set(index.map((t) => t.fileName));
    const entries: TripIndexEntry[] = index
      .filter((t) => byName.has(t.fileName))
      .map((t) => ({ ...t, bytes: byName.get(t.fileName)!.size }));
    for (const f of files) {
      if (known.has(f.name)) continue;
      const m = /^(\d{8})-(\d{6})_([a-z0-9]+)/.exec(f.name);
      const start = m
        ? Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2].slice(0, 2), +m[2].slice(2, 4), +m[2].slice(4, 6))
        : 0;
      entries.push({
        id: m?.[3] ?? f.name,
        fileName: f.name,
        startUtcMs: start,
        startReason: f.name.includes("_manual") ? "manual" : "engine",
        bytes: f.size,
        distanceM: 0,
        complete: false,
      });
    }
    entries.sort((a, b) => b.startUtcMs - a.startUtcMs);
    this.deps.store.setJson(INDEX_KEY, entries);
    return entries;
  }

  private saveIndex(trips: TripIndexEntry[]): void {
    this.deps.store.setJson(INDEX_KEY, trips);
    this.update({ trips });
  }

  private detectorConfig(s: TripSettings) {
    return {
      ...DEFAULT_TRIP_CONFIG,
      parkedTimeoutUs: s.parkedTimeoutMin * 60e6,
      linkTimeoutUs: s.linkTimeoutMin * 60e6,
      lingerUs: s.lingerMin * 60e6,
    };
  }

  private safeFreeBytes(): number {
    try {
      return this.deps.files.freeBytes();
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  private update(patch: Partial<RecorderSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }
}
