import { router } from "expo-router";
import { Fragment, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { LessonIntro } from "@/components/guide/lesson-ui";
import { useNavStatus } from "@/components/status/use-nav-status";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";
import { useMapPacks } from "@/services/offline-map/map-packs";

type Tick = "holder" | "open" | "charge";

/** Lesson 1: a checklist before driving. The map and the adapter are read from the app; the rest the driver ticks. */
export function LessonBefore() {
  const { t, language } = useT();
  const palette = usePalette();
  const nav = useNavStatus();
  const { installed } = useMapPacks();
  const [ticked, setTicked] = useState<ReadonlySet<Tick>>(new Set());
  const region = installed.active ? installed.regions[installed.active] : null;
  const toggle = (key: Tick) =>
    setTicked((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const rows: {
    key: string;
    title: string;
    sub: string;
    done: boolean;
    subOk?: boolean;
    onToggle?: () => void;
    action?: { label: string; onPress(): void };
  }[] = [
    {
      key: "map",
      title: t("beforeMap"),
      sub: region ? t("beforeMapReady").replace("{region}", region.name[language]) : t("beforeMapMissing"),
      done: region != null,
      subOk: region != null,
      action: region ? undefined : { label: t("downloads"), onPress: () => router.push("/downloads") },
    },
    {
      key: "adapter",
      title: t("beforeAdapter"),
      sub: nav.adapter === "on" ? t("beforeAdapterOn") : nav.adapter === "searching" ? t("obdSearching") : t("obdNotConnected"),
      done: nav.adapter === "on",
      subOk: nav.adapter === "on",
      action: nav.adapter === "off" ? { label: t("connect"), onPress: () => router.push("/vehicle") } : undefined,
    },
    ...(
      [
        ["holder", "beforeHolder", "beforeHolderSub"],
        ["open", "beforeOpen", "beforeOpenSub"],
        ["charge", "beforeCharge", "beforeChargeSub"],
      ] as const satisfies readonly (readonly [Tick, keyof Strings, keyof Strings])[]
    ).map(([key, title, sub]) => ({
      key,
      title: t(title),
      sub: t(sub),
      done: ticked.has(key),
      onToggle: () => toggle(key),
    })),
  ];
  const doneCount = rows.filter((row) => row.done).length;
  const allDone = doneCount === rows.length;

  return (
    <>
      <LessonIntro>{t("beforeIntro")}</LessonIntro>
      <View style={styles.progressRow}>
        <View style={[styles.track, { backgroundColor: palette.secBg }]}>
          <View
            style={[
              styles.fill,
              { width: `${(doneCount / rows.length) * 100}%`, backgroundColor: allDone ? palette.ok.c : palette.accent },
            ]}
          />
        </View>
        <T w="semibold" size={13} color={palette.text2}>
          {t("beforeCount").replace("{n}", String(doneCount)).replace("{total}", String(rows.length))}
        </T>
      </View>
      <View style={[styles.card, { backgroundColor: palette.groupBg }]}>
        {rows.map((row, i) => (
          <Fragment key={row.key}>
            {i > 0 && <View style={[styles.line, { backgroundColor: palette.line }]} />}
            <View style={styles.row}>
              <Pressable
                onPress={row.onToggle}
                disabled={!row.onToggle}
                hitSlop={8}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: row.done }}
                accessibilityLabel={row.title}
                style={[
                  styles.tick,
                  row.done
                    ? { backgroundColor: palette.ok.c, borderColor: palette.ok.c }
                    : { borderColor: palette.text2 },
                ]}
              >
                {row.done && <Icon name="check" size={15} color={palette.ok.fg} />}
              </Pressable>
              <View style={styles.copy}>
                <T w="medium" size={15}>
                  {row.title}
                </T>
                <T size={13} color={row.subOk ? palette.ok.c : palette.text2} style={styles.sub}>
                  {row.sub}
                </T>
              </View>
              {row.action && (
                <Pressable
                  onPress={row.action.onPress}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.action, { backgroundColor: palette.accent }, pressed && styles.pressed]}
                >
                  <T w="semibold" size={13} color={palette.onAccent}>
                    {row.action.label}
                  </T>
                </Pressable>
              )}
            </View>
          </Fragment>
        ))}
      </View>
      {allDone && (
        <View style={[styles.ready, { backgroundColor: palette.ok.a }]}>
          <Icon name="check" size={20} color={palette.ok.c} />
          <T w="medium" size={14} style={styles.readyText}>
            {t("beforeReady")}
          </T>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  progressRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 4 },
  track: { flex: 1, height: 8, borderRadius: 4, overflow: "hidden" },
  fill: { height: 8, borderRadius: 4 },
  card: { borderRadius: Radius.rL, paddingHorizontal: 14, paddingVertical: 2, borderCurve: "continuous" },
  line: { height: StyleSheet.hairlineWidth },
  row: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  tick: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, gap: 2 },
  sub: { lineHeight: 18 },
  action: { height: 36, borderRadius: Radius.pill, paddingHorizontal: 14, justifyContent: "center" },
  pressed: { opacity: 0.75 },
  ready: { borderRadius: Radius.rL, padding: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  readyText: { flex: 1, lineHeight: 20 },
});
