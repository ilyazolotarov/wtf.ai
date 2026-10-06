import * as Device from "expo-device";
import { Platform } from "react-native";

import type { LinkState, VehicleLinkSnapshot } from "@/obd/types";
import { kvStore } from "@/services/kv-store";

// Health and compatibility metrics for field testers (docs/ANDROID-SPEC.md §4.1). Numbers only: no positions, no VINs,
// no adapter serials. Attribute values come from a fixed set (transport, adapter model name, error code), and the
// Sentry scrubber (src/config/sentry-scrub.ts) is still the last gate. Navigation accuracy stays in the trip logs.

export type MetricAttrs = Record<string, string>;

export interface MetricSink {
  count(name: string, value: number, attrs?: MetricAttrs): void;
  gauge(name: string, value: number, attrs?: MetricAttrs): void;
  distribution(name: string, value: number, attrs?: MetricAttrs): void;
}

/** What the reporter needs from the sensor service, so it stays free of native imports. */
export interface SensorStats {
  gnssRunning: boolean;
  imuRunning: boolean;
  gnssHz: number;
  imuHz: number;
}

const CONNECTING: LinkState[] = ["connecting", "probing", "initializing", "reconnecting"];
const UP: LinkState[] = ["polling", "standby"];

/** Adapter model as the catalog knows it (chip or ELM description), never the device name or serial. */
export function adapterModel(s: VehicleLinkSnapshot): string {
  const raw = s.adapter?.chip ?? s.adapter?.description ?? "unknown";
  return raw.toLowerCase().replace(/[^a-z0-9.+ _-]/g, "").trim().slice(0, 40) || "unknown";
}

/** Turns link and sensor state changes into metrics. Pure: sink and clock are injected. */
export class TelemetryReporter {
  private prevLink: LinkState = "idle";
  private connectStartMs: number | null = null;
  private lastFlushMs: number;
  private satelliteFixes = 0;
  private coarseFixes = 0;
  private lastImuMs: number | null = null;
  private maxImuGapS = 0;

  constructor(
    private readonly sink: MetricSink,
    private readonly nowMs: () => number,
    private readonly flushEveryMs = 60_000,
  ) {
    this.lastFlushMs = nowMs();
  }

  /** Call on every link snapshot. */
  onLink(s: VehicleLinkSnapshot): void {
    const now = this.nowMs();
    const prev = this.prevLink;
    const next = s.link;
    const attrs = { transport: s.adapter?.transport ?? "unknown", adapter_model: adapterModel(s) };
    if (next !== prev) {
      if (CONNECTING.includes(next) && this.connectStartMs === null) this.connectStartMs = now;
      if (next === "reconnecting" && UP.includes(prev)) this.sink.count("link.lost", 1, attrs);
      if (UP.includes(next) && this.connectStartMs !== null) {
        this.sink.distribution("link.connect_ms", now - this.connectStartMs, attrs);
        this.connectStartMs = null;
      }
      if (next === "error") {
        if (this.connectStartMs !== null) this.sink.count("link.connect_failed", 1, { ...attrs, reason: (s.error?.code === "other" ? s.error.nativeCode : s.error?.code) ?? "unknown" });
        this.connectStartMs = null;
      }
      if (next === "idle") this.connectStartMs = null;
      this.prevLink = next;
    }
    if (next === "polling" && s.stats && now - this.lastFlushMs >= this.flushEveryMs) {
      this.sink.gauge("link.poll_rate_hz", s.stats.speedHz, attrs);
      this.sink.gauge("link.latency_p50_ms", s.stats.latencyP50Ms, attrs);
      this.sink.gauge("link.errors_last_minute", s.stats.errorsLastMinute, attrs);
    }
  }

  /** One GNSS fix: satellite fixes have a speed, coarse Wi-Fi/cell fixes do not (SPEC §3.3 item 5). */
  onGnssFix(hasSpeed: boolean): void {
    if (hasSpeed) this.satelliteFixes++;
    else this.coarseFixes++;
  }

  /** One IMU batch; `recording` = a trip is being recorded (the foreground service is meant to be running). */
  onImuBatch(recording: boolean): void {
    const now = this.nowMs();
    if (recording && this.lastImuMs !== null) this.maxImuGapS = Math.max(this.maxImuGapS, (now - this.lastImuMs) / 1000);
    this.lastImuMs = now;
  }

  /** Call on sensor state changes; emits the rates once per interval. */
  onSensors(s: SensorStats, recording: boolean): void {
    const now = this.nowMs();
    if (now - this.lastFlushMs < this.flushEveryMs) return;
    this.lastFlushMs = now;
    if (s.gnssRunning) this.sink.gauge("gnss.fix_rate_hz", s.gnssHz);
    if (s.imuRunning) this.sink.gauge("imu.rate_hz", s.imuHz);
    const fixes = this.satelliteFixes + this.coarseFixes;
    if (fixes > 0) this.sink.gauge("gnss.satellite_share", this.satelliteFixes / fixes);
    // The longest hole in IMU data while recording: with the screen off it shows whether Android held the sensors.
    if (recording && this.lastImuMs !== null) this.sink.gauge("service.foreground_gap_s", this.maxImuGapS);
    this.satelliteFixes = 0;
    this.coarseFixes = 0;
    this.maxImuGapS = 0;
  }
}

/** A random id for this install: lets a tester quote it so their reports can be found (Settings shows it). */
export function installId(): string {
  const KEY = "telemetry.installId";
  const existing = kvStore.getJson<string>(KEY);
  if (existing) return existing;
  const id = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  kvStore.setJson(KEY, id);
  return id;
}

/** Tags attached to every Sentry event and metric: which phone, which Android, which build. */
export function deviceTags(): Record<string, string> {
  return {
    os: Platform.OS,
    os_version: Device.osVersion ?? "unknown",
    sdk_int: String(Device.platformApiLevel ?? ""),
    device_manufacturer: Device.manufacturer ?? "unknown",
    device_model: Device.modelName ?? "unknown",
    build_sha: (process.env.EXPO_PUBLIC_BUILD_SHA ?? "dev").slice(0, 7),
    install_id: installId(),
  };
}

/** Sentry's environment: emulator runs (CI) never mix with testers' phones. */
export function sentryEnvironment(): string {
  if (!Device.isDevice && process.env.EXPO_PUBLIC_E2E === "1") return "ci";
  return __DEV__ ? "development" : "production";
}
