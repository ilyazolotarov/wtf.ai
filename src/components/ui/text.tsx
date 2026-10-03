import { Text, type TextProps } from "react-native";

import { Font, usePalette } from "@/constants/theme";

export type Weight = keyof typeof Font;

/** Onest text with the theme's text color by default. */
export function T({
  w = "regular",
  size = 15,
  color,
  style,
  ...rest
}: TextProps & { w?: Weight; size?: number; color?: string }) {
  const palette = usePalette();
  return (
    <Text
      {...rest}
      style={[
        { fontFamily: Font[w], fontSize: size, color: color ?? palette.text },
        style,
      ]}
    />
  );
}
