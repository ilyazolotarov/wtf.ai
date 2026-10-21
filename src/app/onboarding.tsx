import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenCard } from "@/components/screens/screen-ui";
import { useNavStatus } from "@/components/status/use-nav-status";
import { useWakeSetup, wakeSupported } from "@/components/vehicle/use-wake-setup";
import { Icon, type IconName } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { TAGLINE } from "@/constants/brand";
import { Radius, usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";
import { usePositionPermission } from "@/providers/position-provider";
import { useRuntime } from "@/providers/runtime-provider";
import { markOnboardingDone, markWakeOffered } from "@/services/preferences";

type StepId = "welcome" | "location" | "car" | "wake" | "holder";

/** `title: null` is the welcome page: its title is the tagline, the same in every language. */
const STEPS: { id: StepId; icon?: IconName; title: keyof Strings | null; body: keyof Strings }[] = [
  { id: "welcome", title: null, body: "obWelcomeBody" },
  { id: "location", icon: "location_on", title: "obLocationTitle", body: "obLocationBody" },
  { id: "car", icon: "directions_car", title: "obCarTitle", body: "obCarBody" },
  // The position kept when the driver forgets to open the app (VEHICLE-LINK-SPEC §11): Android 12+ and iOS.
  { id: "wake", icon: "my_location", title: "obWakeTitle", body: Platform.OS === "ios" ? "obWakeBodyIos" : "obWakeBody" },
  { id: "holder", icon: "phone_iphone", title: "obHolderTitle", body: "obHolderBody" },
];

/** Without GPS the gyro is the only yaw source: a phone loose in the car loses the heading (SPEC §2, phone mount). */
const HOLDER_TIPS = ["obHolderFirm", "obHolderAngle", "obHolderMoved"] as const;

/**
 * First-run flow: welcome → location → adapter → keep the position without the app → phone holder. The app
 * calibrates itself while driving (NAVIGATOR-SPEC §7).
 */
export default function OnboardingScreen() {
  const { t } = useT();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const nav = useNavStatus();
  const { requestPermission } = usePositionPermission();
  const { link } = useRuntime();
  const wake = useWakeSetup();
  // `only=wake`: the wake step by itself, once, for an install from before it (index.tsx).
  const { only } = useLocalSearchParams<{ only?: string }>();
  const [steps] = useState(() =>
    only === "wake" ? STEPS.filter((s) => s.id === "wake") : STEPS.filter((s) => s.id !== "wake" || wakeSupported()),
  );
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const meta = steps[step];
  // The adapter just connected (or remembered): offered in the companion dialog when it is a BLE one.
  const adapterId = () => {
    const snap = link.getSnapshot();
    return snap.activeDeviceId ?? snap.devices.find((d) => d.rank === "remembered")?.id ?? null;
  };

  const finish = () => {
    markOnboardingDone();
    markWakeOffered();
    router.back();
  };
  const next = () => (step >= steps.length - 1 ? finish() : setStep(step + 1));

  const primary: { label: string; disabled?: boolean; onPress(): void } =
    meta.id === "welcome"
      ? { label: t("obWelcomeCta"), onPress: next }
      : meta.id === "location"
        ? {
            label: t("obLocationCta"),
            disabled: busy,
            onPress: async () => {
              setBusy(true);
              try {
                await requestPermission();
              } finally {
                setBusy(false);
                next();
              }
            },
          }
        : meta.id === "wake"
          ? {
              label: t("obWakeCta"),
              disabled: wake.busy,
              onPress: async () => {
                await wake.turnOn(adapterId()).catch(() => false);
                next();
              },
            }
          : meta.id === "holder"
            ? { label: t("obDone"), onPress: finish }
            : nav.adapter === "on"
              ? { label: t("continue"), onPress: next }
              : nav.adapter === "searching"
                ? { label: t("obdSearching"), disabled: true, onPress: () => undefined }
                : { label: t("connect"), onPress: () => router.push("/vehicle") };

  const secondary: { label: string; onPress(): void } | null =
    meta.id === "location" || meta.id === "wake"
      ? { label: t("notNow"), onPress: next }
      : meta.id === "car" && nav.adapter !== "on"
        ? { label: t("skipForNow"), onPress: next }
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
        {steps.length > 1 && steps.map((_, i) => (
          <View
            key={i}
            style={[styles.dot, { backgroundColor: i <= step ? palette.accent : palette.line }]}
          />
        ))}
      </View>

      {/* Anchored at the bottom, by the buttons; scrolls when large text makes a step taller than the screen. */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
        {meta.id === "welcome" ? (
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

        {meta.id === "holder" && (
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
      </ScrollView>

      {/* By the buttons, never scrolled away: whether the adapter answers is what this step is for. */}
      {meta.id === "car" && (
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
          <T w="semibold" size={16} color={palette.onAccent} fit={2} style={styles.buttonLabel}>
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
            <T w="semibold" size={16} fit={2} style={styles.buttonLabel}>
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
  scroll: { flex: 1 },
  body: { flexGrow: 1, justifyContent: "flex-end", gap: 16 },
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
  // A long label at a large text size takes a second line before it shrinks.
  button: {
    minHeight: 54,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: Radius.pill,
  },
  buttonLabel: { textAlign: "center" },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
});
