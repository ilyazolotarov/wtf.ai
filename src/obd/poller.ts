// Speed/RPM scheduler (docs/VEHICLE-LINK-SPEC.md §10).

import type { Clock } from "./clock";
import type { Elm327Session } from "./elm327/session";
import { Priority } from "./elm327/session";
import { parseMode01, parseVoltage } from "./elm327/parser";
import type { EngineStateMachine } from "./engine-state";
import { decodePid, PID_BYTES, PID_RPM, PID_SPEED } from "./pids";
import { PollStatsTracker } from "./poll-stats";
import type { ElmResponse, ElmStatus, EngineState, RpmSample, SpeedSample } from "./types";

export interface PollerConfig {
  speedCommand: string;
  rpmCommand: string;
  /** Speed cap; back-to-back below it. 50 Hz safety ceiling by default (§10.2). */
  maxSpeedHz: number;
  rpmPeriodRunningMs: number;
  rpmPeriodEngineOffMs: number;
  rpmPeriodIgnitionOffMs: number;
  batteryPeriodMs: number;
  pollTimeoutMs: number;
}

export const SAFETY_CEILING_HZ = 50;

export const DEFAULT_POLLER_CONFIG: PollerConfig = {
  speedCommand: "010D",
  rpmCommand: "010C",
  maxSpeedHz: SAFETY_CEILING_HZ,
  rpmPeriodRunningMs: 5000,
  rpmPeriodEngineOffMs: 2000,
  rpmPeriodIgnitionOffMs: 5000,
  batteryPeriodMs: 30000,
  pollTimeoutMs: 1000,
};

export interface PollerHooks {
  onSpeed(s: SpeedSample): void;
  onRpm(s: RpmSample): void;
  onBattery(volts: number, tUs: number): void;
  /** Adapter stopped answering or reset itself: the owner must re-init (§10.5). */
  onNeedsReinit(reason: string): void;
}

export interface PollOutcome {
  pid: number;
  status: ElmStatus;
  bytes: number[] | null;
  ecu: number | null;
  value: number;
}

/** Interpret a Mode 01 poll response; shared by the poller and the logger. */
export function interpretPoll(response: ElmResponse): PollOutcome | null {
  const m = /^01([0-9A-F]{2})[0-9A-F]?$/i.exec(response.command.replace(/\s+/g, ""));
  if (!m) return null;
  const pid = parseInt(m[1], 16);
  const count = PID_BYTES[pid];
  if (count === undefined) return null;
  if (response.status !== "ok") return { pid, status: response.status, bytes: null, ecu: null, value: NaN };
  const answers = parseMode01(response.lines, pid, count);
  if (answers.length === 0) return { pid, status: "parse-error", bytes: null, ecu: null, value: NaN };
  const first = answers[0];
  return { pid, status: "ok", bytes: first.bytes, ecu: first.ecu, value: decodePid(pid, first.bytes) };
}

export class ObdPoller {
  readonly stats: PollStatsTracker;
  private running = false;
  private loop: Promise<void> | null = null;
  private config: PollerConfig;
  private consecutiveTimeouts = 0;
  private speedWorked = false;

  constructor(
    private readonly session: Elm327Session,
    private readonly clock: Clock,
    private readonly engine: EngineStateMachine,
    config: Partial<PollerConfig>,
    private readonly hooks: PollerHooks,
  ) {
    this.config = { ...DEFAULT_POLLER_CONFIG, ...config };
    this.stats = new PollStatsTracker(this.effectiveCap());
  }

  get isRunning(): boolean {
    return this.running;
  }

  setSpeedCap(hz: number | null): void {
    this.config.maxSpeedHz = hz ?? SAFETY_CEILING_HZ;
    this.stats.capHz = this.effectiveCap();
  }

