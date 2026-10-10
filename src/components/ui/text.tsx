import { createContext, use, type ReactNode } from "react";
import { StyleSheet, Text, useWindowDimensions, type TextProps } from "react-native";

import { Font, usePalette } from "@/constants/theme";

export type Weight = keyof typeof Font;

/**
 * How far the system's text size may grow the app's text (UI-SPEC §4.7): 150 %. Android goes to 200 %, and the map's
 * panels and the pages' cards are laid out for a phone's width; beyond this, text is still larger but the layouts hold.
 */
export const MAX_FONT_SCALE = 1.5;
/**
 * Text fields grow less: Android can't shrink or wrap a field's placeholder and cuts it off ("Пошук адрес і місць"
 * in the route search).
 */
export const INPUT_MAX_FONT_SCALE = 1.25;
/**
 * The map's panels grow less than the pages: over the map the map is what the driver reads, and at 150 % the route
 * banner and the cards covered most of it.
 */
export const MAP_MAX_FONT_SCALE = 1.3;
/** A label that `fit`s shrinks to this share of its size at the least, then cuts off. */
const FIT_MIN_SCALE = 0.5;

/**
 * The Guide's drawn maps are pictures of the screen at a fixed size: their pill, cards and bar grow only this much, so
 * they stay inside the drawing (the lesson's own text, outside it, grows as the pages' does).
 */
export const DRAWING_MAX_FONT_SCALE = 1.15;

const FontScaleCap = createContext(MAX_FONT_SCALE);

/** `T`s inside grow at most this much with the system's text size (the map screen's panels: `MAP_MAX_FONT_SCALE`). */
export function FontScaleLimit({ max, children }: { max: number; children: ReactNode }) {
  return <FontScaleCap value={max}>{children}</FontScaleCap>;
}

/** Text up to this size grows by the system's whole factor; larger text by as many points as this size does. */
const FULL_GROWTH_PT = 18;

/**
 * How much text of `size` grows when the system asks for `scale`: body text by all of it, larger text by the points
 * 18 pt text gains (a 30 pt title by 1.3× at 150 %), as Android's own nonlinear scaling does, so a heading already
 * readable leaves the room to the rest; a larger style never comes out smaller. A smaller system size shrinks all
 * alike.
 */
export function growth(scale: number, size: number): number {
  if (scale <= 1 || size <= FULL_GROWTH_PT) return scale;
  return 1 + ((scale - 1) * FULL_GROWTH_PT) / size;
}

/**
 * Onest text with the theme's text color by default. `fit`: one line (or `fit` lines) that shrinks to its box
 * (button and chip labels, the status pill) instead of wrapping further or overflowing at a large system text size.
 *
 * It follows the system's text size itself, up to the cap (`maxFontSizeMultiplier`, else `FontScaleLimit`'s): the
 * font and its `lineHeight` alike. Left to the system, Android grows a fixed `lineHeight` by the full text size while
 * the font stops at the cap, and capped text came out double-spaced.
 */
export function T({
  w = "regular",
  size = 15,
  color,
  fit = false,
  maxFontSizeMultiplier,
  style,
  ...rest
}: TextProps & { w?: Weight; size?: number; color?: string; fit?: boolean | number }) {
  const palette = usePalette();
  const { fontScale } = useWindowDimensions();
  const own = StyleSheet.flatten(style);
  const scale = growth(Math.min(fontScale, maxFontSizeMultiplier ?? use(FontScaleCap)), own?.fontSize ?? size);
  return (
    <Text
      allowFontScaling={false}
      {...(fit !== false && {
        numberOfLines: fit === true ? 1 : fit,
        adjustsFontSizeToFit: true,
        minimumFontScale: FIT_MIN_SCALE,
      })}
      {...rest}
      style={[
        { fontFamily: Font[w], color: color ?? palette.text },
        fit !== false && { flexShrink: 1 },
        style,
        {
          fontSize: (own?.fontSize ?? size) * scale,
          lineHeight: own?.lineHeight === undefined ? undefined : own.lineHeight * scale,
        },
      ]}
    />
  );
}
