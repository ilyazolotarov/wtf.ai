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

/** The map controls the tour points at, measured in window coordinates when it starts and as their layout changes. */
export interface TourTargets {
  /** The top stack: the status pill, and its explanation once unfolded. */
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

/** The stops a driver can try for real: the hole lets touches through to the control under it. */
export type TourTry = "status" | "hold" | "follow";

interface Stop {
  /** Tried for real: what it is, and the line once done. */
  tries?: { id: TourTry; done: keyof Strings };
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
/**
 * The dimmed screen's touches: taken and dropped. An empty view alone would not do it on Android, where a view with
 * only layout is left out of the native tree and the control under it gets the tap.
 */
const BLOCK = { onStartShouldSetResponder: () => true } as const;

/** The map's offer of the tour, once after onboarding and the first map. */
export function TourInvite(props: { panelStyle: StyleProp<ViewStyle>; onStart(): void; onDismiss(): void }) {
  return <InviteCard {...props} title="tourInviteTitle" body="tourInviteBody" start="tourShowMe" />;
}

/**
 * The map's offer of the lessons, after the tour's (UI-SPEC §7.7): practice before the first drives. Right after the
 * tour it is the tour's end too (`afterTour`).
 */
export function LessonsInvite({
  afterTour = false,
  ...props
}: {
  panelStyle: StyleProp<ViewStyle>;
  afterTour?: boolean;
  onStart(): void;
  onDismiss(): void;
}) {
  return (
    <InviteCard
      {...props}
      title={afterTour ? "lessonsInviteAfterTour" : "lessonsInviteTitle"}
      body="lessonsInviteBody"
      start="lessonsInviteStart"
    />
  );
}

function InviteCard({
  panelStyle,
  onStart,
  onDismiss,
  title,
  body,
  start,
}: {
  /** The map's panel style (shadow), as its other cards have. */
  panelStyle: StyleProp<ViewStyle>;
  onStart(): void;
  onDismiss(): void;
  title: keyof Strings;
  body: keyof Strings;
  start: keyof Strings;
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
            {t(title)}
          </T>
          <T size={13} color={palette.text2}>
            {t(body)}
          </T>
        </View>
      </View>
      <View style={styles.buttons}>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, { backgroundColor: palette.surface }, pressed && styles.pressed]}
        >
          <T w="semibold" size={14} color={palette.text2} fit>
            {t("notNow")}
          </T>
        </Pressable>
        <Pressable
          onPress={onStart}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, { backgroundColor: palette.accent }, pressed && styles.pressed]}
        >
          <T w="semibold" size={14} color={palette.onAccent} fit>
            {t(start)}
          </T>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Coach marks over the map (UI-SPEC §7.7): the screen dims except one control at a time, with a card saying what
 * it does. The dot's stop is the screen centre: the tour starts the follow camera, which centres the car. Three stops
 * are tried for real through their hole (the status pill unfolds, a long press drops a pin, the camera button
 * switches); the map says which were (`tried`), and hears of each stop shown (`onStop`). Done ends it: the map then
 * offers the lessons in the same breath.
 */
