import { useEffect, useRef, useState } from "react";

import { useT } from "@/i18n/provider";
import { Announcer } from "@/nav/routing/announcer";
import type { RouteSnapshot } from "@/services/navigation/route-service";
import { kvStore } from "@/services/kv-store";

import { announcementPhrases } from "./voice-phrases";
import { hushVoice, sayPhrases } from "./voice-player";

const MUTED_KEY = "route.voice.muted";

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
    for (const a of said) sayPhrases(announcementPhrases(a, t, language), language);
  }, [route, speedMps, muted, t, language]);

  // Ending the route ends what it was saying.
  const active = route != null;
  useEffect(() => {
    if (!active) hushVoice();
  }, [active]);
}
