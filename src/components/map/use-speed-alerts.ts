import { useEffect, useSyncExternalStore } from "react";

import { appStrings } from "@/i18n/provider";
import { getRuntime } from "@/services/runtime";
import { loadSpeedPreferences, subscribeSpeedPreferences } from "@/services/speed-preferences";

import { loadVoiceMuted, loadVoiceVolume } from "../route/use-voice-guidance";
import { playSpeedWarning, sayPhrases } from "../route/voice-player";
import { cameraPhrase } from "../route/voice-phrases";
import { SpeedAlerts, type SpeedAlertsSnapshot } from "./speed-alerts";

let alerts: SpeedAlerts | null = null;

/**
 * The speed and camera warnings of every screen (speed-alerts.ts): the navigator's position, Settings → Speed, and the
 * voice's mute and volume (muted or at 0: silent).
 */
export function speedAlerts(): SpeedAlerts {
  alerts ??= new SpeedAlerts({
    position: getRuntime().position,
    preferences: { getSnapshot: loadSpeedPreferences, subscribe: subscribeSpeedPreferences },
    silent: () => loadVoiceMuted() || loadVoiceVolume() === 0,
    note: (text) => getRuntime().recorder.note(text),
    chime: () => {
      const { t, language } = appStrings();
      playSpeedWarning(t("speedWarningSpoken"), language);
    },
    sayCamera: (slowDown) => {
      const { t, language } = appStrings();
      sayPhrases([cameraPhrase(t, slowDown)], language);
    },
    nowMs: Date.now,
  });
  return alerts;
}

/** The speed, the limit and the camera ahead on this screen, followed while it is mounted. */
export function useSpeedAlerts(): SpeedAlertsSnapshot {
  const source = speedAlerts();
  useEffect(() => source.retain(), [source]);
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}
