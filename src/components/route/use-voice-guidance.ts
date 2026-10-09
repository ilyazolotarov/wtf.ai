import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useT } from "@/i18n/provider";
import { Announcer } from "@/nav/routing/announcer";
import type { RouteSnapshot } from "@/services/navigation/route-service";
import { kvStore } from "@/services/kv-store";
import { getRuntime } from "@/services/runtime";

import { announcementPhrases } from "./voice-phrases";
import { hushVoice, sayPhrases, setVoiceNote, setVoiceVolume } from "./voice-player";

const MUTED_KEY = "route.voice.muted";
const VOLUME_KEY = "route.voice.volume";

/**
 * The default volume: the clips are recorded loud (−15 LUFS, for loud music), and 80 % plays them 3.9 dB lower, near
 * −19 LUFS, the usual level of a voice assistant (ROUTING-SPEC §8.5).
 */
const DEFAULT_VOLUME = 0.8;
/** The player's gain for a volume: the square, so equal steps of the slider sound about equal. */
export const gainOf = (v: number) => v * v;

let volume: number | null = null;
const volumeListeners = new Set<() => void>();

/** The voice's volume, 0–1 (kept across launches). 0: no voice at all. */
export function loadVoiceVolume(): number {
  if (volume === null) {
    const v = kvStore.getJson<number>(VOLUME_KEY);
    volume = typeof v === "number" && v >= 0 && v <= 1 ? v : DEFAULT_VOLUME;
  }
  return volume;
}

export function saveVoiceVolume(v: number): void {
  volume = v;
  kvStore.setJson(VOLUME_KEY, v);
  setVoiceVolume(gainOf(v));
  if (v === 0) hushVoice();
  volumeListeners.forEach((l) => l());
}

const subscribeVolume = (l: () => void) => {
  volumeListeners.add(l);
  return () => void volumeListeners.delete(l);
};

/** The voice's volume, following Settings. */
export function useVoiceVolume(): number {
  return useSyncExternalStore(subscribeVolume, loadVoiceVolume);
}

/** Whether spoken guidance is off (kept across launches). */
export function useVoiceMuted(): [boolean, () => void] {
  const [muted, setMuted] = useState(() => kvStore.getJson<boolean>(MUTED_KEY) ?? false);
  const toggle = () => {
    const next = !muted;
    kvStore.setJson(MUTED_KEY, next);
    setMuted(next);
    if (next) hushVoice();
  };
  return [muted, toggle];
}

/**
 * Speaks the route's maneuvers (ROUTING-SPEC §8.5): ahead of each ("in 300 metres, turn left"), at it, a re-plan
 * and arrival, in recorded phrases where there are some (voice-player.ts).
 */
export function useVoiceGuidance(route: RouteSnapshot | null, speedMps: number | undefined, muted: boolean): void {
  const { t, language } = useT();
  const announcer = useRef<{ destination: RouteSnapshot["destination"]; announcer: Announcer } | null>(null);

  // What the voice says and what goes wrong with it, into the trip log.
  useEffect(() => {
    setVoiceNote((text) => getRuntime().recorder.note(text));
    setVoiceVolume(gainOf(loadVoiceVolume()));
  }, []);

  useEffect(() => {
    if (!route) {
      announcer.current = null;
      return;
    }
    // A new route starts afresh (its plan isn't a re-plan of the last one).
    if (announcer.current?.destination !== route.destination) announcer.current = { destination: route.destination, announcer: new Announcer() };
    if (route.status !== "active" || !route.guidance || !route.maneuvers) return;
    const said = announcer.current.announcer.update({
      planId: route.planId,
      maneuvers: route.maneuvers,
      guidance: route.guidance,
      speedMps: speedMps ?? 0,
    });
    if (muted) {
      if (said.length) getRuntime().recorder.note(`voice muted: ${said.map((a) => (a.kind === "maneuver" ? `${a.stage} ${a.maneuver.kind}` : a.kind)).join(", ")}`);
      return;
    }
    for (const a of said) sayPhrases(announcementPhrases(a, t, language), language);
  }, [route, speedMps, muted, t, language]);

  // Ending the route ends what it was saying.
  const active = route != null;
  useEffect(() => {
    if (!active) hushVoice();
  }, [active]);
}
