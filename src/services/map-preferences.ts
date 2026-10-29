// Settings → 3D buildings (UI-SPEC §4.6, §7.6): whether the map raises the buildings, on every screen, on the phone's
// alone (the car's screen flat), or nowhere. Kept across launches.

import { useSyncExternalStore } from "react";

import { kvStore } from "@/services/kv-store";

/** "phone": raised on the phone's maps, flat on the car's screen (CarPlay, Android Auto). */
export type Buildings3d = "on" | "phone" | "off";

export interface MapPreferences {
  buildings3d: Buildings3d;
}

const KEY = "map.preferences";
const DEFAULTS: MapPreferences = { buildings3d: "on" };
const BUILDINGS: readonly Buildings3d[] = ["on", "phone", "off"];

let current: MapPreferences | null = null;
const listeners = new Set<() => void>();

export function loadMapPreferences(): MapPreferences {
  if (!current) {
    const stored = kvStore.getJson<Partial<MapPreferences>>(KEY) ?? {};
    current = {
      buildings3d: BUILDINGS.includes(stored.buildings3d as Buildings3d) ? (stored.buildings3d as Buildings3d) : DEFAULTS.buildings3d,
    };
  }
  return current;
}

export function saveMapPreferences(change: Partial<MapPreferences>): void {
  current = { ...loadMapPreferences(), ...change };
  kvStore.setJson(KEY, current);
  listeners.forEach((l) => l());
}

export function subscribeMapPreferences(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

export function useMapPreferences(): MapPreferences {
  return useSyncExternalStore(subscribeMapPreferences, loadMapPreferences);
}
