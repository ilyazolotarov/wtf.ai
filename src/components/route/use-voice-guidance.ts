import * as Speech from "expo-speech";
import { useEffect, useRef, useState } from "react";

import { useT } from "@/i18n/provider";
import { Announcer, type Announcement } from "@/nav/routing/announcer";
import type { Maneuver } from "@/nav/routing/maneuvers";
import type { RouteSnapshot } from "@/services/navigation/route-service";
import { kvStore } from "@/services/kv-store";

import { MANEUVER_TEXT } from "./guidance-text";

const MUTED_KEY = "route.voice.muted";

/** Whether spoken guidance is off (kept across launches). */
export function useVoiceMuted(): [boolean, () => void] {
  const [muted, setMuted] = useState(() => kvStore.getJson<boolean>(MUTED_KEY) ?? false);
  const toggle = () => {
    const next = !muted;
    kvStore.setJson(MUTED_KEY, next);
    setMuted(next);
    if (next) void Speech.stop();
  };
  return [muted, toggle];
}

/**
 * Speaks the route's maneuvers (ROUTING-SPEC §8.6): ahead of each ("in 300 metres, turn left"), at it, a re-plan
 * and arrival. iPhone speech is silent while the ring/silent switch is on.
 */
export function useVoiceGuidance(route: RouteSnapshot | null, speedMps: number | undefined, muted: boolean): void {
  const { t, language } = useT();
  const announcer = useRef<{ destination: RouteSnapshot["destination"]; announcer: Announcer } | null>(null);

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
    if (muted) return;
    const locale = language === "uk" ? "uk-UA" : "en-US";
    const instruction = (m: Maneuver) => t(MANEUVER_TEXT[m.kind]).replace("{n}", String(m.exit ?? 1));
    const lower = (s: string) => s.charAt(0).toLocaleLowerCase(locale) + s.slice(1);
    const text = (a: Announcement): string => {
      switch (a.kind) {
        case "replanned":
          return t("sayReplanned");
        case "arrived":
          return t("arrived");
        case "maneuver":
          if (a.stage === "prepare") {
            return `${t("sayIn").replace("{d}", t("sayMetres").replace("{n}", String(a.distanceM)))}, ${lower(instruction(a.maneuver))}`;
          }
          return a.then ? `${instruction(a.maneuver)}, ${t("thenManeuver")} ${lower(instruction(a.then))}` : instruction(a.maneuver);
      }
    };
    for (const a of said) Speech.speak(text(a), { language: locale, useApplicationAudioSession: false });
  }, [route, speedMps, muted, t, language]);

  // Ending the route ends what it was saying.
  const active = route != null;
  useEffect(() => {
    if (!active) void Speech.stop();
  }, [active]);
}
