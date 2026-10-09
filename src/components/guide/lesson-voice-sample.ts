import { gainOf, loadVoiceVolume } from "@/components/route/use-voice-guidance";
import { hushVoice, sayPhrases, setVoiceVolume } from "@/components/route/voice-player";
import { announcementPhrases, type VoiceLang } from "@/components/route/voice-phrases";
import type { Strings } from "@/i18n/en";
import { spokenDistanceM } from "@/nav/routing/announcer";
import type { Maneuver } from "@/nav/routing/maneuvers";

/**
 * Says a lesson route's first instruction as guidance says it ahead of the turn ("In 200 metres, turn right"; the
 * recorded clips), at `volume` (0–1, the driver's own by default). The player goes back to the driver's volume at
 * once: a clip keeps the gain it started with.
 */
export function sayFirstInstruction(
  maneuvers: Maneuver[] | undefined,
  t: (key: keyof Strings) => string,
  lang: VoiceLang,
  volume = loadVoiceVolume(),
): void {
  const turn = maneuvers?.find((m) => m.kind !== "depart" && m.kind !== "arrive");
  if (!turn || volume === 0) return;
  hushVoice();
  setVoiceVolume(gainOf(volume));
  sayPhrases(
    announcementPhrases(
      { kind: "maneuver", stage: "prepare", maneuver: turn, distanceM: spokenDistanceM(turn.atM), then: null },
      t,
      lang,
    ),
    lang,
  );
  setVoiceVolume(gainOf(loadVoiceVolume()));
}
