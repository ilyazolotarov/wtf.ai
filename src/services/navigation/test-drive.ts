// The car's test drive (docs/ANDROID-AUTO-SPEC.md §4, Android for Cars quality guideline NF-7). Android Auto asks for it
// (the Play review; `adb shell dumpsys activity service <package>/ai.wtf.androidauto.CarScreenService AUTO_DRIVE`), and
// from then on each route the driver starts is driven along by a simulated car (route-drive.ts), its dot published
// instead of the navigator's: the guidance, the voice, the turn notifications and the car's cluster run as on a drive.
// It lasts the car's session. Between routes the dot stands where the last one left it, and the next route starts there.

import { RouteDrive, type DrivePoint } from "@/nav/sim/route-drive";
import type { RoutePlan } from "@/nav/routing/router";

import type { RouteSnapshot } from "./route-service";

/** The simulated car moves this often (the navigator publishes every 500 ms). */
export const TEST_DRIVE_STEP_MS = 250;
/**
 * A step after the JS thread was held up moves the car on by the time gone, up to this, s: late timers (a busy phone)
 * must not slow the drive below its speed.
 */
const MAX_STEP_S = 5;

export interface TestDriveDeps {
  routes: { getSnapshot(): RouteSnapshot | null; subscribe(listener: () => void): () => void };
  /** Published instead of the navigator's dot; null: the navigator's again. */
  show(dot: DrivePoint | null): void;
  /** `fn` every `ms`, until the returned stop. */
  every(ms: number, fn: () => void): () => void;
  nowMs(): number;
  note(text: string): void;
}

export class TestDrive {
  private unsubscribe: (() => void) | null = null;
  private stopSteps: (() => void) | null = null;
  /** The plan being driven (by identity: a re-plan or another alternative is a new one). */
  private plan: RoutePlan | null = null;
  private drive: RouteDrive | null = null;
  private dot: DrivePoint | null = null;
  private lastMs = 0;

  constructor(private readonly deps: TestDriveDeps) {}

  get on(): boolean {
    return this.unsubscribe !== null;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.deps.note("test drive on: each route is driven along");
    this.unsubscribe = this.deps.routes.subscribe(this.onRoute);
    this.onRoute();
  }

  stop(): void {
    if (!this.unsubscribe) return;
    this.unsubscribe();
    this.unsubscribe = null;
    this.halt();
    this.plan = null;
    this.dot = null;
    this.deps.show(null);
    this.deps.note("test drive off");
  }

  private readonly onRoute = () => {
    const route = this.deps.routes.getSnapshot();
    const plan = (route?.status === "active" && route.plan) || null;
    if (plan === this.plan) return;
    this.plan = plan;
    if (!plan) {
      // The route ended: the car stands where it got to.
      this.halt();
      if (this.dot) this.publish({ ...this.dot, speedMps: 0 });
      return;
    }
    const from = this.dot;
    this.drive = new RouteDrive(plan.coordinates, from ?? undefined, from?.speedMps ?? 0);
    this.deps.note(`test drive: along ${Math.round(this.drive.lengthM)} m of route${from ? ", from where it was" : ""}`);
    this.lastMs = this.deps.nowMs();
    this.publish(this.drive.point());
    this.stopSteps ??= this.deps.every(TEST_DRIVE_STEP_MS, this.step);
  };

  private readonly step = () => {
    if (!this.drive) return;
    const now = this.deps.nowMs();
    const dtS = Math.min(MAX_STEP_S, Math.max(0, (now - this.lastMs) / 1000));
    this.lastMs = now;
    const p = this.drive.step(dtS);
    this.publish(p);
    if (p.arrived) {
      this.deps.note("test drive: at the route's end");
      this.halt();
    }
  };

  private publish(p: DrivePoint): void {
    this.dot = p;
    this.deps.show(p);
  }

  private halt(): void {
    this.stopSteps?.();
    this.stopSteps = null;
    this.drive = null;
  }
}
