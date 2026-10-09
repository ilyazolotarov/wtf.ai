import { router } from "expo-router";
import { useEffect, useEffectEvent, useState, type RefObject } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Svg, { Path } from "react-native-svg";

import { GlassFill } from "@/components/ui/glass-fill";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";

/** The map controls the tour points at, measured in window coordinates when it starts. */
export interface TourTargets {
  status: RefObject<View | null>;
  follow: RefObject<View | null>;
  /** The bottom bar: Route, Vehicle, More in equal thirds (padding 6, gap 4). */
  toolbar: RefObject<View | null>;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Stop {
  title: keyof Strings;
  body: keyof Strings;
  hole: Box;
  /** Corner radius; half the size makes a circle. */
  radius: number;
  /** A pulsing ring: press and hold here. */
  ring?: boolean;
}

const TOOLBAR_PADDING = 6;
const TOOLBAR_GAP = 4;
/** The finished note stays this long. */
const FINISHED_MS = 6000;

/** The map's offer of the tour, once after onboarding and the first map. */
export function TourInvite({
  panelStyle,
  onStart,
  onDismiss,
}: {
  /** The map's panel style (shadow), as its other cards have. */
  panelStyle: StyleProp<ViewStyle>;
  onStart(): void;
  onDismiss(): void;
}) {
  const { t } = useT();
  const palette = usePalette();
  return (
    <View style={[panelStyle, styles.invite]}>
      <GlassFill radius={Radius.rL} />
      <View style={styles.inviteRow}>
        <View style={[styles.inviteIcon, { backgroundColor: palette.accentA }]}>
          <Icon name="menu_book" size={20} color={palette.accent} />
        </View>
        <View style={styles.inviteCopy}>
          <T w="semibold" size={15}>
            {t("tourInviteTitle")}
          </T>
          <T size={13} color={palette.text2}>
            {t("tourInviteBody")}
          </T>
        </View>
      </View>
      <View style={styles.buttons}>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, { backgroundColor: palette.surface }, pressed && styles.pressed]}
        >
          <T w="semibold" size={14} color={palette.text2}>
            {t("notNow")}
          </T>
        </Pressable>
        <Pressable
          onPress={onStart}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, { backgroundColor: palette.accent }, pressed && styles.pressed]}
        >
          <T w="semibold" size={14} color={palette.onAccent}>
            {t("tourShowMe")}
          </T>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Coach marks over the map (UI-SPEC §7.7): the screen dims except one control at a time, with a card saying what
 * it does. The dot's stop is the screen centre: the tour starts the follow camera, which centres the car.
 */
export function MapTour({ targets, onClose }: { targets: TourTargets; onClose(): void }) {
  const { t } = useT();
  const palette = usePalette();
  const { width, height } = useWindowDimensions();
  const [boxes, setBoxes] = useState<{ status?: Box; follow?: Box; toolbar?: Box } | null>(null);
  const [step, setStep] = useState(0);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    const keys = ["status", "follow", "toolbar"] as const;
    void Promise.all(
      keys.map(
        (key) =>
          new Promise<Box | undefined>((resolve) => {
            const view = targets[key].current;
            if (!view) resolve(undefined);
            else view.measureInWindow((x, y, w, h) => resolve(w > 0 ? { x, y, w, h } : undefined));
          }),
      ),
    ).then(([status, follow, toolbar]) => setBoxes({ status, follow, toolbar }));
  }, [targets]);

  // The map redraws twice a second with a new `onClose`; the note's timer must not restart each time.
  const close = useEffectEvent(onClose);
  useEffect(() => {
    if (!finished) return;
    const timer = setTimeout(() => close(), FINISHED_MS);
    return () => clearTimeout(timer);
  }, [finished]);

  if (!boxes) return null;
  const stops = tourStops(boxes, width, height);

  if (finished || stops.length === 0) {
    return (
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        <View style={[styles.toast, { bottom: height - (boxes.toolbar?.y ?? height - 100) + 84 }]}>
          <T size={14} color="#F2F0EC" style={styles.toastText}>
            {t("tourFinished")}
          </T>
          <Pressable
            onPress={() => {
              onClose();
              router.push("/guide");
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.toastButton, pressed && styles.pressed]}
          >
            <T w="semibold" size={14} color="#0E1220">
              {t("guideTitle")}
            </T>
          </Pressable>
        </View>
      </View>
    );
  }

  const stop = stops[Math.min(step, stops.length - 1)];
  const last = step >= stops.length - 1;
  const { hole } = stop;
  const above = hole.y + hole.h / 2 > height / 2;

  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <Path
          d={`M0 0 H${width} V${height} H0 Z ${roundedRect(hole, stop.radius)}`}
          fill="rgba(14,13,12,0.62)"
          fillRule="evenodd"
        />
        <Path d={roundedRect(hole, stop.radius)} fill="none" stroke="#FFFFFF" strokeWidth={2} />
      </Svg>
      {stop.ring && <PulseRing box={hole} color={palette.accent} />}
      <View
        style={[
          styles.card,
          { backgroundColor: palette.groupBg },
          above ? { bottom: height - hole.y + 16 } : { top: hole.y + hole.h + 16 },
        ]}
      >
        <View style={styles.cardTop}>
          <T w="semibold" size={12} color={palette.accent} style={styles.kicker}>
            {t("tourStep").replace("{n}", String(step + 1)).replace("{total}", String(stops.length))}
          </T>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
            <T w="medium" size={13} color={palette.text2}>
              {t("tourSkip")}
            </T>
          </Pressable>
        </View>
        <T w="semibold" size={18} style={styles.cardTitle}>
          {t(stop.title)}
        </T>
        <T size={14} color={palette.text2} style={styles.cardBody}>
          {t(stop.body)}
        </T>
        <View style={styles.buttons}>
          {step > 0 && (
            <Pressable
              onPress={() => setStep(step - 1)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.button, { backgroundColor: palette.surface }, pressed && styles.pressed]}
            >
              <T w="semibold" size={14}>
                {t("tourBack")}
              </T>
            </Pressable>
          )}
          <Pressable
            onPress={() => (last ? setFinished(true) : setStep(step + 1))}
            accessibilityRole="button"
            style={({ pressed }) => [styles.button, { backgroundColor: palette.accent }, pressed && styles.pressed]}
          >
            <T w="semibold" size={14} color={palette.onAccent}>
              {last ? t("tourDone") : t("tourNext")}
            </T>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** The six stops, those whose control was measured. */
