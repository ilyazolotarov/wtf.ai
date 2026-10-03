// Ignition / engine state machine (docs/VEHICLE-LINK-SPEC.md §10.4).

import type { EngineState } from "./types";

export interface EngineStateConfig {
  runningRpm: number;
  stoppedRpm: number;
  confirmSamples: number;
  silenceToIgnitionOffUs: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineStateConfig = {
  runningRpm: 400,
  stoppedRpm: 250,
  confirmSamples: 2,
  silenceToIgnitionOffUs: 10_000_000,
};

export class EngineStateMachine {
  private current: EngineState = "unknown";
  private high = 0;
  private low = 0;
  /** Start of the current run of invalid responses. */
  private silentSinceUs: number | null = null;

  constructor(
    private readonly onChange: (state: EngineState, tUs: number) => void,
    private readonly config: EngineStateConfig = DEFAULT_ENGINE_CONFIG,
  ) {}

  get state(): EngineState {
    return this.current;
  }

  /** Every OBD (non-AT) exchange: valid = the ECU answered. */
  onObdResponse(valid: boolean, tUs: number): void {
    if (valid) {
      this.silentSinceUs = null;
      return;
    }
    if (this.silentSinceUs === null) this.silentSinceUs = tUs;
    if (tUs - this.silentSinceUs >= this.config.silenceToIgnitionOffUs) this.set("ignition-off", tUs);
  }

  onRpm(rpm: number, tUs: number): void {
    this.silentSinceUs = null;
    const { runningRpm, stoppedRpm, confirmSamples } = this.config;
    if (this.current === "unknown" || this.current === "ignition-off") {
      this.high = this.low = 0;
      this.set(rpm >= runningRpm ? "engine-running" : "engine-off", tUs);
      return;
    }
    if (rpm >= runningRpm) {
      this.high++;
      this.low = 0;
      if (this.high >= confirmSamples) this.set("engine-running", tUs);
    } else if (rpm < stoppedRpm) {
      this.low++;
      this.high = 0;
      if (this.low >= confirmSamples) this.set("engine-off", tUs);
    }
  }

  /** Speed > 0 proves the ECU is awake (hybrids may move with the engine off). */
  onSpeed(tUs: number): void {
    this.silentSinceUs = null;
    if (this.current === "unknown" || this.current === "ignition-off") this.set("engine-off", tUs);
  }

  reset(tUs: number): void {
    this.high = this.low = 0;
    this.silentSinceUs = null;
    this.set("unknown", tUs);
  }

  private set(state: EngineState, tUs: number): void {
    if (state === this.current) return;
    this.current = state;
    this.high = this.low = 0;
    this.onChange(state, tUs);
  }
}
