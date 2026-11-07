import { useEffect, useRef } from "react";

import { placeCarPhrase } from "@/components/route/voice-phrases";
import { sayOnSpeaker } from "@/components/route/voice-player";
import { useT } from "@/i18n/provider";
import type { PositionEstimate } from "@/nav/position/types";
import { useRuntime, useVehicleLinkValue } from "@/providers/runtime-provider";

import {
  canPlayOnSpeaker,
  currentAudioOutput,
  isOffPhone,
  onAudioOutput,
  type AudioOutput,
} from "../../../modules/audio-output/src/AudioOutputModule";

/** The reminder is for setting off: this long after the engine starts. */
const REMIND_WITHIN_MS = 2 * 60_000;
/** Where it can't be played on the phone's speaker: said again when the audio moves to the car this soon after. */
export const AGAIN_WITHIN_MS = 20_000;
/** …this long after the move, for the car to switch to the phone's audio. */
export const AGAIN_AFTER_MS = 2_000;
/**
 * The dot to judge "lost" by: the car's, or the one shown when none of the car's comes (`waitingForCar`). The dot from
 * before the car answered is the phone's own, with no direction: on 2026-10-12..11-07 the reminder was said on it at
 * 17 starts with a parked pose stored, and a second later the navigator put the car on that pose, a direction and
 * ±3–63 m.
 */
export function dotSettled(dot: Pick<PositionEstimate, "waitingForCar"> | null): boolean {
  return dot != null && !dot.waitingForCar;
}

/**
 * Says "Show on the map where the car is" once when the engine starts while the map offers putting the car on it
 * (UI-SPEC §6.2): without a parked pose and without GPS, a drive started from nowhere stays lost, and the chip alone
 * was missed (2026-10-11: driven off 2 s after the engine started, placed by hand 2 min later). Not on the ECU merely
 * answering (`engine-off`): a parked car's ECU wakes now and then, a door or the boot opened, and the phone in the
 * house in the adapter's range heard it as the ignition coming on. Not on the dot from before the car answered
 * either (`dotSettled`). On the phone's speaker where it can be (Android): the car's Bluetooth is still connecting
 * then, or plays another source.
 */
export function usePlaceReminder({
  offered,
  muted,
  dot,
}: {
  offered: boolean;
  muted: boolean;
  /** The dot on the map. */
  dot: Pick<PositionEstimate, "waitingForCar"> | null;
}): void {
  const { t, language } = useT();
  const runtime = useRuntime();
  const engine = useVehicleLinkValue((s) => s.engine);
  // When the engine started; cleared when the ignition goes off (a link loss's `unknown` doesn't count as either, and
  // an auto stop-start's `engine-off` keeps it).
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
    } else if (engine === "engine-running") onSince.current ??= Date.now();
  }, [engine]);
  useEffect(() => {
    if (!offered || said.current || onSince.current === null || !dotSettled(dot)) return;
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
  }, [offered, muted, engine, dot, t, language, runtime]);
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
