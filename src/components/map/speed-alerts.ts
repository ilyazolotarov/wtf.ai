import type { Strings } from "@/i18n/en";
import type { PositionEstimate } from "@/nav/position/types";
import { SpeedWarning } from "@/nav/speed/speed-warning";
import type { SpeedPreferences } from "@/services/speed-preferences";

import { formatDistance, type Lang } from "../status/format-geo";

// The speed, the limit's sign and the speed camera ahead, and their warnings (UI-SPEC §6.4, §6.5), once for every
// screen that shows them: the phone's map and the car's (Android Auto). One red state, one chime, one "Speed camera
// ahead" per camera however many screens show it; it runs while any of them does (`retain`).

export interface SpeedShown {
  /** The speed as the map shows it, km/h. */
  speedKph: number | undefined;
  /** The limit's sign, when there is one to stand behind. */
  limitKph: number | undefined;
  /** Over the limit by more than the driver's margin: the speed shows red. */
  over: boolean;
}

export interface CameraShown {
  /** The camera (`CameraAhead.id`). */
  id: number;
  distanceM: number;
  /** How much of the way from where the card first showed is driven, 0–1: its bar. */
  progress: number;
  /** At the camera; absent: none known (no sign, never red). */
  limitKph?: number;
  /** Over the camera's limit by more than the driver's margin: the card shows red, "Slow down". */
  slowDown: boolean;
}

export interface SpeedAlertsSnapshot {
  speed: SpeedShown;
  /** Null: none ahead, or the warnings are off in Settings. */
  camera: CameraShown | null;
}

interface Source<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export interface SpeedAlertsDeps {
  position: Source<PositionEstimate | null>;
  preferences: Source<SpeedPreferences>;
  /** The voice muted or at 0: no chime, no words (noted as silent). */
  silent(): boolean;
  note(text: string): void;
  /** The speed warning's chime. */
  chime(): void;
  /** "Speed camera ahead", and "Slow down" when `slowDown`. */
  sayCamera(slowDown: boolean): void;
  /** Wall clock, ms. */
  nowMs(): number;
}

/**
 * The voice speaks of a camera again only after it was off the card this long, so a camera lost for a moment and found
 * isn't news, nor one on the card for minutes (a car standing before it; a passed one isn't shown again sooner either,
 * CameraAlert).
 */
export const SAY_AGAIN_MS = 120_000;

const NO_SPEED: SpeedShown = { speedKph: undefined, limitKph: undefined, over: false };

const sameSpeed = (a: SpeedShown, b: SpeedShown) => a.speedKph === b.speedKph && a.limitKph === b.limitKph && a.over === b.over;
const sameCamera = (a: CameraShown | null, b: CameraShown | null) =>
  a === b ||
  (a != null &&
    b != null &&
    a.id === b.id &&
    a.distanceM === b.distanceM &&
    a.progress === b.progress &&
    a.limitKph === b.limitKph &&
    a.slowDown === b.slowDown);

export class SpeedAlerts {
  private retained = 0;
  private stop: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: SpeedAlertsSnapshot = { speed: NO_SPEED, camera: null };
  /** Too fast for the road's limit: the speed's red and its chime. */
  private readonly speedWarning = new SpeedWarning();
  /**
   * The card's red, by the speed warning's rules against the camera's limit: on after 1.5 s past the margin, off 3 km/h
   * back under, so hovering at the line doesn't flicker it. One warning per camera, kept through a moment out of sight
   * (a blink of the card doesn't start its 1.5 s again) for as long as the voice remembers the camera.
   */
  private red: { id: number; warning: SpeedWarning; seenMs: number } | null = null;
  /** Each camera the voice spoke of, and when it was last on the card since (wall clock). */
  private readonly said = new Map<number, number>();

  constructor(private readonly deps: SpeedAlertsDeps) {}

