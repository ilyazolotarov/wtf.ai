import {
    ScreenAction,
    ScreenContent,
    ScreenNote,
    ScreenRow,
    ScreenSection,
    ScreenTitle,
} from "@/components/screens/screen-ui";
import { useT } from "@/i18n/provider";
import { downloadsMock } from "@/mocks";

export default function DownloadsScreen() {
  const { t } = useT();
  return (
    <ScreenContent>
      <ScreenTitle>{t("downloads")}</ScreenTitle>
      {downloadsMock.map((pack) => (
        <ScreenSection
          key={pack.id}
          title={t(pack.id === "map" ? "mapTiles" : "routingData")}
        >
          <ScreenRow labelKey="notDownloaded" value={t("notDownloaded")} />
          <ScreenRow labelKey="distance" value={pack.size} />
          <ScreenRow labelKey="appVersion" value={`v${pack.version}`} />
          <ScreenAction labelKey="download" disabled />
        </ScreenSection>
      ))}
      <ScreenNote>{t("onlineMapNote")}</ScreenNote>
    </ScreenContent>
  );
}
