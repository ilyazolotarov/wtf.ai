import { useEffect, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from "react-native";

/** The system's Reduce Motion setting (iOS, Android "Remove animations"): animations hold still. */
function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => live && setReduce(v));
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/** 0 → 1 over `ms`, again and again, on the native driver; held at 0 with Reduce Motion. */
function useLoop(ms: number, easing: (t: number) => number): Animated.Value {
  const [value] = useState(() => new Animated.Value(0));
  const reduce = useReduceMotion();
  useEffect(() => {
    value.setValue(0);
    if (reduce) return;
    const loop = Animated.loop(Animated.timing(value, { toValue: 1, duration: ms, easing, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [value, ms, easing, reduce]);
  return value;
}

const EASE_OUT = Easing.out(Easing.quad);
const EASE_IN_OUT = Easing.inOut(Easing.quad);

/** A ring growing out of the banner's icon and fading: the route is being planned. Fills its parent circle. */
export function PlanningPulse({ color, size }: { color: string; size: number }) {
  const t = useLoop(1400, EASE_OUT);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          borderRadius: size / 2,
          backgroundColor: color,
          opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
          transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] }) }],
        },
      ]}
    />
  );
}

/** A short bar sweeping along a thin track, as long as the planner works. */
export function PlanningSweep({ color }: { color: string }) {
  const t = useLoop(1300, EASE_IN_OUT);
  const [width, setWidth] = useState(0);
  const bar = Math.max(24, width * 0.35);
  return (
    <View style={styles.track} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <View style={[StyleSheet.absoluteFill, styles.faint, { backgroundColor: color }]} />
      {width > 0 && (
        <Animated.View
          style={[
            styles.bar,
            {
              width: bar,
              backgroundColor: color,
              transform: [{ translateX: t.interpolate({ inputRange: [0, 1], outputRange: [-bar, width] }) }],
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 3, borderRadius: 1.5, overflow: "hidden", marginTop: 6 },
  // The track: the bar's colour, faint; the bar draws over it at full strength.
  faint: { opacity: 0.18 },
  bar: { position: "absolute", top: 0, bottom: 0, borderRadius: 1.5 },
});
