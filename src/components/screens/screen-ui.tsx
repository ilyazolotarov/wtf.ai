import {
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    View,
} from "react-native";

import { Colors } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";

export function ScreenContent({ children }: React.PropsWithChildren) {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
    >
      {children}
    </ScrollView>
  );
}

export function ScreenSection({
  title,
  children,
}: React.PropsWithChildren<{ title?: string }>) {
  const colorScheme = useColorScheme();
  const palette = Colors[colorScheme === "dark" ? "dark" : "light"];
  return (
    <View style={styles.section}>
      {title && (
        <Text style={[styles.sectionTitle, { color: palette.textSecondary }]}>
          {title}
        </Text>
      )}
      <View
        style={[styles.surface, { backgroundColor: palette.backgroundElement }]}
      >
        {children}
      </View>
    </View>
  );
}

export function ScreenRow({
  labelKey,
  value,
  valueColor,
}: {
  labelKey: keyof Strings;
  value: string;
  valueColor?: string;
}) {
  const { t } = useT();
  const colorScheme = useColorScheme();
  const palette = Colors[colorScheme === "dark" ? "dark" : "light"];
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: palette.textSecondary }]}>
        {t(labelKey)}
      </Text>
      <Text
        selectable
        style={[styles.rowValue, { color: valueColor ?? palette.text }]}
      >
        {value}
      </Text>
    </View>
  );
}

export function ScreenAction({
  labelKey,
  onPress,
  disabled = false,
  secondary = false,
}: {
  labelKey: keyof Strings;
  onPress?: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  const { t } = useT();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.action,
        secondary && styles.secondaryAction,
        disabled && styles.disabledAction,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text
        style={[styles.actionText, secondary && styles.secondaryActionText]}
      >
        {t(labelKey)}
      </Text>
    </Pressable>
  );
}

export function ScreenNote({ children }: React.PropsWithChildren) {
  const colorScheme = useColorScheme();
  const palette = Colors[colorScheme === "dark" ? "dark" : "light"];
  return (
    <Text style={[styles.note, { color: palette.textSecondary }]}>
      {children}
    </Text>
  );
}

export function ScreenTitle({ children }: React.PropsWithChildren) {
  const colorScheme = useColorScheme();
  const palette = Colors[colorScheme === "dark" ? "dark" : "light"];
  return (
    <Text style={[styles.title, { color: palette.text }]}>{children}</Text>
  );
}

export const screenStyles = StyleSheet.create({
  inline: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  smallGap: { gap: 8 },
});

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 28,
    gap: 16,
  },
  section: { gap: 7 },
  sectionTitle: {
    paddingHorizontal: 3,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  surface: { gap: 13, padding: 15, borderRadius: 8 },
  row: {
    minHeight: 24,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  rowLabel: { flex: 1, fontSize: 14 },
  rowValue: {
    maxWidth: "55%",
    fontSize: 14,
    fontVariant: ["tabular-nums"],
    fontWeight: "600",
    textAlign: "right",
  },
  action: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: "#176FA9",
  },
  secondaryAction: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "#176FA9",
  },
  actionText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  secondaryActionText: { color: "#176FA9" },
  disabledAction: { opacity: 0.45 },
  pressed: { opacity: 0.82 },
  note: { paddingHorizontal: 3, fontSize: 13, lineHeight: 19 },
  title: { fontSize: 20, fontWeight: "700" },
});
