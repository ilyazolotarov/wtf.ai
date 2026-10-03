/**
 * Launch splash (claude.ai/design "wtf.ai Redesign", options 2d/2e): the "wtf•ai"
 * wordmark where the puck's uncertainty disc tightens onto a fix, then the
 * overlay fades to the already-mounted map.
 *
 * The native splash (app.json) shows the first keyframe as a static image. This
 * overlay draws the same wordmark bitmap at the same spot, so the hand-off is
 * invisible. Bitmaps and the geometry below come from scripts/brand-assets.py.
 */

import * as SplashScreen from "expo-splash-screen";
import { useEffect, useEffectEvent, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Image,
  StyleSheet,
  useColorScheme,
  View,
} from "react-native";

import { Colors } from "@/constants/theme";
import { T } from "@/components/ui/text";
import { useT } from "@/i18n/provider";

/** Points; the canvas is centred on screen exactly like the native splash image. */
const SPLASH = {
  width: 300,
  height: 160,
  puck: 19,
  puckCx: 174.36,
  puckCy: 92,
  rowBottom: 112,
};

const WORDMARK = {
  light: require("@/assets/images/splash-wordmark-light.png"),
  dark: require("@/assets/images/splash-wordmark-dark.png"),
};

/** One loop of the design's wtfTight keyframes is 3.2 s; we play it up to the lock (41 %). */
const CYCLE_MS = 3200;
const ease = {
  in: Easing.bezier(0.42, 0, 1, 1),
  out: Easing.bezier(0, 0, 0.58, 1),
  inOut: Easing.bezier(0.42, 0, 0.58, 1),
};
/**
 * box-shadow layers of wtfTight: `halo` sits on top, `ring` under it.
 * [time fraction, halo spread, halo alpha, ring spread, ring alpha, easing into this frame]
 */
const KEYFRAMES: [number, number, number, number, number, (t: number) => number][] = [
  [0, 52, 0.06, 50, 0.35, Easing.linear],
  [0.04, 52, 0.06, 50, 0.35, Easing.linear],
  [0.23, 7, 0.22, 7, 0, ease.in],
  [0.27, 2, 0.26, 2, 0, ease.out],
  [0.31, 11, 0.2, 11, 0, ease.inOut],
  [0.35, 5, 0.23, 5, 0, ease.inOut],
  [0.38, 8, 0.22, 8, 0, ease.inOut],
  [0.41, 7, 0.22, 7, 0, ease.inOut],
];
const HOLD_MS = 350;
const FADE_MS = 350;

const MAX_D = SPLASH.puck + 2 * 52;
const steps = KEYFRAMES.map((_, i) => i);
const scaleOf = (spread: number) => (SPLASH.puck + 2 * spread) / MAX_D;

export function AnimatedSplash({ onDone }: { onDone(): void }) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const palette = Colors[scheme];
  const { t } = useT();
  const [progress] = useState(() => new Animated.Value(0));
  const [opacity] = useState(() => new Animated.Value(1));
  const [textOpacity] = useState(() => new Animated.Value(0));
  const [loaded, setLoaded] = useState(false);
  const finish = useEffectEvent(onDone);

  useEffect(() => {
    if (!loaded) return;
    void SplashScreen.hideAsync();
    let cancelled = false;
    const run = (reduceMotion: boolean) => {
      if (cancelled) return;
      const settle = reduceMotion
        ? Animated.delay(600)
        : Animated.sequence(
            KEYFRAMES.slice(1).map(([at, , , , , easing], i) =>
              Animated.timing(progress, {
                toValue: i + 1,
                duration: (at - KEYFRAMES[i][0]) * CYCLE_MS,
                easing,
                useNativeDriver: true,
              }),
            ),
          );
      if (reduceMotion) progress.setValue(steps.length - 1);
      Animated.sequence([
        Animated.parallel([
          settle,
          Animated.timing(textOpacity, {
            toValue: 1,
            duration: 400,
            easing: ease.out,
            useNativeDriver: true,
          }),
        ]),
        Animated.delay(HOLD_MS),
        Animated.timing(opacity, {
          toValue: 0,
          duration: FADE_MS,
          easing: ease.inOut,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => finished && finish());
    };
    void AccessibilityInfo.isReduceMotionEnabled().then(run, () => run(false));
    return () => {
      cancelled = true;
    };
  }, [loaded, opacity, progress, textOpacity]);

  // If the bitmap never reports back, don't leave the native splash up forever.
  useEffect(() => {
    const timer = setTimeout(() => setLoaded(true), 800);
    return () => clearTimeout(timer);
  }, []);

  const layer = (spreadIdx: 1 | 3, alphaIdx: 2 | 4) => ({
    opacity: progress.interpolate({
      inputRange: steps,
      outputRange: KEYFRAMES.map((k) => k[alphaIdx]),
    }),
    transform: [
      {
        scale: progress.interpolate({
          inputRange: steps,
          outputRange: KEYFRAMES.map((k) => scaleOf(k[spreadIdx])),
        }),
      },
    ],
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.root, { backgroundColor: palette.bg, opacity }]}
    >
      <View style={styles.canvas}>
        <Animated.View
          style={[styles.disc, { backgroundColor: palette.accent }, layer(3, 4)]}
        />
        <Animated.View
          style={[styles.disc, { backgroundColor: palette.accent }, layer(1, 2)]}
        />
        <View style={[styles.puck, { backgroundColor: palette.accent }]} />
        <Image
          source={WORDMARK[scheme]}
          style={styles.wordmark}
          fadeDuration={0}
          onLoadEnd={() => setLoaded(true)}
        />
        <Animated.View style={[styles.tagline, { opacity: textOpacity }]}>
          <T size={16} color={palette.text2}>
            {t("splashTagline")}
          </T>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  canvas: { width: SPLASH.width, height: SPLASH.height },
  disc: {
    position: "absolute",
    left: SPLASH.puckCx - MAX_D / 2,
    top: SPLASH.puckCy - MAX_D / 2,
    width: MAX_D,
    height: MAX_D,
    borderRadius: MAX_D / 2,
  },
  puck: {
    position: "absolute",
    left: SPLASH.puckCx - SPLASH.puck / 2,
    top: SPLASH.puckCy - SPLASH.puck / 2,
    width: SPLASH.puck,
    height: SPLASH.puck,
    borderRadius: SPLASH.puck / 2,
  },
  wordmark: { ...StyleSheet.absoluteFill, width: SPLASH.width, height: SPLASH.height },
  tagline: {
    position: "absolute",
    top: SPLASH.rowBottom + 22,
    left: 0,
    right: 0,
    alignItems: "center",
  },
});
