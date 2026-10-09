import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet } from "react-native";

import { AVAILABLE_LESSONS, LessonBody } from "@/components/guide/lesson-bodies";
import { ScrollLockContext } from "@/components/guide/lesson-ui";
import type { LessonId } from "@/components/guide/lessons";
import { ScreenContent } from "@/components/screens/screen-ui";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { markLessonDone } from "@/services/guide/guide-progress";

/** One lesson of the Guide (UI-SPEC §7.7), `?id=`; its button marks it done and opens the next one. */
export default function LessonScreen() {
  const { t } = useT();
  const palette = usePalette();
  const { id } = useLocalSearchParams<{ id: LessonId }>();
  // A lesson's map being dragged (placing the car) holds the page still.
  const [locked, setLocked] = useState(false);
  const index = AVAILABLE_LESSONS.findIndex((lesson) => lesson.id === id);
  const lesson = AVAILABLE_LESSONS[index];
  if (!lesson) return <ScreenContent title={t("guideTitle")} />;
  const next = AVAILABLE_LESSONS[index + 1];

  const finish = () => {
    markLessonDone(lesson.id);
    if (next) router.setParams({ id: next.id });
    else router.back();
  };

  return (
    // Keyed by lesson: the next one starts at the top, with its own state.
    <ScreenContent
      key={lesson.id}
      scrollEnabled={!locked}
      title={t("guideLessonOf").replace("{n}", String(index + 1)).replace("{total}", String(AVAILABLE_LESSONS.length))}
    >
      <T w="semibold" size={26} style={styles.title}>
        {t(lesson.title)}
      </T>
      <ScrollLockContext value={setLocked}>
        <LessonBody id={lesson.id} />
      </ScrollLockContext>
      <Pressable
        onPress={finish}
        accessibilityRole="button"
        style={({ pressed }) => [styles.next, { backgroundColor: palette.accent }, pressed && styles.pressed]}
      >
        <T w="semibold" size={16} color={palette.onAccent} numberOfLines={1}>
          {next ? t("guideNextLesson").replace("{title}", t(next.title)) : t("guideAllDone")}
        </T>
      </Pressable>
    </ScreenContent>
  );
}

const styles = StyleSheet.create({
  title: { lineHeight: 31, letterSpacing: -0.5, marginBottom: -6 },
  next: {
    height: 54,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    marginTop: 4,
  },
  pressed: { opacity: 0.8 },
});
