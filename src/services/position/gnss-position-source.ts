import * as Location from "expo-location";

import type { PositionEstimate } from "@/nav/position/types";
import type { PositionSource } from "@/services/position/position-source";

const NO_FIX_AFTER_MS = 5000;

export function mapLocationToPosition(
  location: Location.LocationObject,
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
    trust: "TRUSTED",
    timestamp: location.timestamp,
    lastTrustedFixAt: location.timestamp,
  };
}

export class GnssPositionSource implements PositionSource {
  private position: PositionEstimate | null = null;
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
        this.position = mapLocationToPosition(location);
        this.emit();
      },
      () => {
        if (this.position) {
          this.position = { ...this.position, trust: "NO_FIX" };
          this.emit();
        }
      },
    );

    this.noFixTimer = setInterval(() => {
      if (!this.position) return;
      const trust =
        Date.now() - this.position.timestamp > NO_FIX_AFTER_MS
          ? "NO_FIX"
          : "TRUSTED";
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
