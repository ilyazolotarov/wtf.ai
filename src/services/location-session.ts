// When the iOS background location session is held (docs/TRIP-LOGGER-SPEC.md §4.3). Only one started while the app
// is in front counts, so it is held from every time the app is in front, whatever is connected: a trip that starts
// once the driver has switched away (the adapter connecting with the engine) can then start GNSS, and iOS can relaunch
// the app if it ends it. Let go 30 min after the app left the screen with nothing going on: the indicator shows
// while it is held. With location "Always" GNSS starts from the background without it: let go as soon as the app
// leaves the screen with nothing going on, and at a start in the background (iOS relaunched the app, which joined a
// session the run before held) as soon as JS runs.

export const RELEASE_AFTER_LEAVING_MS = 30 * 60_000;

export interface LocationSessionDeps {
  /** Resolves true while held (false on Android, or without location permission). */
  set(on: boolean): Promise<boolean>;
  /** Location "Always": GNSS may start from the background without the session. */
  always(): Promise<boolean>;
  appState(): string;
  onAppState(listener: (state: string) => void): () => void;
  /** A trip records or lingers, or the ECU is awake: GNSS may be wanted any moment. */
  busy(): boolean;
  onBusy(listener: () => void): () => void;
  note(text: string): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class LocationSession {
  private held = false;
  private always = false;
  private releaseTimer: unknown = null;
  private unsubscribers: (() => void)[] = [];

  constructor(private readonly deps: LocationSessionDeps) {}

  start(): void {
    this.unsubscribers.push(
      this.deps.onAppState(() => this.sync()),
      this.deps.onBusy(() => this.sync()),
    );
    const background = this.deps.appState() !== "active";
    void this.readAlways().then(() => {
      // A session the app joined at a background launch (AppHealthAppDelegate) shows the indicator for nothing.
      if (!background || !this.always || this.deps.appState() === "active" || this.deps.busy()) return;
      void this.deps.set(false).catch(() => false);
      this.deps.note("location session let go: started in the background with nothing going on (location Always)");
    });
    this.sync();
  }

  stop(): void {
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers = [];
    this.cancelRelease();
  }

  private async readAlways(): Promise<void> {
    this.always = await this.deps.always().catch(() => false);
  }

  private sync(): void {
    if (this.deps.appState() === "active") {
      this.cancelRelease();
      void this.hold();
      return;
    }
    if (this.deps.busy()) this.cancelRelease();
    else if (this.held && this.releaseTimer === null) {
      this.releaseTimer = this.deps.setTimeout(() => this.release(), this.always ? 0 : RELEASE_AFTER_LEAVING_MS);
    }
  }

  private async hold(): Promise<void> {
    // Permission changes are made in Settings, away from the app: read again each time it is in front.
    await this.readAlways();
    const held = await this.deps.set(true).catch(() => false);
    if (held && !this.held) this.deps.note("location session held");
    this.held = held;
    // Left the screen while the calls were out: the release counts from now.
    if (this.deps.appState() !== "active") this.sync();
  }

  private release(): void {
    this.releaseTimer = null;
    if (this.deps.appState() === "active" || this.deps.busy()) return;
    this.held = false;
    void this.deps.set(false).catch(() => false);
    this.deps.note(
      this.always
        ? "location session let go: away from the app with no trip (location Always)"
        : `location session let go: ${RELEASE_AFTER_LEAVING_MS / 60_000} min away with no trip`,
    );
  }

  private cancelRelease(): void {
    if (this.releaseTimer !== null) this.deps.clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }
}
