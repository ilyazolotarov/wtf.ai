import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { StyleSheet, type ScrollViewInstance } from "react-native";

import { AVAILABLE_LESSONS, LessonBody } from "@/components/guide/lesson-bodies";
import { NextTabContext, ScrollLockContext, type NextTab } from "@/components/guide/lesson-ui";
import type { LessonId } from "@/components/guide/lessons";
import { ScreenContent } from "@/components/screens/screen-ui";
import { PressableFeedback } from "@/components/ui/press-feedback";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { markLessonDone } from "@/services/guide/guide-progress";

/**
 * One lesson of the Guide (UI-SPEC §7.7), `?id=`; its button marks it done and opens the next one. In a lesson with
 * tabs, until each was seen, the button opens the next tab (back up at the tabs) and a second one skips to the next
 * lesson.
 */
export default function LessonScreen() {
  const { t } = useT();
  const palette = usePalette();
  const { id } = useLocalSearchParams<{ id: LessonId }>();
  // A lesson's map being dragged (placing the car) holds the page still.
  const [locked, setLocked] = useState(false);
  const [nextTab, setNextTab] = useState<NextTab | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);
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
      scrollRef={scroll}
      scrollEnabled={!locked}
      title={t("guideLessonOf").replace("{n}", String(index + 1)).replace("{total}", String(AVAILABLE_LESSONS.length))}
    >
      <T w="semibold" size={26} style={styles.title}>
        {t(lesson.title)}
      </T>
      <ScrollLockContext value={setLocked}>
        <NextTabContext value={setNextTab}>
          <LessonBody id={lesson.id} />
        </NextTabContext>
      </ScrollLockContext>
      {nextTab && (
        <PressableFeedback
          onPress={() => {
            nextTab.show();
            scroll.current?.scrollTo({ y: Math.max(0, nextTab.y - 12), animated: true });
          }}
          accessibilityRole="button"
          style={[styles.next, { backgroundColor: palette.accent }]}
        >
          <T w="semibold" size={16} color={palette.onAccent} fit>
            {t("guideNextLesson").replace("{title}", nextTab.label)}
          </T>
        </PressableFeedback>
      )}
      <PressableFeedback
        onPress={finish}
        accessibilityRole="button"
        style={nextTab ? styles.skip : [styles.next, { backgroundColor: palette.accent }]}
      >
        <T w="semibold" size={nextTab ? 15 : 16} color={nextTab ? palette.accent : palette.onAccent} fit>
          {nextTab
            ? next
              ? t("guideSkipTo").replace("{title}", t(next.title))
              : t("guideAllDone")
            : next
              ? t("guideNextLesson").replace("{title}", t(next.title))
              : t("guideAllDone")}
        </T>
      </PressableFeedback>
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
  skip: { minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: 20, marginTop: -8 },
});
