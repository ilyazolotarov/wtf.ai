import {
  loadVoiceMuted,
  loadVoiceVolume,
  saveVoiceMuted,
  subscribeVoiceMuted,
  subscribeVoiceVolume,
  VoiceGuide,
} from "@/components/route/use-voice-guidance";
import { setVoiceNote } from "@/components/route/voice-player";
import { initSentry } from "@/config/sentry";
import { appStrings } from "@/i18n/provider";
import { places } from "@/providers/places";
import { autoConnect, getRuntime } from "@/services/runtime";

import AndroidAuto from "../../../modules/android-auto/src/AndroidAutoModule";
import { runCarSession } from "./car-session";

/** The headless task's name (CarSessionTask.TASK in modules/android-auto). */
export const CAR_SESSION_TASK = "WtfCarSession";

/** The car's screen connected (docs/ANDROID-AUTO-SPEC.md §3): runs until it is gone. */
export async function carSessionTask(): Promise<void> {
  if (!AndroidAuto) return;
  // The process may have started for the car, the phone's screens (and the root layout's setup) never loaded.
  initSentry();
  const runtime = getRuntime();
  const { recorder, routes, position } = runtime;
  setVoiceNote((text) => recorder.note(text));
  const guide = new VoiceGuide();
  await runCarSession({
    native: AndroidAuto,
    routes,
    places,
    strings: appStrings,
    voice: {
      muted: loadVoiceMuted,
      setMuted: saveVoiceMuted,
      volume: loadVoiceVolume,
      subscribe: (listener) => {
        const off = [subscribeVoiceMuted(listener), subscribeVoiceVolume(listener)];
        return () => off.forEach((o) => o());
      },
      claim: () => guide.claim(),
      update: (route, speedMps, muted, t, language) => guide.update(route, speedMps, muted, t, language),
    },
    speedMps: () => position.getSnapshot()?.speedMps ?? 0,
    setCarScreen: (on) => runtime.setCarScreen(on),
    connect: () => void autoConnect().catch((error) => console.warn("auto-connect failed", error)),
    note: (text) => recorder.note(text),
  });
}
