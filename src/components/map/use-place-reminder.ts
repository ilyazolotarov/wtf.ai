import { useEffect, useRef } from "react";

import { placeCarPhrase } from "@/components/route/voice-phrases";
import { sayPhrases } from "@/components/route/voice-player";
import { useT } from "@/i18n/provider";
import { useRuntime, useVehicleLinkValue } from "@/providers/runtime-provider";

/** The reminder is for setting off: this long after the ignition comes on. */
const REMIND_WITHIN_MS = 2 * 60_000;

/**
 * Says "Show on the map where the car is" once when the ignition comes on while the map offers putting the car on
 * it (UI-SPEC §6.2): without a parked pose and without GPS, a drive started from nowhere stays lost, and the chip
 * alone was missed (2026-10-11: driven off 2 s after the engine started, placed by hand 2 min later).
 */
export function usePlaceReminder({ offered, muted }: { offered: boolean; muted: boolean }): void {
  const { t, language } = useT();
  const runtime = useRuntime();
  const engine = useVehicleLinkValue((s) => s.engine);
  const awake = engine === "engine-off" || engine === "engine-running";
  // When the ignition came on; cleared when it goes off (a link loss's `unknown` doesn't count as either).
  const onSince = useRef<number | null>(null);
  const said = useRef(false);
  useEffect(() => {
    if (engine === "ignition-off") {
      onSince.current = null;
      said.current = false;
    } else if (awake) onSince.current ??= Date.now();
  }, [engine, awake]);
  useEffect(() => {
    if (!offered || said.current || onSince.current === null) return;
    if (Date.now() - onSince.current > REMIND_WITHIN_MS) return;
    said.current = true;
    if (muted) runtime.recorder.note("voice muted: place-car");
    else sayPhrases([placeCarPhrase(t)], language);
  }, [offered, muted, engine, t, language, runtime]);
}
