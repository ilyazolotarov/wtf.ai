// Settings → Speed (UI-SPEC §6.4, §6.5, §7.6): whether the speed warning chimes, whether the map warns of speed
// cameras, and how far over a limit the speed (and a camera's card) turns red. Kept across launches.

import { useSyncExternalStore } from "react";

import { DEFAULT_SPEED_MARGIN_KPH, SPEED_MARGINS_KPH, type SpeedMarginKph } from "@/nav/speed/speed-warning";
import { kvStore } from "@/services/kv-store";

export interface SpeedPreferences {
  /** Over the road's limit past the margin, the chime sounds (the sign and the red show either way). */
  limitChime: boolean;
  cameras: boolean;
  marginKph: SpeedMarginKph;
}

const KEY = "speed.preferences";
const DEFAULTS: SpeedPreferences = { limitChime: true, cameras: true, marginKph: DEFAULT_SPEED_MARGIN_KPH };

let current: SpeedPreferences | null = null;
const listeners = new Set<() => void>();

export function loadSpeedPreferences(): SpeedPreferences {
  if (!current) {
    // `showLimit`: the switch hid the sign before it was the chime's; a driver who turned it off is chimed at no more.
    const stored = kvStore.getJson<Partial<SpeedPreferences> & { showLimit?: boolean }>(KEY) ?? {};
    const chime = stored.limitChime ?? stored.showLimit;
    current = {
      limitChime: typeof chime === "boolean" ? chime : DEFAULTS.limitChime,
      cameras: typeof stored.cameras === "boolean" ? stored.cameras : DEFAULTS.cameras,
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

export function subscribeSpeedPreferences(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

export function useSpeedPreferences(): SpeedPreferences {
  return useSyncExternalStore(subscribeSpeedPreferences, loadSpeedPreferences);
}
