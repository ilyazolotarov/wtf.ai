import { router } from "expo-router";
import * as Updates from "expo-updates";
import { useEffect, useRef, useState } from "react";
import { Alert, type AlertButton } from "react-native";

import { formatMb } from "@/components/downloads/region-downloads";
import { useT } from "@/i18n/provider";
import { nextPrompt } from "@/services/app-update/decide";
import { openAltStore } from "@/services/app-update/native-build";
import {
  downloadMapUpdate,
  getBuild,
  getSnoozed,
  setJsReady,
  skipMap,
  snooze,
  useUpdateCenter,
} from "@/services/app-update/update-center";

/**
 * The update prompts (docs/UPDATES-SPEC.md §5.3), on the map screen: one system alert per check, the native build
 * first, then a downloaded JS update, then a map too big to fetch by itself. `busy` (a trip, a route, an adapter, the
 * car moving, another screen or card on top) keeps them back; the dots on More still show. Also tells the update
 * center which JS update `expo-updates` has downloaded.
 */
export function UpdatePrompts({ busy }: { busy: boolean }) {
  const { t, language } = useT();
  const { isUpdatePending, downloadedUpdate } = Updates.useUpdates();
  const { found } = useUpdateCenter();
  const [shown] = useState(() => new Set<string>());
  const open = useRef(false);

  useEffect(() => {
    const update = isUpdatePending ? downloadedUpdate : undefined;
    const message = (update?.manifest as { metadata?: { message?: unknown } } | undefined)?.metadata?.message;
    setJsReady(update?.updateId ?? null, typeof message === "string" ? message : null);
  }, [isUpdatePending, downloadedUpdate]);

  useEffect(() => {
    if (open.current) return;
    const next = nextPrompt(found, { busy, now: Date.now(), snoozed: getSnoozed(), shown });
    if (!next) return;
    shown.add(next.key);
    open.current = true;
    const close = (action?: () => void) => () => {
      open.current = false;
      action?.();
    };
    const later: AlertButton = { text: t("promptLater"), style: "cancel", onPress: close(() => snooze(next.key)) };
    let title: string;
    let body: string;
    let buttons: AlertButton[];
    if (next.kind === "native" && found.native) {
      const build = found.native;
      const fill = (s: string) =>
        s.replace("{version}", build.version).replace("{build}", String(build.build)).replace("{size}", formatMb(build.size));
      title = t("promptAppTitle");
      if (build.platform === "android") {
        body = fill(t("promptAppBody"));
        buttons = [
          later,
          {
            text: t("promptUpdate"),
            onPress: close(() => {
              router.push("/more/update");
              void getBuild({ install: true });
            }),
          },
        ];
      } else {
        body = fill(t("promptAppBodyIos"));
        buttons = [
          later,
          {
            text: t("appUpdateOpenAltStore"),
            onPress: close(() => void openAltStore().then((opened) => opened || router.push("/more/update"))),
          },
        ];
      }
    } else if (next.kind === "js") {
      title = t("promptJsTitle");
      body = t("promptJsBody");
      buttons = [later, { text: t("promptRestart"), onPress: close(() => void Updates.reloadAsync()) }];
    } else if (next.kind === "map" && found.map) {
      const map = found.map;
      title = t("promptMapTitle").replace("{region}", map.name[language]);
      body = t("promptMapBody").replace("{date}", map.osmDate).replace("{size}", formatMb(map.bytes));
      buttons = [
        { text: t("promptSkip"), style: "destructive", onPress: close(() => skipMap(map.osmDate)) },
        later,
        // Started by the app's question: installed like an automatic update, never mid-drive.
        { text: t("promptDownload"), onPress: close(() => void downloadMapUpdate(map.region)) },
      ];
    } else {
      open.current = false;
      return;
    }
    Alert.alert(title, body, buttons, { cancelable: false });
  }, [found, busy, shown, t, language]);

  return null;
}
