import { LessonBefore } from "@/components/guide/lesson-before";
import { LessonCar } from "@/components/guide/lesson-car";
import { LessonDot } from "@/components/guide/lesson-dot";
import { LessonJamming } from "@/components/guide/lesson-jamming";
import { LessonMaps } from "@/components/guide/lesson-maps";
import { LessonPlace } from "@/components/guide/lesson-place";
import { LessonPose } from "@/components/guide/lesson-pose";
import { LessonRoute } from "@/components/guide/lesson-route";
import { LessonVoice } from "@/components/guide/lesson-voice";
import { LESSON_GROUPS, type Lesson, type LessonId } from "@/components/guide/lessons";

/** The lessons built so far; the Guide lists only these. */
const BUILT: ReadonlySet<LessonId> = new Set(["before", "dot", "car", "jamming", "place", "pose", "route", "voice", "maps"]);

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
    case "pose":
      return <LessonPose />;
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
