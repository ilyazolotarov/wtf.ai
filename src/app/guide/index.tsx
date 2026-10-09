import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";

import { AVAILABLE_GROUPS, AVAILABLE_LESSONS } from "@/components/guide/lesson-bodies";
import { ScreenContent, ScreenSection } from "@/components/screens/screen-ui";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { markTourOffered, requestTour, useLessonsDone } from "@/services/guide/guide-progress";

/** The Guide (UI-SPEC §7.7): the map tour and the lessons. */
export default function GuideScreen() {
  const { t } = useT();
  const palette = usePalette();
  const done = useLessonsDone();
  const doneCount = AVAILABLE_LESSONS.filter((lesson) => done.has(lesson.id)).length;

  const startTour = () => {
    markTourOffered();
    requestTour();
    // Back to the map, which takes the request when it is on top again.
    router.dismissAll();
  };

  return (
    <ScreenContent title={t("guideTitle")}>
      <T size={13} color={palette.text2} style={styles.progress}>
        {t("guideProgress").replace("{done}", String(doneCount)).replace("{total}", String(AVAILABLE_LESSONS.length))}
      </T>
      <Pressable
        onPress={startTour}
        accessibilityRole="button"
        style={({ pressed }) => [styles.tour, { backgroundColor: palette.accent }, pressed && styles.pressed]}
      >
        <View style={styles.tourCopy}>
          <T w="semibold" size={12} color={palette.onAccent} style={styles.kicker}>
            {t("guideTourKicker")}
          </T>
          <T w="semibold" size={18} color={palette.onAccent}>
            {t("guideTourTitle")}
          </T>
          <T size={13} color={palette.onAccent} style={styles.tourBody}>
            {t("guideTourBody")}
          </T>
        </View>
        <View style={[styles.play, { backgroundColor: palette.onAccent }]}>
          <Icon name="play_arrow" size={20} color={palette.accent} />
        </View>
      </Pressable>

      {AVAILABLE_GROUPS.map((group) => (
        <ScreenSection key={group.title} title={t(group.title)}>
          {group.lessons.map((lesson) => {
            const number = AVAILABLE_LESSONS.indexOf(lesson) + 1;
            const finished = done.has(lesson.id);
            return (
              <Pressable
                key={lesson.id}
                onPress={() => router.push(`/guide/lesson?id=${lesson.id}`)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <View style={[styles.badge, { backgroundColor: finished ? palette.ok.c : palette.surface }]}>
                  {finished ? (
                    <Icon name="check" size={15} color={palette.ok.fg} />
                  ) : (
                    <T w="semibold" size={13} color={palette.text2}>
                      {String(number)}
                    </T>
                  )}
                </View>
                <View style={styles.copy}>
                  <T w="medium" size={15}>
                    {t(lesson.title)}
                  </T>
                  <T size={13} color={palette.text2}>
                    {t(lesson.sub)}
                  </T>
                </View>
                <Icon name="chevron_right" size={14} color={palette.text2} />
              </Pressable>
            );
          })}
        </ScreenSection>
      ))}

      <Pressable
        onPress={() => router.push("/onboarding")}
        accessibilityRole="button"
        style={({ pressed }) => [styles.replay, pressed && styles.pressed]}
      >
        <T w="medium" size={14} color={palette.accent}>
          {t("guideReplayOnboarding")}
        </T>
      </Pressable>
    </ScreenContent>
  );
}

const styles = StyleSheet.create({
  progress: { marginTop: -8, paddingHorizontal: 4 },
  tour: {
    borderRadius: Radius.rL,
    padding: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderCurve: "continuous",
  },
  tourCopy: { flex: 1, gap: 4 },
  kicker: { letterSpacing: 0.4, opacity: 0.85 },
  tourBody: { lineHeight: 18, opacity: 0.9 },
  play: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  row: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  badge: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, gap: 2 },
  replay: { alignSelf: "center", paddingVertical: 10, paddingHorizontal: 14 },
  pressed: { opacity: 0.7 },
});