export function MapTour({
  targets,
  step,
  onStep,
  layoutVersion,
  tried,
  onStop,
  onClose,
}: {
  targets: TourTargets;
  /** The stop shown, kept by the map: the tour unmounts while a page is over the map and goes on where it was. */
  step: number;
  onStep(step: number): void;
  /** Changes when a target's layout does (the status unfolding): measured again. */
  layoutVersion: number;
  tried: ReadonlySet<TourTry>;
  onStop(id: TourTry | null): void;
  /** Skip, or Done after the last stop (`finished`). */
  onClose(finished: boolean): void;
}) {
  const { t } = useT();
  const palette = usePalette();
  const { width, height } = useWindowDimensions();
  const [boxes, setBoxes] = useState<{ status?: Box; follow?: Box; toolbar?: Box } | null>(null);

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
  }, [targets, layoutVersion]);

  const stops = boxes ? tourStops(boxes, width, height) : [];
  const shown = stops.length === 0 ? null : stops[Math.min(step, stops.length - 1)];
  const shownTry = shown?.tries?.id ?? null;
  const stopChanged = useEffectEvent(onStop);
  useEffect(() => stopChanged(shownTry), [shownTry]);

  // Nothing measured to show (no stops): there is no tour to give.
  if (!boxes || stops.length === 0) return null;

  const stop = stops[Math.min(step, stops.length - 1)];
  const last = step >= stops.length - 1;
  const { hole } = stop;
  const above = hole.y + hole.h / 2 > height / 2;
  const done = stop.tries && tried.has(stop.tries.id);

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <Svg pointerEvents="none" width={width} height={height} style={StyleSheet.absoluteFill}>
        <Path
          d={`M0 0 H${width} V${height} H0 Z ${roundedRect(hole, stop.radius)}`}
          fill="rgba(14,13,12,0.62)"
          fillRule="evenodd"
        />
        <Path d={roundedRect(hole, stop.radius)} fill="none" stroke="#FFFFFF" strokeWidth={2} />
      </Svg>
      {/* Touches stop at the dimmed screen; a stop to try lets them through its hole. */}
      {stop.tries ? (
        <>
          <View {...BLOCK} style={[styles.block, { left: 0, top: 0, width, height: Math.max(0, hole.y) }]} />
          <View {...BLOCK} style={[styles.block, { left: 0, top: hole.y + hole.h, width, bottom: 0 }]} />
          <View {...BLOCK} style={[styles.block, { left: 0, top: hole.y, width: Math.max(0, hole.x), height: hole.h }]} />
          <View {...BLOCK} style={[styles.block, { left: hole.x + hole.w, top: hole.y, right: 0, height: hole.h }]} />
        </>
      ) : (
        <View {...BLOCK} style={StyleSheet.absoluteFill} />
      )}
      {stop.ring && !done && <PulseRing box={hole} color={palette.accent} />}
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
          <Pressable onPress={() => onClose(false)} hitSlop={10} accessibilityRole="button">
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
        {done && stop.tries && (
          <View style={styles.doneRow}>
            <Icon name="check" size={18} color={palette.ok.c} />
            <T size={14} style={styles.doneText}>
              {t(stop.tries.done)}
            </T>
          </View>
        )}
        <View style={styles.buttons}>
          {step > 0 && (
            <Pressable
              onPress={() => onStep(step - 1)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.button, { backgroundColor: palette.surface }, pressed && styles.pressed]}
            >
              <T w="semibold" size={14} fit>
                {t("tourBack")}
              </T>
            </Pressable>
          )}
          <Pressable
            onPress={() => (last ? onClose(true) : onStep(step + 1))}
            accessibilityRole="button"
            style={({ pressed }) => [styles.button, { backgroundColor: palette.accent }, pressed && styles.pressed]}
          >
            <T w="semibold" size={14} color={palette.onAccent} fit>
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
    stops.push({
      tries: { id: "status", done: "tourStatusTried" },
      title: "tourStatusTitle",
      body: "tourStatusBody",
      hole,
      radius: Math.min(hole.h / 2, 34),
    });
  }
  stops.push({ title: "tourDotTitle", body: "tourDotBody", hole: circle(width / 2, height / 2, 70), radius: 70 });
  stops.push({
    tries: { id: "hold", done: "tourHoldTried" },
    title: "tourHoldTitle",
    body: "tourHoldBody",
    hole: circle(width * 0.72, height * 0.34, 46),
    radius: 46,
    ring: true,
  });
  if (boxes.follow) {
    const r = Math.max(boxes.follow.w, boxes.follow.h) / 2 + 8;
    const hole = circle(boxes.follow.x + boxes.follow.w / 2, boxes.follow.y + boxes.follow.h / 2, r);
    stops.push({ tries: { id: "follow", done: "tourFollowTried" }, title: "tourFollowTitle", body: "tourFollowBody", hole, radius: r });
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
  // Side by side, equal, while both labels fit; otherwise stacked (a large text size, a long label).
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  button: {
    flexGrow: 1,
    minWidth: "40%",
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
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
  block: { position: "absolute" },
  doneRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  doneText: { flex: 1, lineHeight: 20 },
});
