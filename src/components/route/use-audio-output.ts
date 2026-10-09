import { useEffect, useState } from "react";

import { getRuntime } from "@/services/runtime";

import { type AudioOutput, currentAudioOutput, onAudioOutput } from "../../../modules/audio-output/src/AudioOutputModule";

const describe = (o: AudioOutput) => `${o.kind}${o.name ? ` "${o.name}"` : ""}${o.reason ? ` (${o.reason})` : ""}`;

/** The phone's own outputs: the voice is heard there whatever the car plays. */
const ON_THE_PHONE = new Set<AudioOutput["kind"]>(["speaker", "receiver", "wired", "none"]);

/**
 * Where the route voice goes while a route is on (ROUTING-SPEC §8.5), into the trip log at the start and on each
 * change. `offPhone`: somewhere off the phone (a car's Bluetooth, silent when the car plays another source).
 */
export function useAudioOutput(active: boolean): { output: AudioOutput | null; offPhone: boolean } {
  const [output, setOutput] = useState<AudioOutput | null>(null);

  useEffect(() => {
    if (!active) return;
    let last = "";
    const seen = (o: AudioOutput | null, first: boolean) => {
      // A change of category (the voice setting its audio mode) keeps the output: nothing to say.
      if (!o || `${o.kind} ${o.name}` === last) return;
      last = `${o.kind} ${o.name}`;
      setOutput(o);
      getRuntime().recorder.note(`${first ? "audio output" : "audio output now"}: ${describe(o)}`);
    };
    seen(currentAudioOutput(), true);
    return onAudioOutput((o) => seen(o, false));
  }, [active]);

  const now = active ? output : null;
  return { output: now, offPhone: now != null && !ON_THE_PHONE.has(now.kind) };
}
