import {
    ScreenAction,
    ScreenContent,
    ScreenRow,
    ScreenSection,
    ScreenTitle,
} from "@/components/screens/screen-ui";
import { useT } from "@/i18n/provider";
import { ekfMock } from "@/mocks";
import { usePosition } from "@/providers/position-provider";
import { Host, Switch } from "@expo/ui";
import { useEffect, useState } from "react";

export default function DebugScreen() {
  const { t } = useT();
  const position = usePosition();
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const fixAge =
    position && clock
      ? `${Math.max(0, Math.floor((clock - position.timestamp) / 1000))} s`
      : t("unavailableValue");
  const heading =
    position?.headingRad == null
      ? t("unavailableValue")
      : `${Math.round((position.headingRad * 180) / Math.PI)}°`;
  return (
    <ScreenContent>
      <ScreenTitle>{t("debug")}</ScreenTitle>
      <ScreenSection title={t("liveGnss")}>
        <ScreenRow
          labelKey="latitude"
          value={position?.lat.toFixed(6) ?? t("unavailableValue")}
        />
        <ScreenRow
          labelKey="longitude"
          value={position?.lon.toFixed(6) ?? t("unavailableValue")}
        />
        <ScreenRow
          labelKey="accuracy"
          value={
            position
              ? `${position.accuracyM.toFixed(1)} m`
              : t("unavailableValue")
          }
        />
        <ScreenRow
          labelKey="speed"
          value={
            position?.speedMps == null
              ? t("unavailableValue")
              : `${(position.speedMps * 3.6).toFixed(1)} km/h`
          }
        />
        <ScreenRow labelKey="heading" value={heading} />
        <ScreenRow labelKey="fixAge" value={fixAge} />
        <ScreenRow
          labelKey="updateRate"
          value={position ? "~1 Hz" : t("unavailableValue")}
        />
      </ScreenSection>
      <ScreenSection title={t("integrity")}>
        <ScreenRow
          labelKey="integrity"
          value={position?.trust ?? t("unavailableValue")}
        />
      </ScreenSection>
      <ScreenSection title={t("ekfState")}>
        <ScreenRow
          labelKey="ekfEast"
          value={ekfMock.eastM ?? t("unavailableValue")}
        />
        <ScreenRow
          labelKey="ekfNorth"
          value={ekfMock.northM ?? t("unavailableValue")}
        />
        <ScreenRow
          labelKey="ekfHeading"
          value={ekfMock.headingRad ?? t("unavailableValue")}
        />
        <ScreenRow
          labelKey="ekfSpeed"
          value={ekfMock.speedMps ?? t("unavailableValue")}
        />
        <ScreenRow
          labelKey="speedScale"
          value={ekfMock.speedScale ?? t("unavailableValue")}
        />
        <ScreenRow
          labelKey="yawBias"
          value={ekfMock.yawBias ?? t("unavailableValue")}
        />
        <ScreenRow
          labelKey="yawScale"
          value={ekfMock.yawScale ?? t("unavailableValue")}
        />
      </ScreenSection>
      <ScreenSection>
        <ScreenRow labelKey="obdPollRate" value={t("unavailableValue")} />
        <Host matchContents>
          <Switch
            value={false}
            onValueChange={() => undefined}
            disabled
            label={t("logging")}
          />
        </Host>
        <ScreenAction labelKey="export" disabled secondary />
      </ScreenSection>
    </ScreenContent>
  );
}
