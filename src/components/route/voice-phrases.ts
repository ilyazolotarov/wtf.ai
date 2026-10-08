// What the route voice says (ROUTING-SPEC §8.5), as phrases with stable ids: the app plays the recorded clip of a
// phrase when it has one (tools/voice) and speaks the text otherwise. No React Native imports: the clip renderer
// runs this in Node.

import type { Strings } from "@/i18n/en";
import { SPOKEN_DISTANCES_M, type Announcement } from "@/nav/routing/announcer";
import type { Maneuver, ManeuverKind } from "@/nav/routing/maneuvers";

import { MANEUVER_TEXT } from "./guidance-text";

export type VoiceLang = "en" | "uk";
type T = (key: keyof Strings) => string;

export interface Phrase {
  /** The clip's file name, e.g. `ahead-300-left`, `now-roundabout-2`. */
  id: string;
  text: string;
}

/** Roundabout exits with a recorded phrase; later ones are spoken by the system voice. */
const RECORDED_EXITS = 6;
/** Maneuvers said ahead of and at them (the route's start and end have their own words). */
const SPOKEN_KINDS: ManeuverKind[] = [
  "slight-left",
  "slight-right",
  "left",
  "right",
  "sharp-left",
  "sharp-right",
  "keep-left",
  "keep-right",
  "u-turn",
  "roundabout",
];

const locale = (lang: VoiceLang) => (lang === "uk" ? "uk-UA" : "en-US");
const lower = (s: string, lang: VoiceLang) => s.charAt(0).toLocaleLowerCase(locale(lang)) + s.slice(1);

function instruction(m: Pick<Maneuver, "kind" | "exit">, t: T): Phrase {
  if (m.kind !== "roundabout") return { id: m.kind, text: t(MANEUVER_TEXT[m.kind]) };
  const n = m.exit ?? 1;
  const nth = t("sayOrdinals").split("|")[n - 1] ?? t(MANEUVER_TEXT.roundabout).replace("{n}", String(n));
  return { id: `roundabout-${n}`, text: t("sayRoundabout").replace("{nth}", nth) };
}

/** In words: a voice may read digits wrong ("50" as "50th"). */
function distance(m: number, t: T): string {
  const i = (SPOKEN_DISTANCES_M as readonly number[]).indexOf(m);
  return t("sayDistances").split("|")[i] ?? t("sayMetres").replace("{n}", String(m));
}

function ahead(m: Pick<Maneuver, "kind" | "exit">, distanceM: number, t: T, lang: VoiceLang): Phrase {
  const i = instruction(m, t);
  return { id: `ahead-${distanceM}-${i.id}`, text: `${t("sayIn").replace("{d}", distance(distanceM, t))}, ${lower(i.text, lang)}` };
}

function then(m: Pick<Maneuver, "kind" | "exit">, t: T, lang: VoiceLang): Phrase {
  if (m.kind === "arrive") return { id: "then-arrive", text: t("sayThenArrive") };
  const i = instruction(m, t);
  return { id: `then-${i.id}`, text: `${t("thenManeuver")} ${lower(i.text, lang)}` };
}

/** What to say for an announcement, in order: one phrase, or the maneuver and "then …" for the one right after. */
export function announcementPhrases(a: Announcement, t: T, lang: VoiceLang): Phrase[] {
  switch (a.kind) {
    case "replanned":
      return [{ id: "replanned", text: t("sayReplanned") }];
    case "arrived":
      return [{ id: "arrived", text: t("arrived") }];
    case "maneuver": {
      if (a.stage === "prepare") return [ahead(a.maneuver, a.distanceM, t, lang)];
      const i = instruction(a.maneuver, t);
      const now = { id: `now-${i.id}`, text: i.text };
      return a.then ? [now, then(a.then, t, lang)] : [now];
    }
  }
}

/** Every phrase that gets a recorded clip. */
export function recordedPhrases(t: T, lang: VoiceLang): Phrase[] {
  const maneuvers = SPOKEN_KINDS.flatMap((kind): Pick<Maneuver, "kind" | "exit">[] =>
    kind === "roundabout" ? Array.from({ length: RECORDED_EXITS }, (_, i) => ({ kind, exit: i + 1 })) : [{ kind }],
  );
  return [
    { id: "replanned", text: t("sayReplanned") },
    { id: "arrived", text: t("arrived") },
    ...maneuvers.map((m) => {
      const i = instruction(m, t);
      return { id: `now-${i.id}`, text: i.text };
    }),
    ...[...maneuvers, { kind: "arrive" as const }].map((m) => then(m, t, lang)),
    ...SPOKEN_DISTANCES_M.flatMap((d) => maneuvers.map((m) => ahead(m, d, t, lang))),
  ];
}
