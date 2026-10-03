import { BlurView } from "expo-blur";
import { StyleSheet, useColorScheme, View } from "react-native";

import { usePalette } from "@/constants/theme";

/**
 * Frosted-glass background for floating map panels: a blur of the map
 * underneath plus the theme's translucent panel tint. Render it as the first
 * child of a panel whose own background is transparent.
 */
export function GlassFill({ radius }: { radius: number }) {
  const palette = usePalette();
  const dark = useColorScheme() === "dark";
  const shape = { borderRadius: radius, borderCurve: "continuous" as const };
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, shape, styles.clip]}>
      <BlurView intensity={60} tint={dark ? "dark" : "light"} style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.panel }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
});
