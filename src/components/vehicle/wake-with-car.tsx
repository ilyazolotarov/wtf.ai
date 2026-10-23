import { Platform, StyleSheet, View } from "react-native";

import { ScreenAction, ScreenCard, ScreenNote, ScreenRow, SectionLabel } from "@/components/screens/screen-ui";
import { SwitchRow } from "@/components/screens/setting-rows";
import { useWakeSetup } from "@/components/vehicle/use-wake-setup";
import { useT } from "@/i18n/provider";
import { useVehicleLinkSnapshot } from "@/providers/runtime-provider";

// Keep the position when the driver forgets to open the app (VEHICLE-LINK-SPEC §11), in Settings: a switch, and once
// on, the devices that start the app (Android 12+) and whether it may use location while closed. Shown with no adapter
// too: iOS starts the app from location alone, and Android from the car's own Bluetooth. Android's device dialog
// offers the connected or remembered adapter.
export function WakeWithCar() {
  const { t } = useT();
  const wake = useWakeSetup();
  const snap = useVehicleLinkSnapshot();
  if (!wake.supported) return null;
  const adapterId = snap.activeDeviceId ?? snap.devices.find((d) => d.rank === "remembered")?.id ?? null;

  return (
    <View style={styles.group}>
      <SectionLabel>{t("wakeTitle")}</SectionLabel>
      <ScreenCard style={styles.card}>
        <SwitchRow
          // On while the system's dialogs are open: off again if the driver cancels them.
          value={wake.on || wake.busy}
          onValueChange={(on) => void (on ? wake.turnOn(adapterId) : wake.turnOff())}
          label={t("wakeAdd")}
        />
        {wake.on &&
          wake.devices.map((d) => <ScreenRow key={d.address} label={d.name ?? d.address} value={t("wakeOn")} />)}
        {wake.on && wake.locationAlways !== null && (
          <ScreenRow
            labelKey="wakeLocationRow"
            value={t(wake.locationAlways ? "wakeLocationAllowed" : "wakeLocationNotAllowed")}
          />
        )}
      </ScreenCard>
      {wake.on && wake.locationAlways === false && (
        <ScreenAction labelKey="wakeAllowLocation" icon="my_location" onPress={() => void wake.allowLocation()} />
      )}
      <ScreenNote>{t(Platform.OS === "ios" ? "wakeNoteIos" : "wakeNote")}</ScreenNote>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  card: { gap: 8 },
});
