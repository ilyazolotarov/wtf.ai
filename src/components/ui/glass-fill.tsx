import { BlurTargetView, BlurView } from "expo-blur";
import { createContext, useContext, useRef, type PropsWithChildren, type RefObject } from "react";
import { Platform, StyleSheet, useColorScheme, View } from "react-native";

import { usePalette } from "@/constants/theme";

/**
 * On Android, a BlurView only blurs what sits inside a BlurTargetView (expo-blur, SDK 57). The map screen wraps the
 * map in one and provides its ref here; without a target (or before Android 12) the panel gets a dense tint instead.
 */
const BlurTargetContext = createContext<RefObject<View | null> | null>(null);

export function BlurTarget({ children }: PropsWithChildren) {
  const ref = useRef<View | null>(null);
  if (Platform.OS !== "android") return <>{children}</>;
  return (
    <BlurTargetContext.Provider value={ref}>
      <BlurTargetView ref={ref} style={StyleSheet.absoluteFill}>
        {children}
      </BlurTargetView>
    </BlurTargetContext.Provider>
  );
}

/** `dimezisBlurViewSdk31Plus` draws nothing before Android 12 (API 31); the older blur is too slow over a moving map. */
export const ANDROID_BLURS = Platform.OS === "android" && Number(Platform.Version) >= 31;

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