  /** A screen shows them: followed from now until every screen has let go (the returned release). */
  retain(): () => void {
    if (this.retained++ === 0) {
      const off = [this.deps.position.subscribe(this.update), this.deps.preferences.subscribe(this.update)];
      this.stop = () => off.forEach((o) => o());
      this.update();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.retained > 0) return;
      this.stop?.();
      this.stop = null;
    };
  }

  getSnapshot = (): SpeedAlertsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** A new position or new preferences: the warnings move on (the same position again changes nothing). */
  private update = (): void => {
    const position = this.deps.position.getSnapshot();
    const { limitChime, cameras, marginKph } = this.deps.preferences.getSnapshot();
    const nowMs = position?.timestamp ?? 0;
    const speedKph = position?.speedMps === undefined ? undefined : Math.round(position.speedMps * 3.6);
    const limitKph = position?.speedLimit?.kph;
    const { over, chime } = this.speedWarning.update(speedKph, limitKph, marginKph, nowMs);
    if (chime) {
      this.act(() => {
        const silent = !limitChime || this.deps.silent();
        this.deps.note(`speed warning: ${speedKph} km/h, limit ${limitKph} + ${marginKph}${!limitChime ? " (chime off)" : silent ? " (silent)" : ""}`);
        if (!silent) this.deps.chime();
      });
    }
    const speed: SpeedShown = { speedKph, limitKph, over: over && limitKph !== undefined };
    const camera = this.camera(cameras ? position?.cameraAhead : undefined, speedKph, marginKph, nowMs);
    const next = {
      speed: sameSpeed(speed, this.snapshot.speed) ? this.snapshot.speed : speed,
      camera: sameCamera(camera, this.snapshot.camera) ? this.snapshot.camera : camera,
    };
    if (next.speed === this.snapshot.speed && next.camera === this.snapshot.camera) return;
    this.snapshot = next;
    this.listeners.forEach((l) => l());
  };

  private camera(ahead: PositionEstimate["cameraAhead"], speedKph: number | undefined, marginKph: number, nowMs: number): CameraShown | null {
    if (!ahead) return null;
    const limitKph = ahead.limitKph;
    const now = this.deps.nowMs();
    if (this.red?.id !== ahead.id || now - this.red.seenMs > SAY_AGAIN_MS) this.red = { id: ahead.id, warning: new SpeedWarning(), seenMs: now };
    this.red.seenMs = now;
    // `chime`: the warning has just started (not again on coming back from a gap still on).
    const red = this.red.warning.update(speedKph, limitKph, marginKph, nowMs);
    const at = `${speedKph ?? "?"} km/h, limit ${limitKph ?? "none"} + ${marginKph}`;
    for (const [camera, shownAt] of this.said) if (now - shownAt > SAY_AGAIN_MS) this.said.delete(camera);
    const news = !this.said.has(ahead.id);
    this.said.set(ahead.id, now);
    if (news) {
      // Said once: the speed now, not the card's red, which waits its moment.
      const overNow = limitKph !== undefined && speedKph !== undefined && speedKph > limitKph + marginKph;
      this.act(() => {
        const silent = this.deps.silent();
        this.deps.note(`camera warning #${ahead.id}: ${at}${overNow ? ", slow down" : ""}${silent ? " (silent)" : ""}`);
        if (!silent) this.deps.sayCamera(overNow);
      });
    }
    if (red.chime) this.act(() => this.deps.note(`camera slow down #${ahead.id}: ${at}`));
    return {
      id: ahead.id,
      distanceM: ahead.distanceM,
      progress: Math.min(1, Math.max(0, 1 - ahead.distanceM / ahead.fromM)),
      ...(limitKph !== undefined ? { limitKph } : {}),
      slowDown: red.over && limitKph !== undefined,
    };
  }

  /**
   * The voice and the trip log, from inside the navigator's publish: what goes wrong there is logged, never thrown, so
   * the position's other listeners still hear of it.
   */
  private act(effect: () => void): void {
    try {
      effect();
    } catch (e) {
      console.warn(`speed alerts: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * The speed beside a camera's card that shows a sign (§6.5): the one sign on the screen is the camera's, so the speed
 * shows none of its own; it is red past the lower of the two limits, the road's or the camera's (either warning on).
 * They differ before 8–14 % of cameras, the camera's lower (a 50 on a road tagged 90 or 110, or the limit dropping
 * between the car and it: the card's red); higher only by a tagging error, which the road's red doesn't hide.
 */
export function speedBesideCard(speed: SpeedShown, camera: CameraShown | null): SpeedShown {
  return camera?.limitKph === undefined ? speed : { speedKph: speed.speedKph, limitKph: undefined, over: speed.over || camera.slowDown };
}

/** The distance as a camera's card says it: 10 m steps near, 50 m farther, so the number doesn't tick every metre. */
export const shownCameraM = (m: number) => (m < 200 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50);

/**
 * A camera card's words, on any screen (UI-SPEC §6.5): "Speed camera in 600 m"; past the margin, red: "Slow down"
 * (the sign says to what), the distance under it.
 */
export function cameraWords(camera: CameraShown, t: (key: keyof Strings) => string, language: Lang): { title: string; line: string | null; red: boolean } {
  const red = camera.slowDown && camera.limitKph !== undefined;
  const distance = t("cameraIn").replace("{distance}", formatDistance(shownCameraM(camera.distanceM), language));
  return red ? { title: t("cameraSlowDown"), line: distance, red } : { title: distance, line: null, red };
}
