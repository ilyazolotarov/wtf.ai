import * as Sentry from "@sentry/react-native";
import { AppState } from "react-native";

import { speedAlerts } from "@/components/map/use-speed-alerts";
import { findPlaces } from "@/components/route/place-search";
import { formatDistance } from "@/components/status/format-geo";
import { adapterStatusOf } from "@/components/status/use-nav-status";
import {
  gainOf,
  loadVoiceMuted,
  loadVoiceVolume,
  saveVoiceMuted,
  subscribeVoiceMuted,
  subscribeVoiceVolume,
  VoiceGuide,
} from "@/components/route/use-voice-guidance";
import { hushVoice, setVoiceAsGuidance, setVoiceNote, setVoiceVolume } from "@/components/route/voice-player";
import { initSentry } from "@/config/sentry";
import { appStrings, subscribeAppLanguage } from "@/i18n/provider";
import { haversineM } from "@/nav/geo";
import { inBounds, places } from "@/providers/places";
import { destinations } from "@/providers/route-provider";
import { heldRoute, holdRouteForGuide, onHeldRoute, takeHeldRoute } from "@/services/navigation/route-without-adapter";
import { TestDrive } from "@/services/navigation/test-drive";
import { getMapPacks, subscribeMapPacks } from "@/services/offline-map/map-packs";
import { activeSearchIndex } from "@/services/offline-map/search-file";
import { autoConnect, getRuntime } from "@/services/runtime";

import AndroidAuto from "../../../modules/android-auto/src/AndroidAutoModule";
import CarPlay from "../../../modules/car-play/src/CarPlayModule";
import { runCarSession, type CarSessionDeps } from "./car-session";

/** A route goes by the street of the houses within this of its own stretch (`viaNames`). */
const VIA_HOUSE_M = 60;

/**
 * On every Sentry event while a car's screen session runs, the native crash reports too (the SDK copies the scope's
 * tags to the native one): `carplay` or `android-auto`, then `none` when it ends (an empty tag would reach the native
 * SDK as nil).
 */
const CAR_SCREEN_TAG = "car_screen";

/** The headless task's name (CarSessionTask.TASK in modules/android-auto). */
export const CAR_SESSION_TASK = "WtfCarSession";

/** Android Auto's car screen connected (docs/ANDROID-AUTO-SPEC.md §3): runs until it is gone. */
export async function carSessionTask(): Promise<void> {
  if (!AndroidAuto) return;
  await runCarScreen(AndroidAuto, "android auto", "android-auto", false);
}

let carPlayRunning = false;

/** A session for CarPlay's connection while it is open and none runs. */
function startCarPlaySession(): void {
  const native = CarPlay;
  if (!native || carPlayRunning || !native.isConnected()) return;
  carPlayRunning = true;
  void runCarScreen(native, "carplay", "carplay", true).finally(() => {
    carPlayRunning = false;
  });
}

/**
 * CarPlay's car screen (docs/CARPLAY-SPEC.md §4): a session for each connection of its scene, in the app's one JS
 * runtime (index.ts). A runtime that comes up while the car is connected (a launch from the car, a reload) starts one
 * at once; the native side kept what the last one sent.
 */
export function listenForCarPlay(): void {
  if (!CarPlay) return;
  CarPlay.addListener("onConnect", startCarPlaySession);
  startCarPlaySession();
}

/**
 * The car's map mounted (CarMapRoot): the car shows the app, so a session must run. One does, unless its start was
 * missed; then it starts here, and the trip log says so (2026-10-30: launched from the car's screen after a force-quit,
 * the map showed and Destinations and Search behaved as if the phone didn't answer, and the run's log has no mark of
 * a session; the cause is open).
 */
export function ensureCarPlaySession(): void {
  if (!CarPlay || carPlayRunning || !CarPlay.isConnected()) return;
  getRuntime().recorder.note("carplay: no session was running with the car's map shown: started");
  startCarPlaySession();
}

