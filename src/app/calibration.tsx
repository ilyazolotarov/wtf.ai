import { useState } from "react";

import {
    ScreenAction,
    ScreenContent,
    ScreenNote,
    ScreenSection,
    ScreenTitle,
} from "@/components/screens/screen-ui";
import { useT } from "@/i18n/provider";

export default function CalibrationScreen() {
  const { t } = useT();
  const [skipped, setSkipped] = useState(false);
  return (
    <ScreenContent>
      <ScreenTitle>{t("calibration")}</ScreenTitle>
      <ScreenSection>
        <ScreenNote>{t("notCalibrated")}</ScreenNote>
      </ScreenSection>
      <ScreenSection>
        <Step
          title={t("calibrationStepOne")}
          detail={t("calibrationStepOneInfo")}
          number="1"
        />
        <Step
          title={t("calibrationStepTwo")}
          detail={t("calibrationStepTwoInfo")}
          number="2"
        />
        <Step
          title={t("calibrationStepThree")}
          detail={t("calibrationStepThreeInfo")}
          number="3"
        />
        <ScreenAction labelKey="start" disabled />
        <ScreenAction
          labelKey="skip"
          secondary
          onPress={() => setSkipped(true)}
        />
        {skipped && <ScreenNote>{t("skipCalibration")}</ScreenNote>}
      </ScreenSection>
    </ScreenContent>
  );
}

function Step({
  title,
  detail,
  number,
}: {
  title: string;
  detail: string;
  number: string;
}) {
  return (
    <ScreenSection>
      <ScreenNote>{number}</ScreenNote>
      <ScreenTitle>{title}</ScreenTitle>
      <ScreenNote>{detail}</ScreenNote>
    </ScreenSection>
  );
}