  setRpmPeriods(periods: Partial<Pick<PollerConfig, "rpmPeriodRunningMs" | "rpmPeriodEngineOffMs" | "rpmPeriodIgnitionOffMs">>): void {
    this.config = { ...this.config, ...periods };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run().catch((error) => {
      this.running = false;
      if (!this.session.isClosed) this.hooks.onNeedsReinit(`poller failed: ${String(error)}`);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    this.loop = null;
  }

  private effectiveCap(): number {
    return Math.min(this.config.maxSpeedHz, SAFETY_CEILING_HZ);
  }

  private rpmPeriodMs(state: EngineState): number {
    switch (state) {
      case "engine-running":
        return this.config.rpmPeriodRunningMs;
      case "engine-off":
      case "unknown":
        return this.config.rpmPeriodEngineOffMs;
      case "ignition-off":
        return this.config.rpmPeriodIgnitionOffMs;
    }
  }

  private async run(): Promise<void> {
    let nextRpmUs = this.clock.nowUs();
    let nextBatteryUs = this.clock.nowUs() + this.config.batteryPeriodMs * 1000;
    let lastSpeedTxUs = -Infinity;

    while (this.running) {
      const now = this.clock.nowUs();
      const state = this.engine.state;
      const speedActive = state === "engine-running" || state === "engine-off";

      if (now >= nextRpmUs) {
        await this.pollRpm();
        nextRpmUs = this.clock.nowUs() + this.rpmPeriodMs(this.engine.state) * 1000;
        continue;
      }
      if (now >= nextBatteryUs) {
        await this.readBattery();
        nextBatteryUs = this.clock.nowUs() + this.config.batteryPeriodMs * 1000;
        continue;
      }
      if (!speedActive) {
        this.stats.pause();
        const waitUs = Math.min(nextRpmUs, nextBatteryUs) - now;
        await this.clock.sleep(Math.max(1, waitUs / 1000));
        continue;
      }
      const minGapUs = 1e6 / this.effectiveCap();
      const waitUs = Math.min(lastSpeedTxUs + minGapUs - now, nextRpmUs - now);
      if (waitUs > 0) {
        await this.clock.sleep(waitUs / 1000);
        continue;
      }
      lastSpeedTxUs = this.clock.nowUs();
      await this.pollSpeed();
    }
  }

  private async poll(command: string, priority: Priority): Promise<{ r: ElmResponse; o: PollOutcome | null } | null> {
    if (!this.running) return null;
    const r = await this.session.send(command, { priority, timeoutMs: this.config.pollTimeoutMs });
    const o = interpretPoll(r);
    const valid = o?.status === "ok";
    this.engine.onObdResponse(valid, r.rxUs);
    this.trackHealth(r, command);
    return { r, o };
  }

  private trackHealth(r: ElmResponse, command: string): void {
    if (r.status === "timeout") {
      if (++this.consecutiveTimeouts >= 3) {
        this.consecutiveTimeouts = 0;
        this.hooks.onNeedsReinit("adapter stopped answering");
      }
      return;
    }
    this.consecutiveTimeouts = 0;
    if (r.status === "unknown-command" && command === this.config.speedCommand && this.speedWorked) {
      this.hooks.onNeedsReinit("adapter reset (poll command rejected)");
    }
  }

  private async pollSpeed(): Promise<void> {
    const res = await this.poll(this.config.speedCommand, Priority.Speed);
    if (!res) return;
    const { r, o } = res;
    const ok = o?.status === "ok" && o.pid === PID_SPEED;
    this.stats.onSpeedPoll(r.rxUs, r.rxUs - r.txUs, ok);
    if (!ok || !o?.bytes) return;
    this.speedWorked = true;
    const sample: SpeedSample = {
      txUs: r.txUs,
      rxUs: r.rxUs,
      tUs: (r.txUs + r.rxUs) / 2,
      speedMps: o.value,
      raw: o.bytes[0],
    };
    if (sample.raw > 0) this.engine.onSpeed(sample.tUs);
    this.hooks.onSpeed(sample);
  }

  private async pollRpm(): Promise<void> {
    const res = await this.poll(this.config.rpmCommand, Priority.Rpm);
    if (!res) return;
    const { r, o } = res;
    if (o?.status !== "ok" || o.pid !== PID_RPM || !o.bytes) {
      if (r.status !== "ok" && r.status !== "no-data" && r.status !== "unable-to-connect") this.stats.onError(r.rxUs);
      return;
    }
    const sample: RpmSample = {
      txUs: r.txUs,
      rxUs: r.rxUs,
      tUs: (r.txUs + r.rxUs) / 2,
      rpm: o.value,
      raw: [o.bytes[0], o.bytes[1]],
    };
    this.engine.onRpm(sample.rpm, sample.tUs);
    this.hooks.onRpm(sample);
  }

  private async readBattery(): Promise<void> {
    if (!this.running) return;
    const r = await this.session.send("ATRV", { priority: Priority.Rpm, timeoutMs: 1000 });
    const v = r.status === "ok" ? parseVoltage(r.lines) : null;
    if (v !== null) this.hooks.onBattery(v, r.rxUs);
  }
}
