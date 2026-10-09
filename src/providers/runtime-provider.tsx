import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import type { VehicleLinkSnapshot } from "@/obd/types";
import type { SensorSnapshot } from "@/services/sensor-capture/sensor-service";
import { autoConnect, getRuntime, type DevSettings, type Runtime } from "@/services/runtime";
import type { RecorderSnapshot } from "@/services/trip-recorder/trip-recorder";

/** Starts the app-lifetime services and auto-connects on launch / foreground. */
export function RuntimeProvider({ children }: React.PropsWithChildren) {
  useEffect(() => {
    getRuntime();
    const connect = () => void autoConnect().catch((error) => console.warn("auto-connect failed", error));
    connect();
    const subscription = AppState.addEventListener("change", (state) => {
      // Into the trip log: what the driver saw on the map is only what happened while the app was in front.
      getRuntime().recorder.note(`app ${state}`);
      if (state === "active") connect();
    });
    return () => subscription.remove();
  }, []);
  return children;
}

export function useRuntime(): Runtime {
  return getRuntime();
}

/** Full link snapshot: re-renders on every sample (dev screens only). */
export function useVehicleLinkSnapshot(): VehicleLinkSnapshot {
  const { link } = getRuntime();
  return useSyncExternalStore(link.subscribe, link.getSnapshot, link.getSnapshot);
}

/** Selected primitive from the link snapshot; re-renders only when it changes. */
export function useVehicleLinkValue<T extends string | number | boolean | null>(select: (s: VehicleLinkSnapshot) => T): T {
  const { link } = getRuntime();
  const get = () => select(link.getSnapshot());
  return useSyncExternalStore(link.subscribe, get, get);
}

export function useRecorderSnapshot(): RecorderSnapshot {
  const { recorder } = getRuntime();
  return useSyncExternalStore(recorder.subscribe, recorder.getSnapshot, recorder.getSnapshot);
}

export function useSensorSnapshot(): SensorSnapshot {
  const { sensors } = getRuntime();
  return useSyncExternalStore(sensors.subscribe, sensors.getSnapshot, sensors.getSnapshot);
}

export function useDevSettings(): DevSettings {
  const { subscribeDevSettings, getDevSettings } = getRuntime();
  return useSyncExternalStore(subscribeDevSettings, getDevSettings, getDevSettings);
}
