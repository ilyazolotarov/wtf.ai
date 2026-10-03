// Trip start/end state machine (docs/TRIP-LOGGER-SPEC.md §4). Pure TS; the
// trip-recorder service feeds it link/engine/speed events and a 1 s tick.

import type { EngineState } from "../obd/types";
import type { EndReason } from "./schema";

export type RecorderState = "idle" | "armed" | "recording" | "lingering";
export type StartReason = "engine" | "speed" | "manual";

export interface TripDetectorConfig {
  speedStartSamples: number;
  parkedTimeoutUs: number;
  linkTimeoutUs: number;
  lingerUs: number;
}

export const DEFAULT_TRIP_CONFIG: TripDetectorConfig = {
  speedStartSamples: 2,
  parkedTimeoutUs: 5 * 60_000_000,
  linkTimeoutUs: 2 * 60_000_000,
  lingerUs: 15 * 60_000_000,
};

export interface TripDetectorHooks {
  onStart(reason: StartReason, tUs: number): void;
  onEnd(reason: EndReason, tUs: number): void;
  onState(state: RecorderState, tUs: number): void;
}

export class TripDetector {
  private current: RecorderState = "idle";
  private linkUp = false;
  private engine: EngineState = "unknown";
  private movingSamples = 0;
  private parkedSinceUs: number | null = null;
  private linkLostSinceUs: number | null = null;
  private lingerSinceUs: number | null = null;
  private manual = false;

  constructor(
    private readonly hooks: TripDetectorHooks,
    public config: TripDetectorConfig = DEFAULT_TRIP_CONFIG,
  ) {}

  get state(): RecorderState {
    return this.current;
  }

  get isManual(): boolean {
    return this.manual;
  }

  /** The ECU is awake → sensors should fill the pre-roll buffer. */
  get wantsPreroll(): boolean {
    return (this.current === "armed" || this.current === "lingering") && (this.engine === "engine-off" || this.engine === "engine-running");
  }

  /** Adapter usable (standby/polling) vs not connected or reconnecting. */
  onLink(up: boolean, tUs: number): void {
    if (up === this.linkUp) return;
    this.linkUp = up;
    if (this.current === "recording") {
      this.linkLostSinceUs = up ? null : tUs;
      return;
    }
    if (this.current === "idle" && up) this.set("armed", tUs);
    else if (this.current === "armed" && !up) this.set("idle", tUs);
  }

  onEngine(state: EngineState, tUs: number): void {
    this.engine = state;
    if (this.current === "recording" && !this.manual) {
      if (state === "ignition-off") {
        this.end("ignition-off", tUs);
        return;
      }
      if (state === "engine-running") this.parkedSinceUs = null;
      else if (state === "engine-off" && this.movingSamples === 0) this.parkedSinceUs ??= tUs;
      return;
    }
    if ((this.current === "armed" || this.current === "lingering") && state === "engine-running") {
      this.start("engine", tUs);
    }
  }

  /** Every OBD speed sample (km/h raw). */
  onSpeed(rawKph: number, tUs: number): void {
    if (rawKph > 0) this.movingSamples++;
    else this.movingSamples = 0;

    if (this.current === "recording") {
      if (rawKph > 0) this.parkedSinceUs = null;
      else if (this.engine !== "engine-running") this.parkedSinceUs ??= tUs;
      return;
    }
    if ((this.current === "armed" || this.current === "lingering") && this.movingSamples >= this.config.speedStartSamples) {
      this.start("speed", tUs);
    }
  }

  tick(tUs: number): void {
    if (this.current === "recording" && !this.manual) {
      if (this.parkedSinceUs !== null && tUs - this.parkedSinceUs >= this.config.parkedTimeoutUs) {
        this.end("parked-timeout", tUs);
      } else if (this.linkLostSinceUs !== null && tUs - this.linkLostSinceUs >= this.config.linkTimeoutUs) {
        this.end("link-timeout", tUs);
      }
    } else if (this.current === "lingering" && this.lingerSinceUs !== null && tUs - this.lingerSinceUs >= this.config.lingerUs) {
      this.set(this.linkUp ? "armed" : "idle", tUs);
    }
  }

  manualStart(tUs: number): void {
    if (this.current === "recording") return;
    this.manual = true;
    this.begin("manual", tUs);
  }

  manualStop(tUs: number): void {
    if (this.current === "recording") this.end("manual", tUs);
  }

  private start(reason: StartReason, tUs: number): void {
    this.manual = false;
    this.begin(reason, tUs);
  }

  private begin(reason: StartReason, tUs: number): void {
    this.parkedSinceUs = null;
    this.linkLostSinceUs = this.linkUp || reason === "manual" ? null : tUs;
    this.set("recording", tUs);
    this.hooks.onStart(reason, tUs);
  }

  private end(reason: EndReason, tUs: number): void {
    this.manual = false;
    this.parkedSinceUs = null;
    this.linkLostSinceUs = null;
    this.lingerSinceUs = tUs;
    this.hooks.onEnd(reason, tUs);
    this.set("lingering", tUs);
  }

  private set(state: RecorderState, tUs: number): void {
    if (state === this.current) return;
    this.current = state;
    if (state !== "lingering") this.lingerSinceUs = null;
    this.hooks.onState(state, tUs);
  }
}
