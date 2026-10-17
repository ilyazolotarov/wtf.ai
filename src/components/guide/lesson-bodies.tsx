import { router } from "expo-router";

import { LessonBefore } from "@/components/guide/lesson-before";
import { LessonCar } from "@/components/guide/lesson-car";
import { LessonDot } from "@/components/guide/lesson-dot";
import { LessonJamming } from "@/components/guide/lesson-jamming";
import { LessonMaps } from "@/components/guide/lesson-maps";
import { LessonPlace } from "@/components/guide/lesson-place";
import { LessonRoute } from "@/components/guide/lesson-route";
import { LessonVoice } from "@/components/guide/lesson-voice";
import { LESSON_GROUPS, type Lesson, type LessonId } from "@/components/guide/lessons";
import { lessonsDone } from "@/services/guide/guide-progress";

/** The lessons built so far; the Guide lists only these. */
const BUILT: ReadonlySet<LessonId> = new Set(["before", "dot", "car", "jamming", "place", "route", "voice", "maps"]);

/** One lesson's content, below its title. */
export function LessonBody({ id }: { id: LessonId }) {
  switch (id) {
    case "before":
      return <LessonBefore />;
    case "dot":
      return <LessonDot />;
    case "car":
      return <LessonCar />;
    case "jamming":
      return <LessonJamming />;
    case "place":
      return <LessonPlace />;
    case "route":
      return <LessonRoute />;
    case "voice":
      return <LessonVoice />;
    case "maps":
      return <LessonMaps />;
    default:
      return null;
  }
}

/** The Guide's groups, with only the lessons that exist; empty groups dropped. */
export const AVAILABLE_GROUPS = LESSON_GROUPS.map((group) => ({
  ...group,
  lessons: group.lessons.filter((lesson) => BUILT.has(lesson.id)),
})).filter((group) => group.lessons.length > 0);

/** All available lessons in reading order. */
export const AVAILABLE_LESSONS: Lesson[] = AVAILABLE_GROUPS.flatMap((group) => group.lessons);

/** The first lesson not done yet (all done: the first). */
export function nextLesson(done: ReadonlySet<string> = lessonsDone()): Lesson {
  return AVAILABLE_LESSONS.find((lesson) => !done.has(lesson.id)) ?? AVAILABLE_LESSONS[0];
}

/** The Guide with the next lesson open over it, so back leads to the list. */
export function openLessons(): void {
  router.push("/guide");
  router.push(`/guide/lesson?id=${nextLesson().id}`);
}
