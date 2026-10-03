import * as Location from "expo-location";

import type { PositionEstimate, TrustState } from "@/nav/position/types";
import { GnssTrustTracker } from "@/services/position/gnss-trust";
import type { PositionSource } from "@/services/position/position-source";

export function mapLocationToPosition(
  location: Location.LocationObject,
  trust: TrustState = "TRUSTED",
  lastTrustedFixAt: number | undefined = location.timestamp,
): PositionEstimate {
  const { latitude, longitude, accuracy, heading, speed } = location.coords;

  return {
    lat: latitude,
    lon: longitude,
    headingRad:
      heading === null || heading < 0 ? undefined : (heading * Math.PI) / 180,
    speedMps: speed === null || speed < 0 ? undefined : speed,
    accuracyM: accuracy ?? 9999,
    source: "gnss",
    trust,
    timestamp: location.timestamp,
    lastTrustedFixAt,
  };
}

export class GnssPositionSource implements PositionSource {
  private position: PositionEstimate | null = null;
  private trust = new GnssTrustTracker();
  private locationSubscription: Location.LocationSubscription | null = null;
  private noFixTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();

  getSnapshot = (): PositionEstimate | null => this.position;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getPermission = (): Promise<Location.LocationPermissionResponse> =>
    Location.getForegroundPermissionsAsync();

  requestPermission = (): Promise<Location.LocationPermissionResponse> =>
    Location.requestForegroundPermissionsAsync();

  async start(): Promise<void> {
    if (this.locationSubscription) return;
    const permission = await this.getPermission();
    if (!permission.granted) return;

    this.locationSubscription = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 0,
        timeInterval: 1000,
      },
      (location) => {
        const accuracyM = location.coords.accuracy ?? 9999;
        const trust = this.trust.onFix(accuracyM, location.timestamp);
        this.position = mapLocationToPosition(
          location,
          trust,
          this.trust.lastTrustedFixAt,
        );
        this.emit();
      },
      // iOS reports transient errors (e.g. location unknown) routinely; losing trust is
      // left to the tracker's timeout so they don't flip the status.
      () => {},
    );

    this.noFixTimer = setInterval(() => {
      if (!this.position) return;
      const trust = this.trust.check(Date.now());
      if (trust !== this.position.trust) {
        this.position = { ...this.position, trust };
        this.emit();
      }
    }, 1000);
  }

  stop(): void {
    this.locationSubscription?.remove();
    this.locationSubscription = null;
    if (this.noFixTimer) clearInterval(this.noFixTimer);
    this.noFixTimer = null;
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}
