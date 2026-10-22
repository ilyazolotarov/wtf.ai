// Sharing the car's position with other navigators (docs/ANDROID-SPEC.md §8). While the setting is on and a trip with
// the car records, the fused location provider is in mock mode and gets the map's dot about once a second
// (`shareDecision` says what); Waze and Google Maps read it as the phone's location. Android only.

import type { ReadBack, ShareSetup, SharedFixPayload } from "../../../modules/position-share/src/PositionShareModule";
import { haversineM } from "@/nav/geo";
import {
  GpsTakeoverPolicy,
  SHARE_MIN_INTERVAL_MS,
  shareDecision,
  type GpsTakeoverState,
  type ShareHold,
} from "@/nav/position/share";
import type { PositionEstimate } from "@/nav/position/types";

/** The native module's calls this service makes (modules/position-share). */
export interface PositionShareNative {
  getSetup(): ShareSetup;
  start(): Promise<void>;
  publish(fix: SharedFixPayload): boolean;
  /** Absent in builds before the gps takeover: Google Maps only. */
  setGpsTakeover?(on: boolean): string | null;
  stop(): Promise<void>;
  readBack(): Promise<ReadBack | null>;
  addListener(event: "onShareError", listener: (e: { code: string; message: string }) => void): { remove(): void };
}

export type ShareState =
  /** The setting is off. */
  | "off"
  /** Not Android, or a build without the module. */
  | "unavailable"
  /** The phone isn't set up for it (`setup` says what is missing). */
  | "setup"
  /** Set up: shares during the next trip with the car. */
  | "ready"
  | "starting"
  | "sharing"
  /** A trip, but nothing is shared now (`hold` says why). */
  | "holding"
  /** The fused provider refused (`error`); tried again at the next trip, or when the driver comes back to the app. */
  | "failed";

/**
 * What the trip notification says about sharing; null: the trip's own words. `car`: GPS isn't trusted, so the other
 * apps' position is the car's dead reckoning.
 */
export type ShareNotice = "gps" | "car" | "uncertain" | "waiting" | "failed";

export interface ShareSnapshot {
  enabled: boolean;
  state: ShareState;
  setup: ShareSetup | null;
  hold: ShareHold | null;
  error: string | null;
  /** The last fix shared: wall clock, ms, and its radius. */
  last: { atMs: number; accuracyM: number } | null;
  /** Whose fixes the platform gps provider gives (Waze reads it): the phone's, wtf.ai's, or a probe of the phone's. */
  gps: GpsTakeoverState;
}

export interface PositionShareDeps {
  native: PositionShareNative | null;
  position: { getSnapshot(): PositionEstimate | null; subscribe(listener: () => void): () => void };
  /** A trip with the car is recording (started by the car, or with the adapter connected). */
  trip: { active(): boolean; subscribe(listener: () => void): () => void };
  /** The setting (Settings → Other navigators). */
  enabled: { get(): boolean; subscribe(listener: () => void): () => void };
  /** Puts the notice on the trip notification; false when it isn't showing (no trip service yet): tried again. */
  notify(notice: ShareNotice | null): boolean;
  /** For the trip log. */
  note(text: string): void;
  nowMs(): number;
}

/** What `verify` found: the other apps get the fix shared last, something else, or nothing. */
export type ShareCheck = "ok" | "other" | "none";

/** A read-back this close to the last fix shared, and this fresh, is that fix. */
const VERIFY_NEAR_M = 1;
const VERIFY_FRESH_MS = 5_000;

export class PositionShareService {
  private readonly deps: PositionShareDeps;
  private snapshot: ShareSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: (() => void)[] = [];
  /** Mock mode is on (started, not stopped since). */
  private running = false;
  /** A start or stop in flight; `dirty`: something changed meanwhile, decide again after it. */
  private busy = false;
  private dirty = false;
  /** Failed at this trip: not tried again until the next one, the setting turned on, or `recheck`. */
  private blocked = false;
  private tripActive = false;
  private lastPosition: PositionEstimate | null = null;
  private lastSentMs = -Infinity;
  private lastFix: SharedFixPayload | null = null;
  /** A hold went into the trip log, so the next fix shared is noted as resumed. */
  private holdNoted = false;
  /** When the platform gps provider is wtf.ai's (for Waze); `gpsTaken`: it is now. */
  private takeover = new GpsTakeoverPolicy();
  private gpsTaken = false;
  /** The takeover failed this trip: Google Maps only until the next. */
  private gpsBlocked = false;
  private shownNotice: ShareNotice | null = null;

