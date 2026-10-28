import { useEffect, useSyncExternalStore } from "react";

import { useT } from "@/i18n/provider";
import type { PositionEstimate } from "@/nav/position/types";
import { SpeedWarning } from "@/nav/speed/speed-warning";
import { getRuntime } from "@/services/runtime";
import { useSpeedPreferences } from "@/services/speed-preferences";

import { sayPhrases } from "../route/voice-player";
import { cameraPhrase } from "../route/voice-phrases";

export interface CameraShown {
  distanceM: number;
  /** How much of the way from where the card first showed is driven, 0–1: its bar. */
  progress: number;
  /** At the camera; absent: none known (no sign, never red). */
  limitKph?: number;
  /** Over the camera's limit by more than the driver's margin: the card shows red, "Slow down". */
  slowDown: boolean;
}

/**
 * When the voice last spoke of each camera (wall clock, ms), however many screens show the card: again only after this,
 * so a camera lost for a moment and found isn't news (a passed one isn't shown again sooner either, CameraAlert).
 */
const SAY_AGAIN_MS = 120_000;
const said = new Map<number, number>();

/**
 * The card's red, by the speed warning's rules against the camera's limit (UI-SPEC §6.4): on after 1.5 s past the
 * margin, off 3 km/h back under, so hovering at the line doesn't flicker it. One warning per camera shown.
 */
let red: { id: number | null; warning: SpeedWarning; over: boolean } = { id: null, warning: new SpeedWarning(), over: false };
const listeners = new Set<() => void>();

/** Feeds the card's red; true when it has just turned on. */
function feedRed(id: number | null, speedKph: number | undefined, limitKph: number | undefined, marginKph: number, nowMs: number): boolean {
  const was = red.over;
  if (red.id !== id) red = { id, warning: new SpeedWarning(), over: false };
  red.over = id !== null && red.warning.update(speedKph, limitKph, marginKph, nowMs).over;
  if (red.over !== was) listeners.forEach((l) => l());
  return red.over && !was;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
/** The camera whose card is red, null: none. */
const getRed = () => (red.over ? red.id : null);

/**
 * The speed camera ahead on a screen (UI-SPEC §6.5): its card, and the voice once when it shows ("Speed camera
 * ahead", with "Slow down" past the margin then), unless `silent` (the voice muted or at 0). Null: none, or the
 * warnings are off in Settings.
 */
export function useCameraWarning(position: PositionEstimate | null, speedKph: number | undefined, silent: boolean): CameraShown | null {
  const { t, language } = useT();
  const { cameras, marginKph } = useSpeedPreferences();
  const ahead = cameras ? position?.cameraAhead : undefined;
  const id = ahead?.id;
  const limitKph = ahead?.limitKph;
  const nowMs = position?.timestamp ?? 0;
  const redId = useSyncExternalStore(subscribe, getRed);

  useEffect(() => {
    const turnedRed = feedRed(id ?? null, speedKph, limitKph, marginKph, nowMs);
    if (id === undefined) return;
    const at = `${speedKph ?? "?"} km/h, limit ${limitKph ?? "none"} + ${marginKph}`;
    const now = Date.now();
    for (const [camera, saidAt] of said) if (now - saidAt > SAY_AGAIN_MS) said.delete(camera);
    if (!said.has(id)) {
      said.set(id, now);
      // Said once: the speed now, not the card's red, which waits its moment.
      const over = limitKph !== undefined && speedKph !== undefined && speedKph > limitKph + marginKph;
      getRuntime().recorder.note(`camera warning #${id}: ${at}${over ? ", slow down" : ""}${silent ? " (silent)" : ""}`);
      if (!silent) sayPhrases([cameraPhrase(t, over)], language);
    }
    if (turnedRed) getRuntime().recorder.note(`camera slow down #${id}: ${at}`);
  }, [id, speedKph, limitKph, marginKph, nowMs, silent, t, language]);

  if (!ahead) return null;
  return {
    distanceM: ahead.distanceM,
    progress: Math.min(1, Math.max(0, 1 - ahead.distanceM / ahead.fromM)),
    ...(limitKph !== undefined ? { limitKph } : {}),
    slowDown: redId === ahead.id && limitKph !== undefined,
  };
}
