import * as IntentLauncher from "expo-intent-launcher";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import PositionShareModule from "../../../modules/position-share/src/PositionShareModule";
import {
    ScreenAction,
    ScreenCard,
    ScreenContent,
    ScreenNote,
    SectionLabel,
} from "@/components/screens/screen-ui";
import { SwitchRow } from "@/components/screens/setting-rows";
import { Icon, type IconName } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";
import { useDevSettings, useRuntime, useShareSnapshot } from "@/providers/runtime-provider";
import type { ShareCheck, ShareSnapshot } from "@/services/position-share/position-share-service";

// More → Waze and Google Maps (ANDROID-SPEC §8): the setting, what sharing does now, and the phone's one-time setup.

const WAZE = "com.waze";
const MAPS = "com.google.android.apps.maps";

type Translate = (key: keyof Strings) => string;

/** What sharing does now, in a line; null: nothing to say (the setting is off). */
function statusLine(s: ShareSnapshot, t: Translate, nowMs: number): string | null {
  switch (s.state) {
    case "off":
      return null;
    case "unavailable":
      return t("navShareStatusUnavailable");
    case "setup":
      return t("navShareStatusSetup");
    case "ready":
      return t("navShareStatusReady");
    case "starting":
      return t("navShareStatusStarting");
    case "sharing":
      return t("navShareStatusSharing")
        .replace("{radius}", String(Math.round(s.last?.accuracyM ?? 0)))
        .replace("{age}", String(Math.max(0, Math.round((nowMs - (s.last?.atMs ?? nowMs)) / 1000))));
    case "holding":
      return t(s.hold === "uncertain" ? "navShareStatusUncertain" : "navShareStatusWaiting");
    case "failed":
      return t("navShareStatusFailed").replace("{error}", s.error ?? "");
  }
}

/** Opens one of Android's settings screens; the setup is read again when the driver comes back. */
async function openSettings(action: string, done: () => void): Promise<void> {
  try {
    await IntentLauncher.startActivityAsync(action);
  } catch {
    // Some phones have no such screen; the step's note says the way by hand.
  }
  done();
}

export default function NavigatorsScreen() {
  const { t } = useT();
  const palette = usePalette();
  const { setDevSettings, share } = useRuntime();
  const settings = useDevSettings();
  const s = useShareSnapshot();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [check, setCheck] = useState<ShareCheck | null>(null);
  const setup = s.setup;
  const sharing = s.state === "sharing";

  // The phone's setup as it is now: the driver may have just changed it in Android's settings.
  useEffect(() => share.recheck(), [share]);
  // "{age} s ago" counts while sharing.
  useEffect(() => {
    if (!sharing) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sharing]);

  const status = statusLine(s, t, nowMs);
  const statusColor =
    s.state === "sharing" ? palette.ok.c : s.state === "failed" || s.state === "setup" || s.hold === "uncertain" ? palette.warn.c : palette.text2;
  const developerDone = !!setup && (setup.developerOptions || setup.mockLocationApp);
  const mockDone = !!setup?.mockLocationApp;
  const recheck = () => share.recheck();

  return (
    <ScreenContent title={t("navShareTitle")}>
      <ScreenNote>{t("navShareIntro")}</ScreenNote>
      <ScreenCard style={styles.card}>
        <SwitchRow
          value={settings.positionShare}
          onValueChange={(v) => setDevSettings({ positionShare: v })}
          label={t("navShareSwitch")}
        />
        {status && <ScreenNote color={statusColor}>{status}</ScreenNote>}
        {sharing && (
          <>
            <ScreenAction
              labelKey="navShareCheck"
              secondary
              compact
              onPress={() => void share.verify().then(setCheck)}
            />
            {check && (
              <ScreenNote color={check === "ok" ? palette.ok.c : palette.warn.c}>
                {t(check === "ok" ? "navShareCheckOk" : check === "other" ? "navShareCheckOther" : "navShareCheckNone")}
              </ScreenNote>
            )}
          </>
        )}
      </ScreenCard>

      {setup && (
        <View style={styles.group}>
          <SectionLabel>{t("navShareStepsTitle")}</SectionLabel>
          <ScreenCard style={styles.card}>
            <Step done={developerDone} title={t("navShareStepDeveloper")} note={t("navShareStepDeveloperNote")} />
            {!developerDone && (
              <ScreenAction
                labelKey="navShareOpenAbout"
                icon="open_in_new"
                secondary
                compact
                onPress={() => void openSettings(IntentLauncher.ActivityAction.DEVICE_INFO_SETTINGS, recheck)}
              />
            )}
          </ScreenCard>
          <ScreenCard style={styles.card}>
            <Step done={mockDone} title={t("navShareStepMock")} note={t("navShareStepMockNote")} />
            {!mockDone && (
              <ScreenAction
                labelKey="navShareOpenDeveloper"
                icon="open_in_new"
                secondary
                compact
                disabled={!developerDone}
                onPress={() => void openSettings(IntentLauncher.ActivityAction.APPLICATION_DEVELOPMENT_SETTINGS, recheck)}
              />
            )}
          </ScreenCard>
          {!setup.playServices && (
            <ScreenCard style={styles.card}>
              <Step done={false} icon="gpp_maybe" title={t("navShareStepPlay")} note={t("navShareStepPlayMissing")} />
            </ScreenCard>
          )}
        </View>
      )}

      {!!setup?.navigators.length && (
        <View style={styles.actions}>
          {setup.navigators.includes(WAZE) && (
            <ScreenAction labelKey="navShareOpenWaze" icon="open_in_new" secondary compact onPress={() => PositionShareModule?.openApp(WAZE)} />
          )}
          {setup.navigators.includes(MAPS) && (
            <ScreenAction labelKey="navShareOpenMaps" icon="open_in_new" secondary compact onPress={() => PositionShareModule?.openApp(MAPS)} />
          )}
        </View>
      )}

      <View style={styles.group}>
        <SectionLabel>{t("navShareHowTitle")}</SectionLabel>
        <ScreenCard style={styles.card}>
          <ScreenNote>{t("navShareHowOpenFirst")}</ScreenNote>
          <ScreenNote>{t("navShareHowEnd")}</ScreenNote>
          <ScreenNote>{t("navShareHowFrozen")}</ScreenNote>
          <ScreenNote>{t("navShareHowDevOptions")}</ScreenNote>
          <ScreenNote>{t("navShareHowTaxi")}</ScreenNote>
        </ScreenCard>
      </View>
    </ScreenContent>
  );
}

function Step({ done, title, note, icon }: { done: boolean; title: string; note: string; icon?: IconName }) {
  const palette = usePalette();
  return (
    <View style={styles.step}>
      <Icon
        name={icon ?? (done ? "check_circle" : "radio_button_unchecked")}
        size={22}
        color={done ? palette.ok.c : icon ? palette.warn.c : palette.text2}
      />
      <View style={styles.stepCopy}>
        <T w="medium" size={15}>
          {title}
        </T>
        <ScreenNote>{note}</ScreenNote>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  card: { gap: 8 },
  actions: { gap: 8 },
  step: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  stepCopy: { flex: 1, gap: 2 },
});
