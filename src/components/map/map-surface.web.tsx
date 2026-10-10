import { StyleSheet, Text, View } from "react-native";

import { MAX_FONT_SCALE } from "@/components/ui/text";
import { useT } from "@/i18n/provider";

export function MapSurface() {
  const { t } = useT();
  return (
    <View style={styles.canvas}>
      <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.label}>{t("unavailable")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#D9E1DD",
  },
  label: { color: "#34494A", fontSize: 15 },
});
