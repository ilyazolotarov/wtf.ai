// The settings as stored on the phone (runtime.ts), read into the current shape.
import type { DevSettings } from "./runtime";

/**
 * The stored values of today's settings over their defaults. Anything else stored is dropped: settings since
 * removed (the CAN mode and typed ids, the map-matching loop, the route hint), so an old `can: "off"` (the old
 * default, saved along with any other setting) leaves the wheels' speed at its default.
 */
export function loadDevSettings(stored: Record<string, unknown> | null, defaults: DevSettings): DevSettings {
  const settings = { ...defaults };
  if (!stored) return settings;
  for (const key of Object.keys(defaults) as (keyof DevSettings)[]) {
    if (key in stored) (settings as Record<string, unknown>)[key] = stored[key];
  }
  return settings;
}
