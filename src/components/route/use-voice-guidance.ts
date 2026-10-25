import { useEffect, useState, useSyncExternalStore } from "react";

import type { Strings } from "@/i18n/en";
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

export const subscribeVoiceVolume = (l: () => void) => {
  volumeListeners.add(l);
  return () => void volumeListeners.delete(l);
};

/** The voice's volume, following Settings. */
export function useVoiceVolume(): number {
  return useSyncExternalStore(subscribeVoiceVolume, loadVoiceVolume);
}

let mutedSetting: boolean | null = null;
const mutedListeners = new Set<() => void>();

/** Whether spoken guidance is off (kept across launches): the map's button, and the car screen's. */
export function loadVoiceMuted(): boolean {
  mutedSetting ??= kvStore.getJson<boolean>(MUTED_KEY) ?? false;
  return mutedSetting;
}

export function saveVoiceMuted(next: boolean): void {
  mutedSetting = next;
  kvStore.setJson(MUTED_KEY, next);
  if (next) hushVoice();
  mutedListeners.forEach((l) => l());
}

export const subscribeVoiceMuted = (l: () => void) => {
  mutedListeners.add(l);
  return () => void mutedListeners.delete(l);
};

/** Whether spoken guidance is off, and the toggle. */
export function useVoiceMuted(): [boolean, () => void] {
  const value = useSyncExternalStore(subscribeVoiceMuted, loadVoiceMuted);
  return [value, () => saveVoiceMuted(!value)];
}

/**
 * Who speaks the route: one voice however many screens show it (the phone's map, the car's screen). The first to claim
 * it speaks; the others follow the route in silence, ready to take over when it lets go.
 */
const voiceClaims: VoiceGuide[] = [];

/**
 * One screen's guidance voice (ROUTING-SPEC §8.5): ahead of each maneuver ("in 300 metres, turn left"), at it, a
 * re-plan and arrival, in recorded phrases where there are some (voice-player.ts). Said only while it holds the voice.
 */
export class VoiceGuide {
  private current: { destination: RouteSnapshot["destination"]; announcer: Announcer } | null = null;

  /** Speak when first among the claims; returns the release. */
  claim(): () => void {
    voiceClaims.push(this);
    return () => {
      const i = voiceClaims.indexOf(this);
      if (i >= 0) voiceClaims.splice(i, 1);
    };
  }

  update(route: RouteSnapshot | null, speedMps: number, muted: boolean, t: (key: keyof Strings) => string, language: "en" | "uk"): void {
    if (!route) {
      this.current = null;
      return;
    }
    // A new route starts afresh (its plan isn't a re-plan of the last one).
    if (this.current?.destination !== route.destination) this.current = { destination: route.destination, announcer: new Announcer() };
    if (route.status !== "active" || !route.guidance || !route.maneuvers) return;
    const said = this.current.announcer.update({
      planId: route.planId,
      planReason: route.planReason,
      maneuvers: route.maneuvers,
      guidance: route.guidance,
      speedMps,
    });
    if (!said.length || voiceClaims[0] !== this) return;
    if (muted) {
      getRuntime().recorder.note(`voice muted: ${said.map((a) => (a.kind === "maneuver" ? `${a.stage} ${a.maneuver.kind}` : a.kind)).join(", ")}`);
      return;
    }
    for (const a of said) sayPhrases(announcementPhrases(a, t, language), language);
  }
}

/** Speaks the route's maneuvers on this screen (`VoiceGuide`). */
export function useVoiceGuidance(route: RouteSnapshot | null, speedMps: number | undefined, muted: boolean): void {
  const { t, language } = useT();
  const [guide] = useState(() => new VoiceGuide());

  // What the voice says and what goes wrong with it, into the trip log.
  useEffect(() => {
    setVoiceNote((text) => getRuntime().recorder.note(text));
    setVoiceVolume(gainOf(loadVoiceVolume()));
    return guide.claim();
  }, [guide]);

  useEffect(() => {
    guide.update(route, speedMps ?? 0, muted, t, language);
  }, [guide, route, speedMps, muted, t, language]);

  // Ending the route ends what it was saying.
  const active = route != null;
  useEffect(() => {
    if (!active) hushVoice();
  }, [active]);
}
