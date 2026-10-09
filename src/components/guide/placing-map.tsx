import { useNavigation } from "expo-router";
import { useEffect, useEffectEvent, useMemo, useState, type ReactNode } from "react";
import { Animated, BackHandler, PanResponder, Pressable, StyleSheet, View } from "react-native";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";

import { useScrollLock } from "@/components/guide/lesson-ui";
import { MapCard, MapCardButtons, MapCardHeader, MapChipButton } from "@/components/guide/map-ui";
import { CarGlyph, Puck, useMapColors, useNudgedHeading } from "@/components/guide/mini-map";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";

export type PlaceStep = "idle" | "position" | "heading" | "done";
export interface Point {
  x: number;
  y: number;
}

/** The frame, in map units; the map under it is larger, to drag around. A scene draws within `PLACING_MAP`. */
export const PLACING_FRAME = { w: 358, h: 430 };
export const PLACING_MAP = { x: -150, y: -150, w: 660, h: 730 };
const FRAME = PLACING_FRAME;
const MAP = PLACING_MAP;
/** The pin stays at the frame's centre while the map moves under it, as on the map screen. */
const PIN: Point = { x: FRAME.w / 2, y: FRAME.h / 2 };
/** Close enough to count as on the car (the pin then snaps onto it): the target circle drawn around it. */
const HIT_UNITS = 28;
/** The arrow counts as the car's direction within this. */
const HIT_DEG = 40;
/** Where to tap for the heading: ahead of the car (it faces up its road), above the pin. */
const AHEAD: Point = { x: PIN.x, y: PIN.y - 80 };
const AHEAD_R = 26;

/**
 * Putting the car on a lesson's drawn map (NAVIGATOR-SPEC §6.2) as the map screen does: the map dragged under the
 * centre pin, Here, a tap for the heading, Confirm. It leads to the right answer: a target circle on the car, Here only
 * with the pin's point in it (it snaps onto the car), a circle ahead of it, Confirm only with the arrow up its road.
 * The cards sit at the bottom, leaving the road ahead free to tap. Remount it (a new `key`) to start over.
 */
