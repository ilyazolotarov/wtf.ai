import { router, useNavigation, useRoute } from "expo-router";
import { Children, Fragment, isValidElement } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Platform,
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
 * A page's body. With `title`, the page header below the status bar, pinned while the body scrolls: a back button
 * (the system's swipe from the left edge goes back too), the title, and from the second level down a close button
 * back to the map. Without, a plain scrolling body (pages with the system's header, the first-run map download).
 * `fullScreen`: no header at all (the first-run map download), so the body keeps clear of the status bar itself.
 */
export function ScreenContent({
  title,
  scrollEnabled = true,
  fullScreen = false,
  children,
}: React.PropsWithChildren<{ title?: string; scrollEnabled?: boolean; fullScreen?: boolean }>) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  if (title)
    return (
      // Sideways the navigation bar and cutouts are at the sides: the page keeps clear of them too.
      <View
        style={[
          styles.page,
          { backgroundColor: palette.sheetBg, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right },
        ]}
      >
        <View style={styles.pageHeader}>
          <PageHeader title={title} />
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          scrollEnabled={scrollEnabled}
          contentContainerStyle={[styles.content, { paddingBottom: styles.content.paddingBottom + insets.bottom }]}
        >
          {children}
        </ScrollView>
      </View>
    );
  // iOS insets the scrolling body by the bars itself (`contentInsetAdjustmentBehavior`); Android draws edge to edge
  // and leaves it to the app: the end of the body clear of the navigation bar, and with no header above, the top of
  // the status bar (the page stops under it rather than scrolling behind the clock).
  const android = Platform.OS === "android";
  const body = (
    <ScrollView
      style={{ backgroundColor: palette.sheetBg }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      scrollEnabled={scrollEnabled}
      contentContainerStyle={[
        styles.content,
        styles.contentNoHeader,
        android && { paddingBottom: styles.content.paddingBottom + insets.bottom },
      ]}
    >
      {children}
    </ScrollView>
  );
  if (!(android && fullScreen)) return body;
  return (
    <View
      style={[
        styles.page,
        { backgroundColor: palette.sheetBg, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right },
      ]}
    >
      {body}
    </View>
  );
}

function PageHeader({ title }: { title: string }) {
  const { t } = useT();
  const palette = usePalette();
  const navigation = useNavigation();
  const route = useRoute();
  // How deep this page is: 1 right over the map; deeper pages also get a way straight back to it.
  const depth = navigation.getState()?.routes.findIndex((r) => r.key === route.key) ?? 0;
  return (
    // Opaque and full-bleed so scrolled content doesn't show beside or under the pinned header.
    <View style={[styles.headerWrap, { backgroundColor: palette.sheetBg }]}>
      <View style={styles.header}>
        {depth > 0 && <RoundButton icon="arrow_back" label={t("back")} onPress={() => router.back()} />}
        <T w="semibold" size={24} style={styles.headerTitle} fit>
          {title}
        </T>
        {depth > 1 && <RoundButton icon="close" label={t("close")} onPress={() => router.dismissAll()} />}
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
      <T w="semibold" size={compact ? 14 : 15} color={fg} fit>
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
      <T w="semibold" size={14} color={palette.accent} fit>
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
            <T w="semibold" size={14} fit color={active ? palette.onAccent : palette.text}>
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
  page: { flex: 1 },
  pageHeader: { paddingHorizontal: 16, paddingTop: 8 },
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
  // Label and value side by side while they fit on one line; otherwise the value goes under the label, on the right
  // (a large text size, long Ukrainian labels), instead of both breaking into narrow columns.
  row: {
    minHeight: 46,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    columnGap: 12,
    rowGap: 2,
    paddingVertical: 8,
  },
  rowLabel: { flexShrink: 1 },
  rowValue: {
    flexShrink: 1,
    marginLeft: "auto",
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
