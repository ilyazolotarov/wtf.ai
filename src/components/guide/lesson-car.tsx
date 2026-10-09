import { Fragment, useEffect, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";

import { ChoiceChips, ExplainCard, LessonIntro } from "@/components/guide/lesson-ui";
import { MiniMap } from "@/components/guide/mini-map";
import { SectionLabel } from "@/components/screens/screen-ui";
import { Icon, type IconName } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";

type State = "green" | "yellow" | "red" | "driving";

const STATES: Record<State, { chip: keyof Strings; color: "ok" | "warn" | "bad"; means: keyof Strings; you: keyof Strings }> = {
  green: { chip: "carGreen", color: "ok", means: "carGreenMeans", you: "carGreenYou" },
  yellow: { chip: "carYellow", color: "warn", means: "carYellowMeans", you: "carYellowYou" },
  red: { chip: "carRed", color: "bad", means: "carRedMeans", you: "carRedYou" },
  driving: { chip: "carDriving", color: "ok", means: "carDrivingMeans", you: "carDrivingYou" },
};

const RED_CHECKS = ["carCheckPort", "carCheckIgnition", "carCheckBluetooth", "carCheckConnect"] as const;

/** Lesson 3: the vehicle button's connection dot (UI-SPEC §6.2). */
export function LessonCar() {
  const { t } = useT();
  const palette = usePalette();
  const [state, setState] = useState<State>("red");
  const s = STATES[state];
  const driving = state === "driving";

  return (
    <>
      <LessonIntro>{t("carIntro")}</LessonIntro>
      <MiniMap
        width={358}
        height={150}
        parks={[{ x: 200, y: 10, w: 140, h: 40 }]}
        blocks={[{ x: 14, y: 10, w: 70, h: 40 }]}
        minor="M-10 66 H370"
        major="M120 -10 V160"
        overlay={
          <View style={[styles.toolbar, { backgroundColor: palette.panelSolid }]}>
            <ToolbarItem icon="alt_route" label={t("route")} dim />
            <View style={styles.item}>
              <View>
                <Icon name="directions_car" size={24} color={driving ? palette.accent : palette.text} />
                <BadgeDot color={palette[s.color].c} border={palette.groupBg} pulse={state === "yellow"} />
              </View>
              <T w="medium" size={12} color={driving ? palette.accent : undefined}>
                {driving ? t("driving") : t("vehicle")}
              </T>
            </View>
            <ToolbarItem icon="more_horiz" label={t("more")} dim />
          </View>
        }
      />
      <ChoiceChips<State>
        value={state}
        onChange={setState}
        columns={2}
        options={(Object.keys(STATES) as State[]).map((key) => ({
          value: key,
          label: t(STATES[key].chip),
          color: palette[STATES[key].color].c,
        }))}
      />
      <ExplainCard
        rows={[
          { label: t("guideMeans"), text: t(s.means) },
          { label: t("guideYou"), text: t(s.you), strong: true },
        ]}
      />
      {state === "red" && (
        <View style={styles.group}>
          <SectionLabel>{t("carStaysRed")}</SectionLabel>
          <View style={[styles.card, { backgroundColor: palette.groupBg }]}>
            {RED_CHECKS.map((key, i) => (
              <Fragment key={key}>
                {i > 0 && <View style={[styles.line, { backgroundColor: palette.line }]} />}
                <View style={styles.check}>
                  <View style={[styles.number, { backgroundColor: palette.surface }]}>
                    <T w="semibold" size={12} color={palette.text2}>
                      {String(i + 1)}
                    </T>
                  </View>
                  <T size={14} style={styles.checkText}>
                    {t(key)}
                  </T>
                </View>
              </Fragment>
            ))}
          </View>
        </View>
      )}
    </>
  );
}

function ToolbarItem({ icon, label, dim }: { icon: IconName; label: string; dim?: boolean }) {
  const palette = usePalette();
  return (
    <View style={[styles.item, dim && styles.dim]}>
      <Icon name={icon} size={24} color={palette.text} />
      <T w="medium" size={12}>
        {label}
      </T>
    </View>
  );
}

/** As the map's vehicle badge: pulsing (scaled 1 → 1.35 → 1 each second) while connecting. */
function BadgeDot({ color, border, pulse }: { color: string; border: string; pulse: boolean }) {
  const [scale] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!pulse) {
      scale.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.35, duration: 500, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, scale]);
  return <Animated.View style={[styles.badge, { backgroundColor: color, borderColor: border, transform: [{ scale }] }]} />;
}

const styles = StyleSheet.create({
  toolbar: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 12,
    height: 72,
    borderRadius: 30,
    flexDirection: "row",
    borderCurve: "continuous",
  },
  item: { flex: 1, alignItems: "center", justifyContent: "center", gap: 3 },
  dim: { opacity: 0.4 },
  badge: { position: "absolute", right: -6, top: -4, width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
  group: { gap: 8 },
  card: { borderRadius: Radius.rL, paddingHorizontal: 16, paddingVertical: 4, borderCurve: "continuous" },
  line: { height: StyleSheet.hairlineWidth },
  check: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12 },
  number: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  checkText: { flex: 1, lineHeight: 19, paddingVertical: 8 },
});
