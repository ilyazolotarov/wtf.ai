import { useEffect, useSyncExternalStore } from "react";

import { useT } from "@/i18n/provider";
import type { PositionEstimate } from "@/nav/position/types";
import { SpeedWarning } from "@/nav/speed/speed-warning";
import { getRuntime } from "@/services/runtime";
import { useSpeedPreferences } from "@/services/speed-preferences";

import { playSpeedWarning } from "../route/voice-player";

/**
 * One warning for every screen that shows the speed: one red state, one chime. Only the phone's map shows it yet; the
 * car's screens (CarPlay, Android Auto) are to call this hook too, not keep a warning of their own.
 */
const warning = new SpeedWarning();
let overNow = false;
const listeners = new Set<() => void>();

/** Feeds the warning; true when it has just started (chime). */
function feed(speedKph: number | undefined, limitKph: number | undefined, marginKph: number, nowMs: number): boolean {
  const state = warning.update(speedKph, limitKph, marginKph, nowMs);
  if (state.over !== overNow) {
    overNow = state.over;
    listeners.forEach((l) => l());
  }
  return state.chime;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const getOver = () => overNow;

export interface SpeedShown {
  /** The speed as the map shows it, km/h. */
  speedKph: number | undefined;
  /** The limit's sign, when there is one to stand behind and Settings shows it. */
  limitKph: number | undefined;
  /** Over the limit by more than the driver's margin: the speed shows red. */
  over: boolean;
}

/**
 * The speed, the limit and the warning on a screen (UI-SPEC §6.4). The speed turns red past the margin over the limit
 * (Settings, 15 km/h by default) and a chime sounds once, unless `silent` (the voice muted or at 0).
 */
export function useSpeedWarning(position: PositionEstimate | null, silent: boolean): SpeedShown {
  const { t, language } = useT();
  const { showLimit, marginKph } = useSpeedPreferences();
  const speedKph = position?.speedMps === undefined ? undefined : Math.round(position.speedMps * 3.6);
  const limitKph = showLimit ? position?.speedLimit?.kph : undefined;
  const nowMs = position?.timestamp ?? 0;
  const over = useSyncExternalStore(subscribe, getOver);

  useEffect(() => {
    if (!feed(speedKph, limitKph, marginKph, nowMs)) return;
    getRuntime().recorder.note(`speed warning: ${speedKph} km/h, limit ${limitKph} + ${marginKph}${silent ? " (silent)" : ""}`);
    if (!silent) playSpeedWarning(t("speedWarningSpoken"), language);
  }, [speedKph, limitKph, marginKph, nowMs, silent, t, language]);

  return { speedKph, limitKph, over: over && limitKph !== undefined };
}
