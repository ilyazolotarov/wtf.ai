import { RegionDownloads } from "@/components/downloads/region-downloads";
import { ScreenContent } from "@/components/screens/screen-ui";
import { useT } from "@/i18n/provider";

/** Offline maps sheet: regions to download, the active one, the catalog source. */
export default function DownloadsScreen() {
  const { t } = useT();
  return (
    <ScreenContent title={t("downloads")}>
      <RegionDownloads />
    </ScreenContent>
  );
}
