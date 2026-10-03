// Ignition / engine state machine (docs/VEHICLE-LINK-SPEC.md §10.4).

import type { EngineState } from "./types";

export interface EngineStateConfig {
  runningRpm: number;
  stoppedRpm: number;
  confirmSamples: number;
  /** Repeats of the same non-zero RPM that mark the value as stale (engine stopped). */
  staleRepeats: number;
  silenceToIgnitionOffUs: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineStateConfig = {
  runningRpm: 400,
  stoppedRpm: 250,
  confirmSamples: 2,
  staleRepeats: 2,
  silenceToIgnitionOffUs: 10_000_000,
};

export class EngineStateMachine {
  private current: EngineState = "unknown";
  private high = 0;
  private low = 0;
  private stale = 0;
  private lastRpm: number | null = null;
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

  /**
   * A running engine's RPM never repeats exactly (0.25 rpm resolution, polled seconds
   * apart), while some ECUs (Mazda CX-5) keep answering with the RPM latched at shutdown
   * when the ECU is awake but the engine is off. So a high reading only proves the engine
   * runs when it differs from the previous one, and a repeated one counts as stopped.
   */
  onRpm(rpm: number, tUs: number): void {
    this.silentSinceUs = null;
    const { runningRpm, stoppedRpm, confirmSamples, staleRepeats } = this.config;
    const repeated = rpm === this.lastRpm && rpm >= stoppedRpm;
    this.lastRpm = rpm;
    if (this.current === "unknown" || this.current === "ignition-off") {
      // The ECU is awake; a single high value may be stale, so it only starts the confirmation.
      this.set("engine-off", tUs);
      if (rpm >= runningRpm) this.high = 1;
      return;
    }
    if (repeated) {
      this.stale++;
      this.high = 0;
      if (this.stale >= staleRepeats) this.set("engine-off", tUs);
    } else if (rpm >= runningRpm) {
      this.high++;
      this.low = this.stale = 0;
      if (this.high >= confirmSamples) this.set("engine-running", tUs);
    } else if (rpm < stoppedRpm) {
      this.low++;
      this.high = this.stale = 0;
      if (this.low >= confirmSamples) this.set("engine-off", tUs);
    }
  }

  /** Speed > 0 proves the ECU is awake (hybrids may move with the engine off). */
  onSpeed(tUs: number): void {
    this.silentSinceUs = null;
    if (this.current === "unknown" || this.current === "ignition-off") this.set("engine-off", tUs);
  }

  reset(tUs: number): void {
    this.high = this.low = this.stale = 0;
    this.lastRpm = null;
    this.silentSinceUs = null;
    this.set("unknown", tUs);
  }

  private set(state: EngineState, tUs: number): void {
    if (state === this.current) return;
    this.current = state;
    this.high = this.low = this.stale = 0;
    this.onChange(state, tUs);
  }
}