export function PlacingMap({
  step,
  onStep,
  onCancel,
  scene,
  car,
  carVisible = true,
  dot,
  dotR,
  dotHeadingDeg = null,
  startAt,
  overlay,
}: {
  step: PlaceStep;
  onStep(step: PlaceStep): void;
  /** Cancel, or the ✕ on the placed position. */
  onCancel(): void;
  /** What the map shows, in map units (within `PLACING_MAP`), under the car and the dot. */
  scene: ReactNode;
  /** Where the car really is: it faces up its road. */
  car: Point;
  carVisible?: boolean;
  /** The app's dot before it is placed. */
  dot: Point;
  dotR: number;
  dotHeadingDeg?: number | null;
  /** Where the pin starts when placing begins (the map moves to it); unset, the map stays. */
  startAt?: Point;
  /** Views over the map before placing (chips, cards, tags); `at` turns map units into points. */
  overlay?: (at: (p: Point) => { left: number; top: number }) => ReactNode;
}) {
  const { t } = useT();
  const palette = usePalette();
  const c = useMapColors();
  const lockScroll = useScrollLock();
  const [scale, setScale] = useState(1);
  const [headingDeg, setHeadingDeg] = useState<number | null>(null);
  const [onCar, setOnCar] = useState(false);
  // Once placed, the car points up its road.
  const placedHeading = useNudgedHeading(0);
  // The map's offset, points; whether the pin is on the car follows it.
  const [pan] = useState(() => new Animated.ValueXY({ x: 0, y: 0 }));
  useEffect(() => {
    const id = pan.addListener((value) => {
      setOnCar(Math.hypot(PIN.x - value.x / scale - car.x, PIN.y - value.y / scale - car.y) <= HIT_UNITS);
    });
    return () => pan.removeListener(id);
  }, [pan, scale, car]);

  // While placing, a drag from the frame's left edge is the map's, not the page's back swipe (iOS); Android's back
  // gesture can't be turned off, so there back cancels the placing instead of leaving the lesson.
  const navigation = useNavigation();
  const placingNow = step === "position" || step === "heading";
  const cancel = useEffectEvent(onCancel);
  useEffect(() => {
    if (!placingNow) return;
    navigation.setOptions({ gestureEnabled: false });
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      cancel();
      return true;
    });
    return () => {
      navigation.setOptions({ gestureEnabled: true });
      back.remove();
    };
  }, [placingNow, navigation]);

  // Placing starts with the pin where it was asked to (the dot, as the map screen does).
  useEffect(() => {
    if (step !== "position" || !startAt) return;
    Animated.spring(pan, {
      toValue: { x: (PIN.x - startAt.x) * scale, y: (PIN.y - startAt.y) * scale },
      useNativeDriver: false,
      bounciness: 0,
    }).start();
    // Once, when placing begins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step === "position"]);

  // Dragging moves the map, only while asking where the car is; it stops where the map still fills the frame.
  const responder = useMemo(() => {
    const clamp = (v: Point) => ({
      x: Math.min(-MAP.x * scale, Math.max(FRAME.w * scale - (MAP.x + MAP.w) * scale, v.x)),
      y: Math.min(-MAP.y * scale, Math.max(FRAME.h * scale - (MAP.y + MAP.h) * scale, v.y)),
    });
    const end = () => {
      lockScroll(false);
      pan.flattenOffset();
      pan.stopAnimation((at) => {
        // Close to the car: the pin settles on it.
        const near = Math.hypot(PIN.x - at.x / scale - car.x, PIN.y - at.y / scale - car.y) <= HIT_UNITS;
        const to = near ? { x: (PIN.x - car.x) * scale, y: (PIN.y - car.y) * scale } : clamp(at);
        Animated.spring(pan, { toValue: to, useNativeDriver: false, bounciness: 0 }).start();
      });
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => step === "position",
      onMoveShouldSetPanResponder: () => step === "position",
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        lockScroll(true);
        pan.extractOffset();
      },
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
      onPanResponderRelease: end,
      onPanResponderTerminate: end,
    });
  }, [step, scale, pan, lockScroll, car]);

  const done = step === "done";
  const placing = step === "position" || step === "heading";
  // The car faces up its road: the arrow has to point that way to go on.
  const headingRight = headingDeg != null && Math.abs(((headingDeg + 540) % 360) - 180) <= HIT_DEG;
  const at = (p: Point) => ({ left: p.x * scale, top: p.y * scale });

  return (
    <View
      style={[styles.frame, { backgroundColor: c.land }]}
      onLayout={(event) => setScale(event.nativeEvent.layout.width / FRAME.w)}
      {...responder.panHandlers}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          styles.layer,
          {
            left: MAP.x * scale,
            top: MAP.y * scale,
            width: MAP.w * scale,
            height: MAP.h * scale,
            transform: [{ translateX: pan.x }, { translateY: pan.y }],
          },
        ]}
      >
        <Svg width="100%" height="100%" viewBox={`${MAP.x} ${MAP.y} ${MAP.w} ${MAP.h}`}>
          <Rect x={MAP.x} y={MAP.y} width={MAP.w} height={MAP.h} fill={c.land} />
          {scene}
          {step === "position" && (
            // The target: exactly the area that counts as on the car, drawn in the map so it stays on it.
            <Circle
              cx={car.x}
              cy={car.y}
              r={HIT_UNITS}
              fill={onCar ? palette.ok.c : palette.accent}
              fillOpacity={0.16}
              stroke={onCar ? palette.ok.c : palette.accent}
              strokeWidth={2}
              strokeDasharray={onCar ? undefined : "6 4"}
            />
          )}
          {carVisible && !done && <CarGlyph x={car.x} y={car.y} />}
          {done ? (
            <Puck x={car.x} y={car.y} r={10} trusted={false} headingDeg={placedHeading} />
          ) : (
            <Puck x={dot.x} y={dot.y} r={dotR} trusted={false} headingDeg={placing ? null : dotHeadingDeg} />
          )}
        </Svg>
      </Animated.View>

      {step === "heading" && (
        // A tap draws the arrow from the pin that way; another turns it.
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={(event) => {
            const dx = event.nativeEvent.locationX - PIN.x * scale;
            const dy = event.nativeEvent.locationY - PIN.y * scale;
            if (Math.hypot(dx, dy) > 8) setHeadingDeg((Math.atan2(dx, -dy) * 180) / Math.PI);
          }}
          accessibilityLabel={t("placeHeadingHint")}
        />
      )}
      {placing && (
        <Svg pointerEvents="none" style={StyleSheet.absoluteFill} viewBox={`0 0 ${FRAME.w} ${FRAME.h}`}>
          {step === "heading" && !headingRight && (
            // Where to tap: ahead of the car, up its road.
            <Circle cx={AHEAD.x} cy={AHEAD.y} r={AHEAD_R} fill={palette.accent} fillOpacity={0.16} stroke={palette.accent} strokeWidth={2} strokeDasharray="6 4" />
          )}
          {step === "heading" && headingDeg != null && (
            <G transform={`rotate(${headingDeg} ${PIN.x} ${PIN.y})`}>
              <Path d={`M${PIN.x} ${PIN.y} V${PIN.y - 70}`} stroke={palette.accent} strokeWidth={4} strokeLinecap="round" />
              <Path d={`M${PIN.x - 11} ${PIN.y - 62} L${PIN.x} ${PIN.y - 84} L${PIN.x + 11} ${PIN.y - 62} Z`} fill={palette.accent} />
            </G>
          )}
          {/* The pin: its point is exactly the spot that is placed, the frame's centre. */}
          <G transform={`translate(${PIN.x} ${PIN.y})`}>
            <Path d="M0 0 C -4 -10 -16 -20 -16 -32 a16 16 0 1 1 32 0 C 16 -20 4 -10 0 0 Z" fill={palette.accent} stroke="#FFFFFF" strokeWidth={1.5} />
            <Circle cx={0} cy={-32} r={6} fill="#FFFFFF" />
            <Circle cx={0} cy={0} r={3} fill={palette.accent} stroke="#FFFFFF" strokeWidth={1.5} />
          </G>
        </Svg>
      )}

      {step === "idle" && overlay?.(at)}

      {step === "position" && (
        <MapCard style={styles.bottom}>
          <MapCardHeader icon="location_on" title={t("placeTitle")} body={t(onCar ? "placeOnCar" : "placeHint")} />
          <MapCardButtons
            buttons={[
              { label: t("placeCancel"), muted: true, onPress: onCancel },
              // Only on the car: the lesson leads there.
              { label: t("placeHere"), disabled: !onCar, onPress: () => onStep("heading") },
            ]}
          />
        </MapCard>
      )}
      {step === "heading" && (
        <MapCard style={styles.bottom}>
          <MapCardHeader
            icon="navigation"
            title={t("placeHeadingTitle")}
            body={t(headingDeg == null ? "placeHeadingHint" : headingRight ? "placeHeadingConfirm" : "placeWrongWay")}
          />
          <MapCardButtons
            buttons={[
              { label: t("placeCancel"), muted: true, onPress: onCancel },
              { label: t("placeConfirm"), disabled: !headingRight, onPress: () => onStep("done") },
            ]}
          />
        </MapCard>
      )}
      {done && (
        <MapChipButton
          icon="location_on"
          label={t("manualChip").replace("{age}", t("ageJustNow"))}
          onClose={onCancel}
          closeLabel={t("manualForget")}
          style={styles.topLeft}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: "100%",
    aspectRatio: FRAME.w / FRAME.h,
    borderRadius: Radius.rL,
    overflow: "hidden",
    borderCurve: "continuous",
  },
  layer: { position: "absolute" },
  topLeft: { top: 10, left: 10 },
  bottom: { bottom: 10 },
});
