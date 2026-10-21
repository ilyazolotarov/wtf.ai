// The settings as stored on the phone (runtime.ts), read into the current shape.
import type { DevSettings } from "./runtime";

/** Saved with the settings: which defaults the phone has seen. */
export const DEV_SETTINGS_VERSION = 2;

/**
 * Settings whose default changed, with the version that changed it: a value stored before is dropped, since every
 * setting is saved along with any other one changed. 2: turns from the wheels on for everyone (2026-10-21).
 */
const DEFAULT_CHANGED: Partial<Record<keyof DevSettings, number>> = { wheelYaw: 2 };

/**
 * The stored values of today's settings over their defaults. Anything else stored is dropped: settings since
 * removed (the CAN mode and typed ids, the map-matching loop, the route hint), so an old `can: "off"` (the old
 * default, saved along with any other setting) leaves the wheels' speed at its default.
 */
export function loadDevSettings(stored: Record<string, unknown> | null, defaults: DevSettings): DevSettings {
  const settings = { ...defaults };
  if (!stored) return settings;
  const version = typeof stored.version === "number" ? stored.version : 1;
  for (const key of Object.keys(defaults) as (keyof DevSettings)[]) {
    if ((DEFAULT_CHANGED[key] ?? 0) > version) continue;
    if (key in stored) (settings as Record<string, unknown>)[key] = stored[key];
  }
  return settings;
}
