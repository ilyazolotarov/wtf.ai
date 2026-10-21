// The app started after the car drove off (VEHICLE-LINK-SPEC §11): iOS, with location "Always", relaunches it a few
// hundred metres into a drive the driver didn't open it for. The pose saved where the car stood is then behind it:
// the navigator doesn't start from it, and the map says why until the car is found (a trusted fix or a placing).

import type { DriveWakeFix, LaunchInfo } from "../../modules/sensor-capture/src/SensorCaptureModule";
import { haversineM, type Coordinate } from "@/nav/geo";

/** A start this long after the launch is the driver's own, not the wake's. */
export const ON_THE_WAY_WITHIN_S = 10 * 60;

/** The relaunch's own location puts the phone this close to the pose, all of its accuracy included: still there. */
export const STANDING_WITHIN_M = 150;

/** A location this much older than the launch is one iOS had cached, not the one it relaunched the app for. */
export const WAKE_FIX_BEFORE_LAUNCH_MS = 2 * 60_000;

/** How a pose saved standing relates to this launch. */
export type PoseAfterWake = "not woken" | "behind" | "standing";

/** Launched in the background by iOS for location, a moment ago. */
export function launchedOnTheWay(launch: LaunchInfo, nowUs: number): boolean {
  return launch.inBackground && launch.reasons.includes("location") && (nowUs - launch.uptimeUs) / 1e6 <= ON_THE_WAY_WITHIN_S;
}

/**
 * Relaunched on the way: the pose is behind the car, unless the location iOS relaunched the app for is still at it (a
 * relaunch while the car stands: the phone moved a little, or the cell it used changed).
 */
export function poseAfterWake(
  launch: LaunchInfo,
  nowUs: number,
  fix: DriveWakeFix | null,
  pose: Coordinate & { savedAt: number },
): PoseAfterWake {
  if (!launchedOnTheWay(launch, nowUs)) return "not woken";
  const fresh = fix !== null && fix.wallMs >= Math.max(pose.savedAt, launch.wallMs - WAKE_FIX_BEFORE_LAUNCH_MS);
  return fresh && haversineM(fix, pose) + fix.accuracyM <= STANDING_WITHIN_M ? "standing" : "behind";
}

/**
 * Whether the map says so: once the navigator left the parked pose aside and a trip records, until the car is found.
 * Without a trip it is no drive: the driver walked or rode off with the phone, and iOS relaunched the app for that.
 */
export class OnTheWay {
  private poseBehind = false;
  private recording = false;
  private shown = false;
  private readonly listeners = new Set<() => void>();

  get = (): boolean => this.shown;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The navigator left the parked pose aside. */
  behind(): void {
    this.poseBehind = true;
    this.sync();
  }

  setRecording(recording: boolean): void {
    this.recording = recording;
    this.sync();
  }

  /** Found (a trusted fix, a placing), or closed by the driver. */
  clear(): void {
    this.poseBehind = false;
    this.sync();
  }

  private sync(): void {
    const shown = this.poseBehind && this.recording;
    if (this.shown === shown) return;
    this.shown = shown;
    this.listeners.forEach((l) => l());
  }
}
