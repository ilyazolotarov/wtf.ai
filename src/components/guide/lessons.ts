import type { Strings } from "@/i18n/en";

export type LessonId = "before" | "dot" | "car" | "jamming" | "place" | "route" | "voice" | "maps";

export interface Lesson {
  id: LessonId;
  title: keyof Strings;
  sub: keyof Strings;
}

/** The Guide's lessons, in the order they are read; each group is a card in the Guide sheet. */
export const LESSON_GROUPS: { title: keyof Strings; lessons: Lesson[] }[] = [
  {
    title: "guideGroupStart",
    lessons: [
      { id: "before", title: "lessonBeforeTitle", sub: "lessonBeforeSub" },
      { id: "dot", title: "lessonDotTitle", sub: "lessonDotSub" },
      // Early: a first drive may well start with GPS jammed or spoofed.
      { id: "place", title: "lessonPlaceTitle", sub: "lessonPlaceSub" },
      { id: "car", title: "lessonCarTitle", sub: "lessonCarSub" },
    ],
  },
  { title: "guideGroupGpsFails", lessons: [{ id: "jamming", title: "lessonJammingTitle", sub: "lessonJammingSub" }] },
  {
    title: "guideGroupRoutes",
    lessons: [
      { id: "route", title: "lessonRouteTitle", sub: "lessonRouteSub" },
      { id: "voice", title: "lessonVoiceTitle", sub: "lessonVoiceSub" },
    ],
  },
  { title: "guideGroupMaps", lessons: [{ id: "maps", title: "lessonMapsTitle", sub: "lessonMapsSub" }] },
];