  constructor(deps: PositionShareDeps) {
    this.deps = deps;
    const enabled = deps.enabled.get();
    this.snapshot = { enabled, state: "off", setup: this.readSetup(), hold: null, error: null, last: null, gps: "real" };
    this.tripActive = deps.trip.active();
    this.unsubscribers.push(
      deps.position.subscribe(() => this.onPosition()),
      deps.trip.subscribe(() => this.onTrip()),
      deps.enabled.subscribe(() => this.onEnabled()),
    );
    const sub = deps.native?.addListener("onShareError", (e) => this.onNativeError(e.code, e.message));
    if (sub) this.unsubscribers.push(() => sub.remove());
    this.sync();
  }

  getSnapshot = (): ShareSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The phone's setup again (the driver may have changed it in Android's settings), and another try after a failure. */
  recheck(): void {
    this.blocked = false;
    this.update({ setup: this.readSetup() });
    this.sync();
  }

  /** Whether the other apps get the fix shared last (the fused provider's last location, read back). */
  async verify(): Promise<ShareCheck> {
    const native = this.deps.native;
    const sent = this.lastFix;
    if (!native || !this.running || !sent) return "none";
    const back = await native.readBack().catch(() => null);
    if (!back) return "none";
    const near = haversineM(back, sent) <= VERIFY_NEAR_M;
    return back.mock && near && back.ageMs <= VERIFY_FRESH_MS ? "ok" : "other";
  }

  dispose(): void {
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers.length = 0;
    if (this.running) void this.deps.native?.stop().catch(() => undefined);
    this.running = false;
  }

  // ---- decisions ----

  private readSetup(): ShareSetup | null {
    try {
      return this.deps.native?.getSetup() ?? null;
    } catch {
      return null;
    }
  }

  private ready(setup: ShareSetup | null): boolean {
    return !!setup && setup.mockLocationApp && setup.playServices;
  }

  /** Mock mode should be on now. */
  private wanted(): boolean {
    return this.snapshot.enabled && this.tripActive && !this.blocked && this.ready(this.snapshot.setup);
  }

  /** The state while not sharing, from the setting, the setup and the trip. */
  private idleState(): ShareState {
    if (!this.deps.native) return "unavailable";
    if (!this.snapshot.enabled) return "off";
    if (this.blocked) return "failed";
    return this.ready(this.snapshot.setup) ? "ready" : "setup";
  }

  private onEnabled(): void {
    const enabled = this.deps.enabled.get();
    if (enabled === this.snapshot.enabled) return;
    if (enabled) this.blocked = false;
    this.update({ enabled, setup: this.readSetup(), error: enabled ? null : this.snapshot.error });
    this.sync();
  }

  private onTrip(): void {
    const active = this.deps.trip.active();
    if (active === this.tripActive) return;
    this.tripActive = active;
    if (active) {
      // A new trip tries again, with the phone's setup as it is now.
      this.blocked = false;
      this.update({ setup: this.readSetup(), error: null });
    }
    this.sync();
  }

  private onNativeError(code: string, message: string): void {
    if (!this.running) return;
    if (code === "gps-failed") {
      // Waze loses wtf.ai's fixes for this trip; Google Maps keeps them.
      this.blockGps(message);
      return;
    }
    this.deps.note(`position share failed: ${code} ${message}`);
    this.blocked = true;
    this.update({ error: message, setup: this.readSetup() });
    this.sync();
  }

  /** Starts or stops mock mode to match `wanted`, one change at a time. */
  private sync(): void {
    if (this.busy) {
      this.dirty = true;
      return;
    }
    const want = this.wanted();
    if (want === this.running) {
      if (!this.running) this.update({ state: this.idleState(), hold: null });
      this.showNotice();
      return;
    }
    this.busy = true;
    const done = () => {
      this.busy = false;
      if (this.dirty) {
        this.dirty = false;
        this.sync();
      } else this.showNotice();
    };
    if (want) void this.start().finally(done);
    else void this.stop().finally(done);
  }

  private async start(): Promise<void> {
    const native = this.deps.native!;
    this.update({ state: "starting", error: null });
    try {
      await native.start();
      this.running = true;
      this.lastPosition = null;
      this.lastSentMs = -Infinity;
      this.holdNoted = false;
      this.takeover = new GpsTakeoverPolicy();
      this.gpsTaken = false;
      this.gpsBlocked = false;
      this.update({ state: "holding", hold: "none" });
      this.deps.note("position share on");
      this.dirty = true;
    } catch (e) {
      const code = (e as { code?: string }).code ?? "start-failed";
      const message = e instanceof Error ? e.message : String(e);
      this.deps.note(`position share failed: ${code} ${message}`);
      this.blocked = true;
      this.update({ state: "failed", error: message, setup: this.readSetup() });
    }
  }

  private async stop(): Promise<void> {
    this.running = false;
    this.lastFix = null;
    // The native stop gives the gps provider back too.
    this.gpsTaken = false;
    try {
      await this.deps.native!.stop();
    } catch {
      // Mock mode is also turned off when the app starts next (the module's OnCreate).
    }
    this.deps.note("position share off");
    this.update({ state: this.idleState(), hold: null, last: null, gps: "real" });
  }

  // ---- sharing ----

  private onPosition(): void {
    if (!this.running || this.busy) {
      // Not sharing during a trip (not set up, refused): the notification still has to say so once it shows.
      this.showNotice();
      return;
    }
    const p = this.deps.position.getSnapshot();
    if (p === this.lastPosition) return;
    const now = this.deps.nowMs();
    const decision = shareDecision(p, this.snapshot.hold);
    this.syncGps(now, p, !!decision.fix);
    if (decision.fix) {
      // Each published position goes out once, at most about once a second: never one invented in between.
      if (now - this.lastSentMs < SHARE_MIN_INTERVAL_MS) return;
      this.lastPosition = p;
      if (!this.deps.native!.publish(decision.fix)) return;
      // Resumed after a hold the log has; the first fix of a trip only ends the wait for one.
      if (this.holdNoted) this.deps.note("position share resumed");
      this.holdNoted = false;
      this.lastSentMs = now;
      this.lastFix = decision.fix;
      this.update({ state: "sharing", hold: null, last: { atMs: now, accuracyM: decision.fix.accuracyM } });
    } else {
      this.lastPosition = p;
      if (decision.hold !== this.snapshot.hold) {
        this.deps.note(`position share hold: ${decision.hold}`);
        this.holdNoted = true;
      }
      this.update({ state: "holding", hold: decision.hold });
    }
    this.showNotice();
  }

  /**
   * The platform gps provider wtf.ai's while GPS isn't trusted (`GpsTakeoverPolicy`): Waze reads it directly. Given
   * back for probes and once GPS is trusted again.
   */
  private syncGps(now: number, p: PositionEstimate | null, sharing: boolean): void {
    const native = this.deps.native!;
    if (this.gpsBlocked || !native.setGpsTakeover) return;
    const before = this.takeover.state;
    const sat = p?.satelliteFix;
    const fix = p && sat ? { at: sat.timestamp, offM: haversineM(sat, p), radiusM: p.accuracyM } : null;
    const want = this.takeover.update(now, p?.trust ?? "NO_FIX", sharing, fix);
    if (this.takeover.state !== before) {
      const off = this.takeover.spoofedOffM;
      const spoofed = before === "probing" && off !== null;
      const why = spoofed ? `: a fix ${(off / 1000).toFixed(1)} km off, next probe in ${this.takeover.probeEveryMs / 60_000} min` : "";
      this.deps.note(`position share gps ${this.takeover.state}${why}`);
    }
    if (want !== this.gpsTaken) {
      const error = native.setGpsTakeover(want);
      if (error) return this.blockGps(error);
      this.gpsTaken = want;
    }
    this.update({ gps: this.takeover.state });
  }

  private blockGps(reason: string): void {
    this.gpsBlocked = true;
    this.deps.note(`position share gps failed: ${reason}`);
    if (this.gpsTaken) this.deps.native!.setGpsTakeover?.(false);
    this.gpsTaken = false;
    this.update({ gps: "real" });
  }

  /** The trip notification's words for the state now; shown again until the notification takes them. */
  private showNotice(): void {
    const wanted = this.notice();
    if (wanted === this.shownNotice) return;
    // Without a trip the service has stopped: the next one starts with its own words.
    if (this.deps.notify(wanted) || wanted === null || !this.tripActive) this.shownNotice = wanted;
  }

  private notice(): ShareNotice | null {
    const s = this.snapshot;
    if (!s.enabled || !this.tripActive || s.state === "unavailable") return null;
    if (s.state === "sharing") return this.deps.position.getSnapshot()?.trust === "TRUSTED" ? "gps" : "car";
    if (s.state === "holding") return s.hold === "uncertain" ? "uncertain" : "waiting";
    if (s.state === "starting") return "waiting";
    // Not set up, or refused: the driver learns it now, not at the next turn Waze gets wrong.
    return "failed";
  }

  private update(patch: Partial<ShareSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    const changed = (Object.keys(patch) as (keyof ShareSnapshot)[]).some((k) => next[k] !== this.snapshot[k]);
    if (!changed) return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
}
