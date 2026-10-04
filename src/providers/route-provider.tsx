import { useSyncExternalStore } from "react";

import type { Coordinate } from "@/nav/geo";
import { getRuntime } from "@/services/runtime";
import type { RouteDestination, RouteSnapshot } from "@/services/navigation/route-service";

export interface Destination extends Coordinate {
  id: string;
  name: { en: string; uk: string };
}

/** Cities for the route screen's list; routes reach them only inside the downloaded region (ROUTING-SPEC §3). */
export const destinations: Destination[] = [
  { id: "kyiv", name: { en: "Kyiv", uk: "Київ" }, lat: 50.4501, lon: 30.5234 },
  { id: "chernihiv", name: { en: "Chernihiv", uk: "Чернігів" }, lat: 51.4939, lon: 31.2947 },
  { id: "slavutych", name: { en: "Slavutych", uk: "Славутич" }, lat: 51.5225, lon: 30.7561 },
  { id: "nizhyn", name: { en: "Nizhyn", uk: "Ніжин" }, lat: 51.0481, lon: 31.8869 },
  { id: "pryluky", name: { en: "Pryluky", uk: "Прилуки" }, lat: 50.5933, lon: 32.3874 },
  { id: "lviv", name: { en: "Lviv", uk: "Львів" }, lat: 49.8397, lon: 24.0297 },
  { id: "odesa", name: { en: "Odesa", uk: "Одеса" }, lat: 46.4825, lon: 30.7233 },
  { id: "dnipro", name: { en: "Dnipro", uk: "Дніпро" }, lat: 48.4647, lon: 35.0462 },
  { id: "kharkiv", name: { en: "Kharkiv", uk: "Харків" }, lat: 49.9935, lon: 36.2304 },
  { id: "vinnytsia", name: { en: "Vinnytsia", uk: "Вінниця" }, lat: 49.2331, lon: 28.4682 },
];

export interface RouteControls {
  /** The route being planned or followed (null: none). */
  route: RouteSnapshot | null;
  startRoute(destination: RouteDestination): void;
  stopRoute(): void;
}

/** The app's route (ROUTING-SPEC §8), from the runtime's route service. */
export function useRoute(): RouteControls {
  const { routes } = getRuntime();
  const route = useSyncExternalStore(routes.subscribe, routes.getSnapshot, routes.getSnapshot);
  return { route, startRoute: (d) => routes.start(d), stopRoute: () => routes.stop() };
}
