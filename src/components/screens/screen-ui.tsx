import { router, useLocalSearchParams } from "expo-router";
import { Children, Fragment, isValidElement } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { Icon, type IconName } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";

/**
 * Sheet body. With `title`, renders the sheet header: title, a back button
 * when opened from the More sheet (`?from=more`), and a close button. The header stays
 * pinned while the body scrolls. `fullScreen`: the body of a full-screen modal, the header below the status bar.
 */
export function ScreenContent({
  title,
  fullScreen = false,
  children,
}: React.PropsWithChildren<{ title?: string; fullScreen?: boolean }>) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  if (fullScreen)
    return (
      <View style={[styles.fullScreen, { backgroundColor: palette.sheetBg, paddingTop: insets.top }]}>
        {title && (
          <View style={styles.fullScreenHeader}>
            <SheetHeader title={title} />
          </View>
        )}
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.content, { paddingBottom: styles.content.paddingBottom + insets.bottom }]}
        >
          {children}
        </ScrollView>
      </View>
    );
  return (
    <ScrollView
      style={{ backgroundColor: palette.sheetBg }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      stickyHeaderIndices={title ? [0] : undefined}
      contentContainerStyle={[styles.content, !title && styles.contentNoHeader]}
    >
      {title && <SheetHeader title={title} />}
      {children}
    </ScrollView>
  );
}

function SheetHeader({ title }: { title: string }) {
  const { t } = useT();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const nested = from === "more";
  const palette = usePalette();
  return (
    // Opaque and full-bleed so scrolled content doesn't show beside or under the pinned header.
    <View style={[styles.headerWrap, { backgroundColor: palette.sheetBg }]}>
      <View style={styles.header}>
        {nested && (
          <RoundButton icon="arrow_back" label={t("back")} onPress={() => router.back()} />
        )}
        <T w="semibold" size={24} style={styles.headerTitle} numberOfLines={1}>
          {title}
        </T>
        <RoundButton
          icon="close"
          label={t("close")}
          onPress={() => (nested ? router.dismiss(2) : router.back())}
        />
      </View>
    </View>
  );
}

function RoundButton({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress(): void;
}) {
  const palette = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [
        styles.roundButton,
        { backgroundColor: palette.surface },
        pressed && styles.pressed,
      ]}
    >
      <Icon name={icon} size={16} color={palette.text} />
    </Pressable>
  );
}

/** Section label (optional) above a grouped card. Rows are separated by hairlines; `plain` lays children out with a gap instead. */
export function ScreenSection({
  title,
  plain = false,
  children,
}: React.PropsWithChildren<{ title?: string; plain?: boolean }>) {
  const palette = usePalette();
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <View style={styles.section}>
      {title && <SectionLabel>{title}</SectionLabel>}
      <View
        style={[
          plain ? styles.plainGroup : styles.group,
          { backgroundColor: palette.groupBg },
        ]}
      >
        {plain
          ? items
          : items.map((item, i) => (
              <Fragment key={item.key ?? i}>
                {i > 0 && (
                  <View style={[styles.separator, { backgroundColor: palette.line }]} />
                )}
                {item}
              </Fragment>
            ))}
      </View>
    </View>
  );
}

export function SectionLabel({ children }: React.PropsWithChildren) {
  const palette = usePalette();
  return (
    <T w="medium" size={12} color={palette.text2} style={styles.sectionLabel}>
      {children}
    </T>
  );
}

/** Free-form grouped card. */
export function ScreenCard({
  children,
  style,
}: React.PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const palette = usePalette();
  return (
    <View style={[styles.card, { backgroundColor: palette.groupBg }, style]}>
      {children}
    </View>
  );
}

