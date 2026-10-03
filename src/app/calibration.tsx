import { useState } from "react";
import { StyleSheet, View } from "react-native";

import {
    ScreenAction,
    ScreenCard,
    ScreenContent,
    ScreenNote,
    ScreenSection,
    StatusDot,
} from "@/components/screens/screen-ui";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";

const STEPS: [keyof Strings, keyof Strings][] = [
  ["calibrationStepOne", "calibrationStepOneInfo"],
  ["calibrationStepTwo", "calibrationStepTwoInfo"],
  ["calibrationStepThree", "calibrationStepThreeInfo"],
];

/** Calibration is not implemented yet (SPEC Phase 4): Start stays disabled. */
export default function CalibrationScreen() {
  const { t } = useT();
  const palette = usePalette();
  const [skipped, setSkipped] = useState(false);
  return (
    <ScreenContent title={t("calibration")}>
      <ScreenCard>
        <View style={styles.status}>
          <StatusDot color={palette.warn.c} />
          <T w="semibold" size={18}>
            {skipped ? t("calSkipped") : t("notCalibrated")}
          </T>
        </View>
        <T size={14} color={palette.text2} style={styles.body}>
          {t("calBody")}
        </T>
      </ScreenCard>
      <ScreenSection>
        {STEPS.map(([title, info]) => (
          <View key={title} style={styles.step}>
            <Icon name="radio_button_unchecked" size={22} color={palette.text2} />
            <View style={styles.stepCopy}>
              <T w="semibold" size={15}>
                {t(title)}
              </T>
              <T size={13} color={palette.text2} style={styles.body}>
                {t(info)}
              </T>
            </View>
          </View>
        ))}
      </ScreenSection>
      <ScreenAction labelKey="calStart" disabled />
      {!skipped && <ScreenAction labelKey="skip" secondary onPress={() => setSkipped(true)} />}
      {skipped && <ScreenNote>{t("skipCalibration")}</ScreenNote>}
    </ScreenContent>
  );
}

const styles = StyleSheet.create({
  status: { flexDirection: "row", alignItems: "center", gap: 10 },
  body: { lineHeight: 20 },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 14, paddingVertical: 14 },
  stepCopy: { flex: 1, gap: 4 },
});
