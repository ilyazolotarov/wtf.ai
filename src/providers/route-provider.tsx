import { useSyncExternalStore } from "react";

import { useAdapterStatus } from "@/components/status/use-nav-status";
import type { Coordinate } from "@/nav/geo";
import { useDevSettings } from "@/providers/runtime-provider";
import { getRuntime } from "@/services/runtime";
import type { RouteDestination, RouteSnapshot } from "@/services/navigation/route-service";
import { heldRoute, holdRouteForGuide, onHeldRoute, takeHeldRoute } from "@/services/navigation/route-without-adapter";

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
  /** Follow `route.alternatives[index]` instead (ROUTING-SPEC §8.7). */
  chooseAlternative(index: number): void;
}

/** Navigation without an adapter (phone-only mode on, no adapter connected): a route waits for the driver's word. */
export function useWithoutAdapter(): boolean {
  const { phoneOnly } = useDevSettings();
  const adapter = useAdapterStatus();
  return phoneOnly && adapter !== "on";
}

/**
 * The app's route (ROUTING-SPEC §8), from the runtime's route service. Without an adapter a new route is held for the
 * map screen's guide (`useHeldRoute`) instead of planned at once.
 */
export function useRoute(): RouteControls {
  const { routes } = getRuntime();
  const route = useSyncExternalStore(routes.subscribe, routes.getSnapshot, routes.getSnapshot);
  const withoutAdapter = useWithoutAdapter();
  return {
    route,
    startRoute: (d) => {
      if (!withoutAdapter) return routes.start(d);
      routes.stop();
      holdRouteForGuide(d);
    },
    stopRoute: () => {
      takeHeldRoute();
      routes.stop();
    },
    chooseAlternative: (index) => routes.chooseAlternative(index),
  };
}

export interface HeldRoute {
  /** The route waiting for the driver to say they will follow it (null: none). */
  destination: RouteDestination | null;
  /** Plan it: the driver said they will follow it. */
  confirm(): void;
  cancel(): void;
}

/** A route asked for without an adapter, waiting for the guide on the map (UI-SPEC §6.3). */
export function useHeldRoute(): HeldRoute {
  const { routes, recorder } = getRuntime();
  const destination = useSyncExternalStore(onHeldRoute, heldRoute, heldRoute);
  return {
    destination,
    confirm: () => {
      const d = takeHeldRoute();
      if (!d) return;
      recorder.note("route without an adapter: the driver will follow it");
      routes.start(d);
    },
    cancel: () => void takeHeldRoute(),
  };
}
