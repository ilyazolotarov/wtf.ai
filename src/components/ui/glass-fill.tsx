import { BlurTargetView, BlurView } from "expo-blur";
import { createContext, useContext, useRef, type PropsWithChildren, type RefObject } from "react";
import { Platform, StyleSheet, useColorScheme, View } from "react-native";

import { usePalette } from "@/constants/theme";

/**
 * On Android, a BlurView only blurs what sits inside a BlurTargetView (expo-blur, SDK 57). A screen wraps everything
 * in a BlurScope, which hands the target to its panels, and only the map in a BlurTarget: the blur must be outside the
 * target it samples. Without a scope (or before Android 12) a panel gets a dense tint instead.
 * (Until 2026-10-14 the target's ref was provided inside the BlurTarget, around the map only: no panel ever saw it,
 * and every Android panel was the dense tint.)
 */
const BlurTargetContext = createContext<RefObject<View | null> | null>(null);

export function BlurScope({ children }: PropsWithChildren) {
  const ref = useRef<View | null>(null);
  if (Platform.OS !== "android") return <>{children}</>;
  return <BlurTargetContext.Provider value={ref}>{children}</BlurTargetContext.Provider>;
}

/** What the scope's panels blur: the map. Inside a BlurScope. */
export function BlurTarget({ children }: PropsWithChildren) {
  const ref = useContext(BlurTargetContext);
  if (Platform.OS !== "android" || !ref) return <>{children}</>;
  return (
    <BlurTargetView ref={ref} style={StyleSheet.absoluteFill}>
      {children}
    </BlurTargetView>
  );
}

/** `dimezisBlurViewSdk31Plus` draws nothing before Android 12 (API 31); the older blur is too slow over a moving map. */
export const ANDROID_BLURS = Platform.OS === "android" && Number(Platform.Version) >= 31;

/** expo-blur's Android radius is intensity / this, in pixels (2026-10-14, judged on the emulator). */
const ANDROID_BLUR_REDUCTION = 2;

/** Whether a MapBlur actually blurs here: iOS always, Android 12+ inside a BlurTarget. */
function useCanBlur() {
  const target = useContext(BlurTargetContext);
  return Platform.OS !== "android" || (ANDROID_BLURS && target != null);
}

/** Blur of the map underneath, for panels and overlays. Renders nothing where blur isn't available. */
export function MapBlur({ intensity }: { intensity: number }) {
  const dark = useColorScheme() === "dark";
  const target = useContext(BlurTargetContext);
  if (!useCanBlur()) return null;
  return (
    <BlurView
      intensity={intensity}
      tint={dark ? "dark" : "light"}
      style={StyleSheet.absoluteFill}
      blurTarget={target ?? undefined}
      blurMethod="dimezisBlurViewSdk31Plus"
      // expo-blur divides the intensity by 4 on Android by default (35 → a ~9 px radius, ~3 dp, lost under the tint);
      // undivided (35 px) the panel read as nearly opaque. Halved: ~17 px, ~7 dp on a 420 dpi phone.
      blurReductionFactor={ANDROID_BLUR_REDUCTION}
    />
  );
}

/**
 * Frosted-glass background for floating map panels: a blur of the map
 * underneath plus the theme's translucent panel tint. Where the map can't be
 * blurred the tint is dense instead, so text stays readable over busy map
 * detail. Render it as the first child of a panel whose own background is
 * transparent.
 */
export function GlassFill({ radius }: { radius: number }) {
  const palette = usePalette();
  const canBlur = useCanBlur();
  const shape = { borderRadius: radius, borderCurve: "continuous" as const };
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, shape, styles.clip]}>
      <MapBlur intensity={35} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: canBlur ? palette.panel : palette.panelSolid }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
});
