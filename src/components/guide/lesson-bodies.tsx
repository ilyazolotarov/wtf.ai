import { LessonBefore } from "@/components/guide/lesson-before";
import { LessonCar } from "@/components/guide/lesson-car";
import { LessonDot } from "@/components/guide/lesson-dot";
import { LESSON_GROUPS, type Lesson, type LessonId } from "@/components/guide/lessons";

/** The lessons built so far; the Guide lists only these. */
const BUILT: ReadonlySet<LessonId> = new Set(["before", "dot", "car"]);

/** One lesson's content, below its title. */
export function LessonBody({ id }: { id: LessonId }) {
  switch (id) {
    case "before":
      return <LessonBefore />;
    case "dot":
      return <LessonDot />;
    case "car":
      return <LessonCar />;
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
