import { useEffect, useState } from "react";
import { Animated, StyleSheet, Text } from "react-native";

import { MAP_CREDIT } from "@/config/map";
import { Colors } from "@/constants/theme";

/** How long the credit shows once the map is drawn, then how long it takes to fade (OSMF: at most 5 s). */
const SHOWN_MS = 5000;
const FADE_MS = 600;

export interface CreditAt {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

/**
 * The map data credit (UI-SPEC §6.1) in a corner of the map once it is drawn, faded after 5 s: OSMF's attribution
 * guidelines allow a credit collapsed by itself after five seconds while the licence stays easy to find (Settings →
 * About). Given both `left` and `right`, it is centred between them.
 */
export function MapCredit({ at, scheme, start }: { at: CreditAt; scheme: "light" | "dark"; start: boolean }) {
  const palette = Colors[scheme];
  const [opacity] = useState(() => new Animated.Value(1));
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!start) return;
    const fade = Animated.timing(opacity, { toValue: 0, duration: FADE_MS, delay: SHOWN_MS, useNativeDriver: true });
    fade.start(({ finished }) => finished && setGone(true));
    return () => fade.stop();
  }, [start, opacity]);
  if (gone) return null;
  const centred = at.left != null && at.right != null;
  return (
    <Animated.View pointerEvents="none" style={[styles.at, at, { opacity }, centred && styles.centred]}>
      <Text style={[styles.text, { color: palette.text2, backgroundColor: palette.bg + "CC" }]} maxFontSizeMultiplier={1.3}>
        {MAP_CREDIT}
      </Text>
    </Animated.View>
  );
}

/** About the credit's height at the default font size: for placing its middle level with something. */
export const MAP_CREDIT_HEIGHT = 20;

const styles = StyleSheet.create({
  at: { position: "absolute" },
  centred: { alignItems: "center" },
  text: { fontSize: 11, paddingVertical: 3, paddingHorizontal: 6, borderRadius: 6, overflow: "hidden" },
});
