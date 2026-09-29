import * as React from "react";

import type { Coordinate } from "@/nav/geo";
import { bearingRad, haversineM } from "@/nav/geo";
import type { PositionEstimate } from "@/nav/position/types";

export interface Destination extends Coordinate {
  id: string;
  name: { en: string; uk: string };
}

export interface ActiveRoute extends Destination {
  distanceM: number;
  bearingRad: number;
  coordinates: [number, number][];
}

export const destinations: Destination[] = [
  { id: "kyiv", name: { en: "Kyiv", uk: "Київ" }, lat: 50.4501, lon: 30.5234 },
  { id: "lviv", name: { en: "Lviv", uk: "Львів" }, lat: 49.8397, lon: 24.0297 },
  {
    id: "odesa",
    name: { en: "Odesa", uk: "Одеса" },
    lat: 46.4825,
    lon: 30.7233,
  },
  {
    id: "dnipro",
    name: { en: "Dnipro", uk: "Дніпро" },
    lat: 48.4647,
    lon: 35.0462,
  },
  {
    id: "kharkiv",
    name: { en: "Kharkiv", uk: "Харків" },
    lat: 49.9935,
    lon: 36.2304,
  },
  {
    id: "zaporizhzhia",
    name: { en: "Zaporizhzhia", uk: "Запоріжжя" },
    lat: 47.8388,
    lon: 35.1396,
  },
  {
    id: "vinnytsia",
    name: { en: "Vinnytsia", uk: "Вінниця" },
    lat: 49.2331,
    lon: 28.4682,
  },
];

interface RouteContextValue {
  activeRoute: ActiveRoute | null;
  startRoute(destination: Destination, position: PositionEstimate | null): void;
  stopRoute(): void;
}

const RouteContext = React.createContext<RouteContextValue | null>(null);

export function RouteProvider({ children }: React.PropsWithChildren) {
  const [activeRoute, setActiveRoute] = React.useState<ActiveRoute | null>(
    null,
  );

  const startRoute = (
    destination: Destination,
    position: PositionEstimate | null,
  ) => {
    const origin = position ?? { lat: 50.4501, lon: 30.5234 };
    setActiveRoute({
      ...destination,
      distanceM: haversineM(origin, destination),
      bearingRad: bearingRad(origin, destination),
      coordinates: [
        [origin.lon, origin.lat],
        [destination.lon, destination.lat],
      ],
    });
  };

  const value = React.useMemo(
    () => ({ activeRoute, startRoute, stopRoute: () => setActiveRoute(null) }),
    [activeRoute],
  );
  return (
    <RouteContext.Provider value={value}>{children}</RouteContext.Provider>
  );
}

export function useRoute(): RouteContextValue {
  const context = React.use(RouteContext);
  if (!context) throw new Error("useRoute must be used within RouteProvider");
  return context;
}
