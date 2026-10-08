import { Host, Switch } from "@expo/ui";
import { Pressable, StyleSheet, View } from "react-native";

import { T } from "@/components/ui/text";
import { usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";

/** A setting with a few values: a tap moves to the next one. */
export function CycleRow<T extends number | string | null>({
  labelKey,
  value,
  options,
  format,
  onChange,
}: {
  labelKey: keyof Strings;
  value: T;
  options: T[];
  format: (v: T) => string;
  onChange: (v: T) => void;
}) {
  const { t } = useT();
  const palette = usePalette();
  const next = () => onChange(options[(options.indexOf(value) + 1) % options.length]);
  return (
    <Pressable onPress={next} accessibilityRole="button" style={styles.cycle}>
      <T size={14} color={palette.text2} style={styles.flex}>
        {t(labelKey)}
      </T>
      <T w="semibold" size={14} color={palette.accent}>
        {format(value)} ›
      </T>
    </Pressable>
  );
}

/** Label wraps beside the switch; a label inside the native switch overflows the card. */
export function SwitchRow({ value, onValueChange, label }: { value: boolean; onValueChange: (v: boolean) => void; label: string }) {
  const palette = usePalette();
  return (
    <View style={styles.switchRow}>
      <T size={14} color={palette.text} style={styles.flex}>
        {label}
      </T>
      <Host matchContents>
        <Switch value={value} onValueChange={onValueChange} />
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  flex: { flex: 1 },
  cycle: { minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
});
