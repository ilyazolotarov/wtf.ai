import type { PropsWithChildren, ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { GlassFill } from "@/components/ui/glass-fill";
import { Icon, type IconName } from "@/components/ui/icon";
import { PressableFeedback } from "@/components/ui/press-feedback";
import { T } from "@/components/ui/text";
import { Radius, usePalette, type StatusColor } from "@/constants/theme";
import { useT } from "@/i18n/provider";

/** The map's floating panels: continuous corners and the theme's shadow (cards from elsewhere take it as `panelStyle`). */
export function usePanelStyle(): StyleProp<ViewStyle> {
  const palette = usePalette();
  return [hud.panel, { boxShadow: palette.shadow }];
}

/** A card icon's colours: `a` the round tile, `c` the glyph. */
export type Tone = Pick<StatusColor, "a" | "c">;

/**
 * A card over the map (UI-SPEC §6.3): a round icon, a title and lines beside it, an optional ✕, and what goes under
 * them (`children`: buttons, mostly in `CardActions`).
 */
export function HudCard({
  icon,
  tone,
  title,
  lines,
  onClose,
  children,
}: PropsWithChildren<{ icon: IconName; tone: Tone; title?: string; lines?: ReactNode; onClose?(): void }>) {
  const panel = usePanelStyle();
  const palette = usePalette();
  const { t } = useT();
  return (
    <View style={[panel, hud.card]}>
      <GlassFill radius={Radius.rL} />
      <View style={hud.row}>
        <View style={[hud.icon, { backgroundColor: tone.a }]}>
          <Icon name={icon} size={20} color={tone.c} />
        </View>
        <View style={hud.text}>
          {title && (
            <T w="semibold" size={15}>
              {title}
            </T>
          )}
          {lines}
        </View>
        {onClose && (
          <PressableFeedback
            onPress={onClose}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t("cancel")}
            style={hud.close}
          >
            <Icon name="close" size={20} color={palette.text2} />
          </PressableFeedback>
        )}
      </View>
      {children}
    </View>
  );
}

/** A line under a card's title, secondary text unless `color` says otherwise. */
export function CardLine({ color, children }: PropsWithChildren<{ color?: string }>) {
  const palette = usePalette();
  return (
    <T size={13} color={color ?? palette.text2}>
      {children}
    </T>
  );
}

/** A card's buttons side by side. */
export function CardActions({ gap = 8, children }: PropsWithChildren<{ gap?: number }>) {
  return <View style={[hud.actions, { gap }]}>{children}</View>;
}

/** A quiet text button on a card; `wide` shares the row with its neighbours, `sub` is a second line. */
export function CardButton({
  label,
  onPress,
  color,
  sub,
  wide,
  disabled,
  primary,
}: {
  label: string;
  onPress(): void;
  color?: string;
  sub?: string;
  wide?: boolean;
  disabled?: boolean;
  /** The card's main action: filled with the accent. */
  primary?: boolean;
}) {
  const palette = usePalette();
  return (
    <PressableFeedback
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={[
        hud.button,
        wide && hud.wide,
        { backgroundColor: primary ? palette.accent : palette.surface },
        disabled && hud.disabled,
      ]}
    >
      <T w="semibold" size={14} color={primary ? palette.onAccent : (color ?? palette.text)} fit>
        {label}
      </T>
      {sub && (
        <T size={12} color={primary ? palette.onAccent : palette.text2} fit>
          {sub}
        </T>
      )}
    </PressableFeedback>
  );
}

/** A pill button with an icon on a card; `primary` is filled with the accent, the others grey in the text colour. */
export function PillButton({
  icon,
  label,
  onPress,
  primary,
}: {
  icon: IconName;
  label: string;
  onPress(): void;
  primary?: boolean;
}) {
  const palette = usePalette();
  const color = primary ? palette.onAccent : palette.text;
  return (
    <PressableFeedback
      onPress={onPress}
      accessibilityRole="button"
      style={[hud.pill, { backgroundColor: primary ? palette.accent : palette.surface }]}
    >
      <Icon name={icon} size={16} color={color} />
      <T w="semibold" size={15} color={color} fit>
        {label}
      </T>
    </PressableFeedback>
  );
}

/** A one-line chip under the status pill; pressable when it has `onPress`. */
export function HudChip({
  icon,
  label,
  color,
  onPress,
  primary,
}: {
  icon: IconName;
  label: string;
  color?: string;
  onPress?(): void;
  /** An action the map offers: filled with the accent instead of glass. */
  primary?: boolean;
}) {
  const panel = usePanelStyle();
  const palette = usePalette();
  const ink = primary ? palette.onAccent : (color ?? palette.text);
  const body = (
    <>
      {primary ? <View style={[hud.fill, { backgroundColor: palette.accent }]} /> : <GlassFill radius={Radius.pill} />}
      <Icon name={icon} size={16} color={ink} />
      {/* Its own box: in a row sized by its content, a label measured wide and then narrowed is cut off, not shrunk. */}
      <View style={hud.fitBox}>
        <T w="semibold" size={13} color={ink} fit>
          {label}
        </T>
      </View>
    </>
  );
  if (!onPress) return <View style={[panel, hud.chip]}>{body}</View>;
  return (
    <PressableFeedback onPress={onPress} style={[panel, hud.chip]} accessibilityRole="button">
      {body}
    </PressableFeedback>
  );
}

export const hud = StyleSheet.create({
  panel: { borderCurve: "continuous" },
  disabled: { opacity: 0.4 },
  fill: { ...StyleSheet.absoluteFill, borderRadius: Radius.pill },
  fitBox: { flexShrink: 1 },
  card: { gap: 12, padding: 16, borderRadius: Radius.rL },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  // As tall as the icon at least: a title alone sits level with it; more lines start at its top.
  text: { flex: 1, minHeight: 40, justifyContent: "center" },
  close: { minHeight: 40, justifyContent: "center" },
  // Side by side, equal, while both labels fit; otherwise stacked (a large text size, a long label).
  actions: { flexDirection: "row", flexWrap: "wrap" },
  button: {
    gap: 2,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 18,
  },
  wide: { flexGrow: 1, minWidth: "40%", alignItems: "center" },
  pill: {
    flexGrow: 1,
    minWidth: "40%",
    minHeight: 44,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: Radius.pill,
  },
  chip: {
    alignSelf: "flex-start",
    maxWidth: "100%",
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 12,
    paddingRight: 14,
    borderRadius: Radius.pill,
  },
});
