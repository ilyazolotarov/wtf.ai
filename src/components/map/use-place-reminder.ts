import { useEffect, useRef } from "react";

import { placeCarPhrase } from "@/components/route/voice-phrases";
import { sayOnSpeaker } from "@/components/route/voice-player";
import { useT } from "@/i18n/provider";
import { useRuntime, useVehicleLinkValue } from "@/providers/runtime-provider";

import {
  canPlayOnSpeaker,
  currentAudioOutput,
  isOffPhone,
  onAudioOutput,
  type AudioOutput,
} from "../../../modules/audio-output/src/AudioOutputModule";

/** The reminder is for setting off: this long after the ignition comes on. */
const REMIND_WITHIN_MS = 2 * 60_000;
/** Where it can't be played on the phone's speaker: said again when the audio moves to the car this soon after. */
export const AGAIN_WITHIN_MS = 20_000;
/** …this long after the move, for the car to switch to the phone's audio. */
export const AGAIN_AFTER_MS = 2_000;

/**
 * Says "Show on the map where the car is" once when the ignition comes on while the map offers putting the car on
 * it (UI-SPEC §6.2): without a parked pose and without GPS, a drive started from nowhere stays lost, and the chip
 * alone was missed (2026-10-11: driven off 2 s after the engine started, placed by hand 2 min later). On the phone's
 * speaker where it can be (Android): the car's Bluetooth is still connecting then, or plays another source.
 */
export function usePlaceReminder({ offered, muted }: { offered: boolean; muted: boolean }): void {
  const { t, language } = useT();
  const runtime = useRuntime();
  const engine = useVehicleLinkValue((s) => s.engine);
  const awake = engine === "engine-off" || engine === "engine-running";
  // When the ignition came on; cleared when it goes off (a link loss's `unknown` doesn't count as either).
  const onSince = useRef<number | null>(null);
  const said = useRef(false);
  // Whether it is still worth saying again: the chip offered and the voice not muted.
  const wanted = useRef(false);
  const stopWatching = useRef<(() => void) | null>(null);
  useEffect(() => {
    wanted.current = offered && !muted;
  }, [offered, muted]);
  useEffect(() => () => stopWatching.current?.(), []);
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
    if (muted) {
      runtime.recorder.note("voice muted: place-car");
      return;
    }
    const say = () => sayOnSpeaker([placeCarPhrase(t)], language);
    say();
    if (canPlayOnSpeaker) return;
    stopWatching.current?.();
    stopWatching.current = sayAgainOnCarAudio(currentAudioOutput(), onAudioOutput, (to) => {
      if (!wanted.current) return;
      runtime.recorder.note(`voice: place-car again, the audio moved to ${to.kind}${to.name ? ` "${to.name}"` : ""}`);
      say();
    });
  }, [offered, muted, engine, t, language, runtime]);
}

/**
 * Calls `again` once, `AGAIN_AFTER_MS` after the audio moves off the phone (a car's Bluetooth connecting) within
 * `AGAIN_WITHIN_MS`: what was said meanwhile went to a car still switching over, or to nowhere. A change that keeps
 * the output (the voice setting its audio mode) is no move. Returns the call that stops watching.
 */
export function sayAgainOnCarAudio(
  from: AudioOutput | null,
  subscribe: (fn: (o: AudioOutput) => void) => () => void,
  again: (to: AudioOutput) => void,
): () => void {
  const was = from && `${from.kind} ${from.name}`;
  let delay: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = subscribe((o) => {
    if (!isOffPhone(o) || `${o.kind} ${o.name}` === was) return;
    stop();
    delay = setTimeout(() => again(o), AGAIN_AFTER_MS);
  });
  const window = setTimeout(stop, AGAIN_WITHIN_MS);
  function stop() {
    unsubscribe();
    clearTimeout(window);
  }
  return () => {
    stop();
    clearTimeout(delay);
  };
}
