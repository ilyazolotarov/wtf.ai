import {
    ScreenAction,
    ScreenContent,
    ScreenRow,
    ScreenSection,
    ScreenTitle,
} from "@/components/screens/screen-ui";
import { useT } from "@/i18n/provider";
import { adapterMock, vehicleMock } from "@/mocks";

export default function VehicleScreen() {
  const { t } = useT();
  return (
    <ScreenContent>
      <ScreenTitle>{t("vehicle")}</ScreenTitle>
      <ScreenSection title={t("adapter")}>
        <ScreenRow labelKey="adapterModel" value={adapterMock.model} />
        <ScreenRow labelKey="transport" value={t("externalAccessory")} />
        <ScreenRow labelKey="status" value={t("disconnected")} />
        <ScreenRow
          labelKey="elmVersion"
          value={adapterMock.elmVersion ?? t("unavailableValue")}
        />
        <ScreenRow
          labelKey="obdProtocol"
          value={adapterMock.obdProtocol ?? t("unavailableValue")}
        />
        <ScreenRow
          labelKey="pollRate"
          value={adapterMock.pollRateHz ?? t("unavailableValue")}
        />
        <ScreenAction labelKey="connect" disabled />
      </ScreenSection>
      <ScreenSection title={t("odometry")}>
        <ScreenRow
          labelKey="vin"
          value={vehicleMock.vin ?? t("unavailableValue")}
        />
        <ScreenRow labelKey="odometryStage" value={t("odometryStageOne")} />
      </ScreenSection>
      <ScreenSection title={t("liveSignals")}>
        <ScreenRow
          labelKey="obdSpeed"
          value={vehicleMock.obdSpeedKph ?? t("unavailableValue")}
        />
        <ScreenRow
          labelKey="yawRate"
          value={vehicleMock.yawRateDegS ?? t("unavailableValue")}
        />
        <ScreenRow labelKey="yawSource" value={t("phoneGyro")} />
      </ScreenSection>
    </ScreenContent>
  );
}