function tourStops(boxes: { status?: Box; follow?: Box; toolbar?: Box }, width: number, height: number): Stop[] {
  const stops: Stop[] = [];
  const pad = (box: Box, by: number): Box => ({ x: box.x - by, y: box.y - by, w: box.w + 2 * by, h: box.h + 2 * by });
  const circle = (cx: number, cy: number, r: number): Box => ({ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r });
  if (boxes.status) {
    const hole = pad(boxes.status, 6);
    stops.push({ title: "tourStatusTitle", body: "tourStatusBody", hole, radius: hole.h / 2 });
  }
  stops.push({ title: "tourDotTitle", body: "tourDotBody", hole: circle(width / 2, height / 2, 70), radius: 70 });
  stops.push({
    title: "tourHoldTitle",
    body: "tourHoldBody",
    hole: circle(width * 0.72, height * 0.34, 46),
    radius: 46,
    ring: true,
  });
  if (boxes.follow) {
    const r = Math.max(boxes.follow.w, boxes.follow.h) / 2 + 8;
    const hole = circle(boxes.follow.x + boxes.follow.w / 2, boxes.follow.y + boxes.follow.h / 2, r);
    stops.push({ title: "tourFollowTitle", body: "tourFollowBody", hole, radius: r });
  }
  if (boxes.toolbar) {
    const bar = boxes.toolbar;
    const third = (bar.w - 2 * TOOLBAR_PADDING - 2 * TOOLBAR_GAP) / 3;
    const action = (i: number): Box =>
      pad({ x: bar.x + TOOLBAR_PADDING + i * (third + TOOLBAR_GAP), y: bar.y + TOOLBAR_PADDING, w: third, h: bar.h - 2 * TOOLBAR_PADDING }, 4);
    stops.push({ title: "tourCarTitle", body: "tourCarBody", hole: action(1), radius: 24 });
    stops.push({ title: "tourMoreTitle", body: "tourMoreBody", hole: action(2), radius: 24 });
  }
  return stops;
}

/** SVG path of a rounded rectangle (a circle when `r` is half its size). */
function roundedRect({ x, y, w, h }: Box, radius: number): string {
  const r = Math.min(radius, w / 2, h / 2);
  return (
    `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + h - r} ` +
    `A${r} ${r} 0 0 1 ${x + w - r} ${y + h} H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r} ` +
    `V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`
  );
}

/** A ring growing out of the hole's centre: where a finger presses and holds. */
function PulseRing({ box, color }: { box: Box; color: string }) {
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(progress, { toValue: 1, duration: 1400, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [progress]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.ring,
        {
          left: box.x,
          top: box.y,
          width: box.w,
          height: box.h,
          borderRadius: box.w / 2,
          borderColor: color,
          opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }),
          transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1.2] }) }],
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  invite: { gap: 12, padding: 16, borderRadius: Radius.rL },
  inviteRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  inviteIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  inviteCopy: { flex: 1, gap: 2 },
  buttons: { flexDirection: "row", gap: 8, marginTop: 4 },
  button: { flex: 1, height: 44, borderRadius: Radius.pill, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.75 },
  card: {
    position: "absolute",
    left: 16,
    right: 16,
    borderRadius: Radius.rL,
    padding: 18,
    gap: 8,
    borderCurve: "continuous",
  },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  kicker: { letterSpacing: 0.4 },
  cardTitle: { lineHeight: 23 },
  cardBody: { lineHeight: 20 },
  ring: { position: "absolute", borderWidth: 3 },
  toast: {
    position: "absolute",
    left: 16,
    right: 16,
    borderRadius: Radius.rL,
    borderCurve: "continuous",
    backgroundColor: "rgba(29,28,26,0.94)",
    paddingVertical: 10,
    paddingLeft: 18,
    paddingRight: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  toastText: { flex: 1, lineHeight: 19 },
  toastButton: {
    height: 40,
    paddingHorizontal: 18,
    borderRadius: Radius.pill,
    backgroundColor: "#90BAF1",
    justifyContent: "center",
  },
});
