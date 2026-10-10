import { useState } from "react";
import { Pressable, StyleSheet, Text, useColorScheme, View } from "react-native";

import { MAX_FONT_SCALE } from "@/components/ui/text";
import { Colors } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import type { DiscoveredDevice } from "@/obd/types";

import { dash } from "./format";

function rssiBars(rssi?: number): string {
  if (rssi === undefined) return "";
  if (rssi >= -60) return "▂▄▆█";
  if (rssi >= -70) return "▂▄▆";
  if (rssi >= -80) return "▂▄";
  return "▂";
}

function DeviceRow({
  device,
  active,
  onPress,
}: {
  device: DiscoveredDevice;
  active: boolean;
  onPress: () => void;
}) {
  const { t } = useT();
  const palette = Colors[useColorScheme() === "dark" ? "dark" : "light"];
  const subtitle = [
    device.transport.toUpperCase(),
    device.brandHint,
    device.profileId ? `GATT ${device.profileId}` : undefined,
    device.rank === "non-elm" ? t("nonElmWarning") : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.pressed, active && { backgroundColor: palette.accentA }]}
    >
      <View style={styles.rowText}>
        <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={[styles.name, { color: palette.text }]} numberOfLines={1}>
          {device.name ?? device.id}
        </Text>
        <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={[styles.subtitle, { color: palette.textSecondary }]} numberOfLines={1}>
          {subtitle || dash}
        </Text>
      </View>
      <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={[styles.rssi, { color: palette.textSecondary }]}>{rssiBars(device.rssi)}</Text>
    </Pressable>
  );
}

export function DeviceList({
  devices,
  activeId,
  onSelect,
}: {
  devices: DiscoveredDevice[];
  activeId: string | null;
  onSelect: (device: DiscoveredDevice) => void;
}) {
  const { t } = useT();
  const palette = Colors[useColorScheme() === "dark" ? "dark" : "light"];
  const [showOther, setShowOther] = useState(false);
  const remembered = devices.filter((d) => d.rank === "remembered");
  const adapters = devices.filter((d) => d.rank === "known-profile" || d.rank === "known-name" || d.transport === "mfi" || d.transport === "emulator").filter((d) => d.rank !== "remembered");
  const other = devices.filter((d) => !remembered.includes(d) && !adapters.includes(d) && (d.name || showOther));

  const section = (title: string, list: DiscoveredDevice[]) =>
    list.length > 0 && (
      <View style={styles.group}>
        <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={[styles.groupTitle, { color: palette.textSecondary }]}>{title}</Text>
        {list.map((d) => (
          <DeviceRow key={d.id} device={d} active={d.id === activeId} onPress={() => onSelect(d)} />
        ))}
      </View>
    );

  return (
    <View style={styles.list}>
      {section(t("remembered"), remembered)}
      {section(t("obdAdapters"), adapters)}
      {remembered.length === 0 && adapters.length === 0 && (
        <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={[styles.subtitle, { color: palette.textSecondary }]}>{t("noAdaptersFound")}</Text>
      )}
      {showOther && section(`${t("otherDevices")} · ${t("tryAnyway")}`, other)}
      <Pressable onPress={() => setShowOther((v) => !v)} accessibilityRole="button">
        <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={[styles.link, { color: palette.accent }]}>{showOther ? t("hideOtherDevices") : t("showOtherDevices")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 12 },
  group: { gap: 4 },
  groupTitle: { fontSize: 12, fontWeight: "700", textTransform: "uppercase" },
  row: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 12,
  },
  rowText: { flex: 1, gap: 2 },
  name: { fontSize: 15, fontWeight: "600" },
  subtitle: { fontSize: 12 },
  rssi: { fontSize: 12, fontVariant: ["tabular-nums"] },
  pressed: { opacity: 0.7 },
  link: { fontSize: 14, fontWeight: "600", paddingVertical: 4 },
});
