import type { LocationPermissionResponse } from "expo-location";
import * as React from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, type AppStateStatus } from "react-native";

import type { PositionEstimate } from "@/nav/position/types";
import { GnssPositionSource } from "@/services/position/gnss-position-source";

interface PositionContextValue {
  position: PositionEstimate | null;
  permission: LocationPermissionResponse | null;
  requestPermission(): Promise<LocationPermissionResponse>;
}

const PositionContext = React.createContext<PositionContextValue | null>(null);

export function PositionProvider({ children }: React.PropsWithChildren) {
  const [source] = useState(() => new GnssPositionSource());
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
    refresh();
    const subscription = AppState.addEventListener(
      "change",
      (state: AppStateStatus) => {
        if (state === "active") refresh();
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
