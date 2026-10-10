import { Pressable, StyleSheet, View } from "react-native";

import { formatDistance } from "@/components/status/format-geo";
import { useAgeText } from "@/components/status/use-age-text";
import { GlassFill } from "@/components/ui/glass-fill";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import type { PositionEstimate } from "@/nav/position/types";

import { CardActions, CardButton, CardLine, HudCard, hud, usePanelStyle } from "./hud-card";
import type { PlacingStep } from "./use-placing";

type Manual = NonNullable<PositionEstimate["manual"]>;

/** The placing's card (NAVIGATOR-SPEC §6.2): "Where is the car?" (Cancel / Here), then which way it faces. */
export function PlacingCard({
  step,
  hasHeading,
  onCancel,
  onNext,
}: {
  step: PlacingStep;
  hasHeading: boolean;
  onCancel(): void;
  /** Here, then Confirm. */
  onNext(): void;
}) {
  const { t } = useT();
  const palette = usePalette();
  const atPosition = step === "position";
  return (
    <HudCard
      icon={atPosition ? "location_on" : "navigation"}
      tone={{ a: palette.accent + "22", c: palette.accent }}
      title={t(atPosition ? "placeTitle" : "placeHeadingTitle")}
      lines={
        <CardLine>{t(atPosition ? "placeHint" : hasHeading ? "placeHeadingConfirm" : "placeHeadingHint")}</CardLine>
      }
    >
      <CardActions>
        <CardButton label={t("placeCancel")} color={palette.text2} onPress={onCancel} wide />
        <CardButton
          label={t(atPosition ? "placeHere" : "placeConfirm")}
          onPress={onNext}
          // A placing always has a heading: Confirm waits for the first tap.
          disabled={!atPosition && !hasHeading}
          wide
        />
      </CardActions>
    </HudCard>
  );
}

/** A position set on the map (NAVIGATOR-SPEC §6.3) and its age; a tap places it again, ✕ forgets it. */
export function ManualChip({
  manual,
  onPlace,
  onForget,
}: {
  manual: Manual;
  /** Placing it again: only while the car stands, as the first time. */
  onPlace: (() => void) | undefined;
  onForget(): void;
}) {
  const { t } = useT();
  const palette = usePalette();
  const panel = usePanelStyle();
  const age = useAgeText(manual.confirmedAt);
  return (
    <View style={[panel, hud.chip, styles.manual]}>
      <GlassFill radius={Radius.pill} />
      <Pressable
        onPress={onPlace}
        disabled={!onPlace}
        accessibilityRole="button"
        style={({ pressed }) => [styles.manualBody, pressed && hud.pressed]}
      >
        <Icon name="location_on" size={16} color={palette.accent} />
        <T w="semibold" size={13} color={palette.accent} fit>
          {t("manualChip").replace("{age}", age)}
        </T>
      </Pressable>
      <Pressable
        onPress={onForget}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t("manualForget")}
        style={({ pressed }) => pressed && hud.pressed}
      >
        <Icon name="close" size={16} color={palette.text2} />
      </Pressable>
    </View>
  );
}

/** "Still here?" after 15 min on a manual position (NAVIGATOR-SPEC §6.3). */
export function ManualQuestionCard({ manual, onAnswer }: { manual: Manual; onAnswer(here: boolean): void }) {
  const { t } = useT();
  const palette = usePalette();
  const age = useAgeText(manual.confirmedAt);
  return (
    <HudCard
      icon="location_on"
      tone={palette.warn}
      title={t("manualQuestion")}
      lines={<CardLine>{t("manualQuestionWhy").replace("{age}", age)}</CardLine>}
    >
      <CardActions>
        <CardButton label={t("manualYes")} onPress={() => onAnswer(true)} wide />
        <CardButton label={t("poseNo")} onPress={() => onAnswer(false)} wide />
      </CardActions>
    </HudCard>
  );
}

/** "Is the car where the dot is?" when a Wi-Fi fix puts it elsewhere than where it was parked (UI-SPEC §6.2). */
export function PoseQuestionCard({ distanceM, onAnswer }: { distanceM: number; onAnswer(here: boolean): void }) {
  const { t, language } = useT();
  const palette = usePalette();
  return (
    <HudCard
      icon="directions_car"
      tone={palette.warn}
      title={t("poseQuestion")}
      lines={<CardLine>{t("poseQuestionWhy").replace("{d}", formatDistance(distanceM, language))}</CardLine>}
    >
      <CardActions>
        <CardButton label={t("poseYes")} onPress={() => onAnswer(true)} wide />
        <CardButton label={t("poseNo")} onPress={() => onAnswer(false)} wide />
      </CardActions>
    </HudCard>
  );
}

const styles = StyleSheet.create({
  manual: { maxWidth: "100%", paddingRight: 12, gap: 10 },
  manualBody: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 8 },
});
