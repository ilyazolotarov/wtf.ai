import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenCard } from "@/components/screens/screen-ui";
import { useNavStatus } from "@/components/status/use-nav-status";
import { Icon, type IconName } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { TAGLINE } from "@/constants/brand";
import { Radius, usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";
import { usePositionPermission } from "@/providers/position-provider";
import { markOnboardingDone } from "@/services/preferences";

type Step = 0 | 1 | 2 | 3;

/** `title: null` is the welcome page: its title is the tagline, the same in every language. */
const STEPS: { icon?: IconName; title: keyof Strings | null; body: keyof Strings }[] = [
  { title: null, body: "obWelcomeBody" },
  { icon: "location_on", title: "obLocationTitle", body: "obLocationBody" },
  { icon: "directions_car", title: "obCarTitle", body: "obCarBody" },
  { icon: "phone_iphone", title: "obHolderTitle", body: "obHolderBody" },
];

/** Without GPS the gyro is the only yaw source: a phone loose in the car loses the heading (SPEC §2, phone mount). */
const HOLDER_TIPS = ["obHolderFirm", "obHolderAngle", "obHolderMoved"] as const;

/** First-run flow: welcome → location → adapter → phone holder. The app calibrates itself while driving (NAVIGATOR-SPEC §7). */
export default function OnboardingScreen() {
  const { t } = useT();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const nav = useNavStatus();
  const { requestPermission } = usePositionPermission();
  const [step, setStep] = useState<Step>(0);
  const [busy, setBusy] = useState(false);
  const meta = STEPS[step];

  const finish = () => {
    markOnboardingDone();
    router.back();
  };

  const primary: { label: string; disabled?: boolean; onPress(): void } =
    step === 0
      ? { label: t("obWelcomeCta"), onPress: () => setStep(1) }
      : step === 1
        ? {
            label: t("obLocationCta"),
            disabled: busy,
            onPress: async () => {
              setBusy(true);
              try {
                await requestPermission();
              } finally {
                setBusy(false);
                setStep(2);
              }
            },
          }
        : step === 3
          ? { label: t("obDone"), onPress: finish }
          : nav.adapter === "on"
            ? { label: t("continue"), onPress: () => setStep(3) }
            : nav.adapter === "searching"
              ? { label: t("obdSearching"), disabled: true, onPress: () => undefined }
              : { label: t("connect"), onPress: () => router.push("/vehicle") };

  const secondary: { label: string; onPress(): void } | null =
    step === 1
      ? { label: t("notNow"), onPress: () => setStep(2) }
      : step === 2 && nav.adapter !== "on"
        ? { label: t("skipForNow"), onPress: () => setStep(3) }
        : null;

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: palette.bg,
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 10,
        },
      ]}
    >
      <View style={styles.dots}>
        {STEPS.map((_, i) => (
          <View
            key={i}
            style={[styles.dot, { backgroundColor: i <= step ? palette.accent : palette.line }]}
          />
        ))}
      </View>

      <View style={styles.body}>
        {step === 0 ? (
          <>
            <T w="bold" size={22} color={palette.accent}>
              wtf.ai
            </T>
            <T w="semibold" size={40} style={styles.hero}>
              {meta.title ? t(meta.title) : TAGLINE}
            </T>
            <T size={17} color={palette.text2} style={styles.lead}>
              {t(meta.body)}
            </T>
          </>
        ) : (
          <>
            <View style={[styles.iconTile, { backgroundColor: palette.accentA }]}>
              <Icon name={meta.icon!} size={30} color={palette.accent} />
            </View>
            <T w="semibold" size={30} style={styles.title}>
              {meta.title ? t(meta.title) : TAGLINE}
            </T>
            <T size={16} color={palette.text2} style={styles.lead}>
              {t(meta.body)}
            </T>
          </>
        )}

        {step === 2 && (
          <ScreenCard style={styles.adapterCard}>
            <Icon name="bluetooth" size={24} color={nav.adapterColor} />
            <View style={styles.flex}>
              <T w="semibold" size={15}>
                {`${t("obdAdapter")} · `}
                <T w="semibold" size={15} color={nav.adapterColor}>
                  {nav.adapterLabel}
                </T>
              </T>
              <T size={13} color={palette.text2} style={styles.hint}>
                {t("obCarHint")}
              </T>
            </View>
          </ScreenCard>
        )}

        {step === 3 && (
          <>
            <ScreenCard style={styles.tips}>
              {HOLDER_TIPS.map((key, i) => (
                <View
                  key={key}
                  style={[styles.tip, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line }]}
                >
                  <Icon name="check" size={18} color={palette.ok.c} />
                  <T size={15} style={styles.flex}>
                    {t(key)}
                  </T>
                </View>
              ))}
            </ScreenCard>
            <T size={13} color={palette.text2} style={styles.hint}>
              {t("obGuideNote")}
            </T>
          </>
        )}
      </View>

      <View style={styles.buttons}>
        <Pressable
          onPress={primary.onPress}
          disabled={primary.disabled}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: palette.accent },
            primary.disabled && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <T w="semibold" size={16} color={palette.onAccent}>
            {primary.label}
          </T>
        </Pressable>
        {secondary && (
          <Pressable
            onPress={secondary.onPress}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: palette.secBg },
              pressed && styles.pressed,
            ]}
          >
            <T w="semibold" size={16}>
              {secondary.label}
            </T>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, gap: 20, paddingHorizontal: 24 },
  dots: { flexDirection: "row", gap: 6 },
  dot: { flex: 1, height: 4, borderRadius: 2 },
  body: { flex: 1, justifyContent: "flex-end", gap: 16 },
  hero: { lineHeight: 44, letterSpacing: -1 },
  title: { lineHeight: 34, letterSpacing: -0.6 },
  lead: { lineHeight: 24 },
  iconTile: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  adapterCard: { flexDirection: "row", alignItems: "center", gap: 14 },
  flex: { flex: 1, gap: 3 },
  hint: { lineHeight: 18 },
  tips: { paddingVertical: 4 },
  tip: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12 },
  buttons: { gap: 10 },
  button: {
    height: 54,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Radius.pill,
  },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
});
