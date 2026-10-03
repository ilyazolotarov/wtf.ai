import * as Location from "expo-location";

import type { PositionEstimate, TrustState } from "@/nav/position/types";
import { GnssTrustTracker } from "@/services/position/gnss-trust";
import type { PositionSource } from "@/services/position/position-source";
import type { SensorService } from "@/services/sensor-capture/sensor-service";
import type { GnssRecord } from "@/triplog/schema";

const OWNER = "position";
const finite = (v: number) => (Number.isFinite(v) ? v : undefined);

/** Satellite fix vs Wi-Fi/cell fallback: only satellite fixes carry a speed (0 when standing). */
export const isSatelliteRecord = (fix: GnssRecord) => Number.isFinite(fix.speedMps) && fix.speedMps >= 0;

export function mapFixToPosition(
  fix: GnssRecord,
  trust: TrustState = "TRUSTED",
  lastTrustedFixAt: number | undefined = fix.utcUs / 1000,
): PositionEstimate {
  const speed = finite(fix.speedMps);
  return {
    lat: fix.latDeg,
    lon: fix.lonDeg,
    headingRad: finite(fix.courseRad),
    speedMps: speed !== undefined && speed >= 0 ? speed : undefined,
    accuracyM: finite(fix.hAccM) ?? 9999,
    source: "gnss",
    trust,
    timestamp: fix.utcUs / 1000,
    lastTrustedFixAt,
  };
}

/**
 * Phone GNSS for the map, from the same native CoreLocation stream as the trip log
 * (modules/sensor-capture: automotive navigation, never paused by iOS). expo-location's
 * watcher used to stall for good, until an app restart, after a jamming episode.
 */
export class GnssPositionSource implements PositionSource {
  private position: PositionEstimate | null = null;
  private trust = new GnssTrustTracker();
  private unsubscribe: (() => void) | null = null;
  private noFixTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private readonly sensors: SensorService;

  constructor(sensors: SensorService) {
    this.sensors = sensors;
  }

  getSnapshot = (): PositionEstimate | null => this.position;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getPermission = (): Promise<Location.LocationPermissionResponse> => Location.getForegroundPermissionsAsync();

  requestPermission = (): Promise<Location.LocationPermissionResponse> => Location.requestForegroundPermissionsAsync();

  /** Idempotent; also retries native capture that couldn't start (e.g. before permission). */
  async start(): Promise<void> {
    const permission = await this.getPermission();
    if (!permission.granted) return;
    this.sensors.want(true, false, OWNER);
    if (this.unsubscribe) return;
    this.unsubscribe = this.sensors.gnss.on((fix) => this.onFix(fix));
    this.noFixTimer = setInterval(() => {
      if (!this.position) return;
      const trust = this.trust.check(Date.now());
      if (trust !== this.position.trust) this.setPosition({ ...this.position, trust });
    }, 1000);
  }

  stop(): void {
    this.sensors.want(false, false, OWNER);
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.noFixTimer) clearInterval(this.noFixTimer);
    this.noFixTimer = null;
  }

  private onFix(fix: GnssRecord): void {
    if (!Number.isFinite(fix.latDeg) || !Number.isFinite(fix.lonDeg)) return;
    const trust = this.trust.onFix(finite(fix.hAccM) ?? 9999, fix.utcUs / 1000, isSatelliteRecord(fix));
    this.setPosition(mapFixToPosition(fix, trust, this.trust.lastTrustedFixAt));
  }

  private setPosition(position: PositionEstimate): void {
    this.position = position;
    this.listeners.forEach((listener) => listener());
  }
}
