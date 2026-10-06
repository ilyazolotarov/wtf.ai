/**
 * The navigator settings the app actually runs with, in one place, because the replay tools must run the same
 * system the phone does.
 *
 * They did not, once: `DEFAULT_NAV_CONFIG.mapMatchLoop` is `open`, the app has shipped `closed` since the dev
 * settings gained the switch, and every replay therefore measured a different filter from the one in the car. On
 * 2026-10-06 that hid the failure this file exists to stop: the dot drove through a field beside the road for
 * 52 s at 130 km/h on the phone, and the open-loop replay of the same log never left the road, so the bug looked
 * unreproducible and the fix for it looked worthless (MAPMATCH-SPEC §15, item 14).
 *
 * `replayTrip` starts from these, so a tool gets them without asking; `--nav` overrides one for an experiment.
 * Anything the app turns on by default belongs here, next to the setting it mirrors in `services/runtime.ts`.
 */

import type { NavConfig } from "./navigator";

export const APP_NAV_DEFAULTS: Partial<NavConfig> = {
  /** `DevSettings.mapMatchLoop` — full correction (MAPMATCH-SPEC §9). */
  mapMatchLoop: "closed",
};

/** `DevSettings.routeHint`: off by default, so the filter is not told the route (ROUTING-SPEC §8.6). */
export const APP_ROUTE_HINT = false;
