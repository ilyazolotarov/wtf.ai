import { useIsFocused } from "expo-router";
import { useEffect, useState } from "react";
import { Animated, StyleSheet } from "react-native";

import { MapBlur } from "@/components/ui/glass-fill";

import { useSheetClosing } from "./sheet-closing";

/** Blurs the map and the HUD over it while a sheet (route, vehicle, more…) is open over this screen. */
export function SheetBlur() {
  // Blurred while a sheet is open, and un-blurs as soon as it starts closing.
  const isFocused = useIsFocused();
  const closing = useSheetClosing();
  const focused = isFocused || closing;
  const [opacity] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(opacity, {
      toValue: focused ? 0 : 1,
      duration: 150,
      useNativeDriver: true,
    }).start();
  }, [focused, opacity]);
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity }]}>
      <MapBlur intensity={40} />
    </Animated.View>
  );
}
