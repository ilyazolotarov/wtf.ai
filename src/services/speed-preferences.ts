// Settings → Speed (UI-SPEC §6.4, §7.6): whether the map shows the speed limit, and how far over it the speed turns
// red. Kept across launches.

import { useSyncExternalStore } from "react";

import { DEFAULT_SPEED_MARGIN_KPH, SPEED_MARGINS_KPH, type SpeedMarginKph } from "@/nav/speed/speed-warning";
import { kvStore } from "@/services/kv-store";

export interface SpeedPreferences {
  showLimit: boolean;
  marginKph: SpeedMarginKph;
}

const KEY = "speed.preferences";
const DEFAULTS: SpeedPreferences = { showLimit: true, marginKph: DEFAULT_SPEED_MARGIN_KPH };

let current: SpeedPreferences | null = null;
const listeners = new Set<() => void>();

export function loadSpeedPreferences(): SpeedPreferences {
  if (!current) {
    const stored = kvStore.getJson<Partial<SpeedPreferences>>(KEY) ?? {};
    current = {
      showLimit: typeof stored.showLimit === "boolean" ? stored.showLimit : DEFAULTS.showLimit,
      marginKph: SPEED_MARGINS_KPH.includes(stored.marginKph as SpeedMarginKph) ? (stored.marginKph as SpeedMarginKph) : DEFAULTS.marginKph,
    };
  }
  return current;
}

export function saveSpeedPreferences(change: Partial<SpeedPreferences>): void {
  current = { ...loadSpeedPreferences(), ...change };
  kvStore.setJson(KEY, current);
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useSpeedPreferences(): SpeedPreferences {
  return useSyncExternalStore(subscribe, loadSpeedPreferences);
}