/**
 * One connection of a car's screen, the same on both platforms but for its native side, its name in the log, and
 * whether its words may send the driver to the phone (`phoneFree`: CarPlay's may not).
 */
async function runCarScreen(native: CarSessionDeps["native"], name: string, feature: string, phoneFree: boolean): Promise<void> {
  // The process may have started for the car, the phone's screens (and the root layout's setup) never loaded.
  initSentry();
  Sentry.setTag(CAR_SCREEN_TAG, feature);
  const runtime = getRuntime();
  const { recorder, routes, position, link } = runtime;
  // The voice as the phone's map sets it up: its notes, the driver's volume (Settings), and as navigation guidance,
  // which the car mixes over whatever it plays (ROUTING-SPEC §8.5).
  setVoiceNote((text) => recorder.note(text));
  setVoiceVolume(gainOf(loadVoiceVolume()));
  setVoiceAsGuidance(true);
  const guide = new VoiceGuide();
  const testDrive = new TestDrive({
    routes,
    show: (dot) => position.setTestDrive(dot && { lat: dot.lat, lon: dot.lon, headingRad: dot.headingRad, speedMps: dot.speedMps }),
    every: (ms, fn) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
    nowMs: Date.now,
    note: (text) => recorder.note(text),
  });
  try {
    await runCarSession({
      name,
      phoneFree,
      native,
      routes,
      places,
      held: { get: heldRoute, hold: holdRouteForGuide, take: takeHeldRoute, subscribe: onHeldRoute },
      map: { installed: () => getMapPacks().installed.active != null, subscribe: subscribeMapPacks },
      withoutAdapter: () => runtime.getDevSettings().phoneOnly && adapterStatusOf(link.getSnapshot()) !== "on",
      positionSet: () => {
        const p = position.getSnapshot();
        return p?.manual != null || p?.trust === "TRUSTED";
      },
      strings: appStrings,
      subscribeLanguage: subscribeAppLanguage,
      subscribePhoneInFront: (listener) => {
        const sub = AppState.addEventListener("change", (state) => {
          if (state === "active") listener();
        });
        return () => sub.remove();
      },
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
        hush: hushVoice,
      },
      speedMps: () => position.getSnapshot()?.speedMps ?? 0,
      speed: speedAlerts(),
      // As the phone's route screen searches: the active region, near the car; its cities without an index.
      find: (text) => {
        const { language, t } = appStrings();
        const { installed } = getMapPacks();
        const bounds = (installed.active ? installed.regions[installed.active]?.bounds : null) ?? null;
        const cities = destinations
          .filter((d) => inBounds(bounds, d))
          .map((d) => ({ id: d.id, title: d.name[language], detail: null, lat: d.lat, lon: d.lon }));
        return findPlaces(text, { index: activeSearchIndex(installed), bounds, near: position.getSnapshot(), cities, language, t });
      },
      testDrive,
      streetAt: (at, language) => {
        const address = activeSearchIndex(getMapPacks().installed)?.nearestAddress(at, VIA_HOUSE_M);
        return address ? (language === "en" ? (address.nameEn ?? address.name) : address.name) : null;
      },
      away: (at) => {
        const from = position.getSnapshot();
        return from ? formatDistance(haversineM(from, at), appStrings().language) : null;
      },
      located: () => position.getPermission().then((p) => p.granted),
      retryLocation: () => position.retryCapture(),
      setCarScreen: (on) => runtime.setCarScreen(on),
      connect: () => void autoConnect().catch((error) => console.warn("auto-connect failed", error)),
      note: (text) => recorder.note(text),
      report: (text) => Sentry.captureMessage(text, { level: "warning", tags: { feature } }),
      every: (ms, fn) => {
        const id = setInterval(fn, ms);
        return () => clearInterval(id);
      },
    });
  } finally {
    setVoiceAsGuidance(false);
    Sentry.setTag(CAR_SCREEN_TAG, "none");
  }
}