export function ScreenRow({
  labelKey,
  label,
  value,
  valueColor,
}: {
  labelKey?: keyof Strings;
  label?: string;
  value: string;
  valueColor?: string;
}) {
  const { t } = useT();
  const palette = usePalette();
  return (
    <View style={styles.row}>
      <T size={14} color={palette.text2} style={styles.rowLabel}>
        {label ?? (labelKey ? t(labelKey) : "")}
      </T>
      <T
        selectable
        w="medium"
        size={14}
        color={valueColor ?? palette.text}
        style={styles.rowValue}
      >
        {value}
      </T>
    </View>
  );
}

export function ScreenAction({
  labelKey,
  label,
  icon,
  onPress,
  disabled = false,
  secondary = false,
  compact = false,
}: {
  labelKey?: keyof Strings;
  label?: string;
  icon?: IconName;
  onPress?: () => void;
  disabled?: boolean;
  secondary?: boolean;
  compact?: boolean;
}) {
  const { t } = useT();
  const palette = usePalette();
  const fg = secondary ? palette.text : palette.onAccent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.action,
        compact && styles.actionCompact,
        { backgroundColor: secondary ? palette.secBg : palette.accent },
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      {icon && <Icon name={icon} size={18} color={fg} />}
      <T w="semibold" size={compact ? 14 : 15} color={fg}>
        {label ?? (labelKey ? t(labelKey) : "")}
      </T>
    </Pressable>
  );
}

export function ScreenLink({
  label,
  onPress,
}: {
  label: string;
  onPress(): void;
}) {
  const palette = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.link, pressed && styles.pressed]}
    >
      <T w="semibold" size={14} color={palette.accent}>
        {label}
      </T>
    </Pressable>
  );
}

export function ScreenNote({
  children,
  color,
}: React.PropsWithChildren<{ color?: string }>) {
  const palette = usePalette();
  return (
    <T size={13} color={color ?? palette.text2} style={styles.note}>
      {children}
    </T>
  );
}

export function Segmented<V extends string>({
  value,
  options,
  onChange,
}: {
  value: V;
  options: { value: V; label: string }[];
  onChange(value: V): void;
}) {
  const palette = usePalette();
  return (
    <View style={[styles.segmented, { backgroundColor: palette.surface }]}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[styles.segment, active && { backgroundColor: palette.accent }]}
          >
            <T
              w="semibold"
              size={14}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.75}
              color={active ? palette.onAccent : palette.text}
            >
              {option.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

export function StatusDot({ color, size = 10 }: { color: string; size?: number }) {
  return (
    <View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }}
    />
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
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 40,
    gap: 18,
  },
  contentNoHeader: { paddingTop: 16 },
  fullScreen: { flex: 1 },
  fullScreenHeader: { paddingHorizontal: 16, paddingTop: 8 },
  headerWrap: { marginHorizontal: -16, paddingHorizontal: 16, paddingBottom: 6, marginBottom: -6 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 6,
    paddingBottom: 12,
  },
  headerTitle: { flex: 1, letterSpacing: -0.24 },
  roundButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  section: { gap: 8 },
  sectionLabel: { paddingHorizontal: 4 },
  group: { paddingHorizontal: 16, borderRadius: Radius.rL, borderCurve: "continuous" },
  plainGroup: { padding: 16, gap: 12, borderRadius: Radius.rL, borderCurve: "continuous" },
  separator: { height: StyleSheet.hairlineWidth },
  card: { padding: 16, gap: 8, borderRadius: Radius.rL, borderCurve: "continuous" },
  row: {
    minHeight: 46,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
  },
  rowLabel: { flexShrink: 1 },
  rowValue: {
    maxWidth: "60%",
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
  action: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 20,
    borderRadius: Radius.pill,
  },
  actionCompact: { minHeight: 40, paddingHorizontal: 16 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
  link: { alignSelf: "center", paddingVertical: 4, paddingHorizontal: 8 },
  note: { paddingHorizontal: 4, lineHeight: 19 },
  segmented: {
    flexDirection: "row",
    gap: 4,
    padding: 4,
    borderRadius: Radius.pill,
  },
  segment: {
    flex: 1,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Radius.pill,
    paddingHorizontal: 6,
  },
});
