import * as Updates from "expo-updates";

import type { useT } from "@/i18n/provider";
import { jsCommit, jsSource } from "@/services/js-source";

/** The JS commit and where it came from: with the IPA/APK, or an OTA update (docs/OTA.md). */
export function appCode(t: ReturnType<typeof useT>["t"]): string {
  const source = jsSource();
  const how =
    source === "update" && Updates.createdAt
      ? t("appCodeUpdate").replace("{date}", Updates.createdAt.toLocaleDateString())
      : t(source === "off" ? "appCodeDev" : "appCodeEmbedded");
  return `${jsCommit() ?? "dev"} · ${how}`;
}
