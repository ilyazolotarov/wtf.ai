import { StyleSheet, View } from "react-native";

import { T } from "@/components/ui/text";
import { Colors, usePalette } from "@/constants/theme";

/**
 * The speed limit as the road sign drivers know (UI-SPEC §6.4): a white disc in a red ring, the number in black. A sign
 * keeps its size whatever the text size: it is read by its shape, and the speed beside it grows. `scheme`: the car's
 * day or night on its screen, not the phone's.
 */
export function SpeedLimitSign({ kph, size = 44, scheme }: { kph: number; size?: number; scheme?: "light" | "dark" }) {
  const phone = usePalette();
  const palette = scheme ? Colors[scheme] : phone;
  const ring = Math.round(size * 0.11);
  return (
    <View
      style={[
        styles.disc,
        { width: size, height: size, borderRadius: size / 2, borderWidth: ring, borderColor: palette.signRing, backgroundColor: palette.signFill },
      ]}
    >
      <T
        w="bold"
        size={Math.round(size * (kph >= 100 ? 0.34 : 0.41))}
        color={palette.signText}
        maxFontSizeMultiplier={1}
        style={styles.number}
      >
        {kph}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  disc: { alignItems: "center", justifyContent: "center" },
  number: { letterSpacing: -0.6, fontVariant: ["tabular-nums"] },
});
