import type { LocationPermissionResponse } from "expo-location";
import * as React from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";

import type { PositionEstimate } from "@/nav/position/types";
import type { ParkedCar } from "@/services/navigation/navigator-service";
import { getRuntime } from "@/services/runtime";

interface PositionContextValue {
  position: PositionEstimate | null;
  permission: LocationPermissionResponse | null;
  requestPermission(): Promise<LocationPermissionResponse>;
}

const PositionContext = React.createContext<PositionContextValue | null>(null);

export function PositionProvider({ children }: React.PropsWithChildren) {
  const [source] = useState(() => getRuntime().position);
  const [permission, setPermission] =
    useState<LocationPermissionResponse | null>(null);
  const position = useSyncExternalStore(
    source.subscribe,
    source.getSnapshot,
    source.getSnapshot,
  );

  useEffect(() => {
    const refresh = () => {
      void source.getPermission().then((result) => {
        setPermission(result);
        if (result.granted) void source.start();
      });
    };
    // Not when iOS launched the app in the background (a location relaunch): the wake decides how long GNSS runs there
    // (vehicle-wake-task.ts), and opening the app starts it here.
    if (Platform.OS !== "ios" || AppState.currentState !== "background") refresh();
    const subscription = AppState.addEventListener(
      "change",
      (state: AppStateStatus) => {
        // The map needs GNSS only on screen; a trip keeps it running in the background.
        if (state === "active") refresh();
        else if (state === "background") source.stop();
      },
    );
    return () => {
      subscription.remove();
      source.stop();
    };
  }, [source]);

  const requestPermission = async () => {
    const result = await source.requestPermission();
    setPermission(result);
    if (result.granted) await source.start();
    return result;
  };

  return (
    <PositionContext.Provider
      value={{ position, permission, requestPermission }}
    >
      {children}
    </PositionContext.Provider>
  );
}

export function usePosition(): PositionEstimate | null {
  const context = React.use(PositionContext);
  if (!context)
    throw new Error("usePosition must be used within PositionProvider");
  return context.position;
}

export function usePositionPermission() {
  const context = React.use(PositionContext);
  if (!context)
    throw new Error(
      "usePositionPermission must be used within PositionProvider",
    );
  return {
    permission: context.permission,
    requestPermission: context.requestPermission,
  };
}

/** Where the car was left, while the dot is the phone's (UI-SPEC §6.1; `NavigatorService.getParkedCar`). */
export function useParkedCar(): ParkedCar | null {
  const [source] = useState(() => getRuntime().position);
  return useSyncExternalStore(source.subscribe, source.getParkedCar, source.getParkedCar);
}
