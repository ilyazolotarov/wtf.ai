/**
 * "Calm" design language (claude.ai/design project "wtf.ai Redesign", option 1b):
 * frosted panels, sentence-case status, big light speed numeral, Onest type.
 */

import "@/global.css";

import { Platform, useColorScheme } from "react-native";

export interface StatusColor {
  /** Solid status color. */
  c: string;
  /** Translucent halo / tile background. */
  a: string;
  /** Text on top of `c`. */
  fg: string;
}

const status = (c: string, fg: string): StatusColor => ({ c, a: `${c}2E`, fg });

export const Colors = {
  light: {
    bg: "#F5F4F1",
    sheetBg: "#F5F4F1",
    groupBg: "#FFFFFF",
    surface: "#EDEBE6",
    panel: "rgba(255,255,255,0.35)",
    /** Panel tint where the map behind can't be blurred (Android before 12): dense enough to read on. */
    panelSolid: "rgba(255,255,255,0.86)",
    line: "rgba(0,0,0,0.07)",
    text: "#1D1C1A",
    text2: "#6B675F",
    accent: "#4371B7",
    accentA: "#4371B729",
    onAccent: "#FFFFFF",
    ok: status("#3D865A", "#FFFFFF"),
    warn: status("#BD853F", "#0B0D0E"),
    bad: status("#BC4A3F", "#FFFFFF"),
    idle: { c: "#77736D", a: "rgba(119,115,109,0.18)", fg: "#FFFFFF" } as StatusColor,
    secBg: "#E8E6E0",
    shadow: "0 10px 30px rgba(40,30,10,0.14)",
    cardShadow: "0 12px 40px rgba(0,0,0,0.25)",
    grab: "rgba(0,0,0,0.18)",
    route: "#3F5FBF",
    /** Alternative routes: solid (a translucent route colour over the casing turned muddy on the dark map), quieter. */
    routeAlt: "#93A6DE",
    // Legacy names used by dev-only screens (trips, ELM terminal, device list).
    background: "#F5F4F1",
    backgroundElement: "#FFFFFF",
    backgroundSelected: "#EDEBE6",
    textSecondary: "#6B675F",
  },
  dark: {
    bg: "#121211",
    sheetBg: "#171615",
    groupBg: "#232220",
    surface: "#2C2B29",
    panel: "rgba(30,29,28,0.35)",
    panelSolid: "rgba(30,29,28,0.86)",
    line: "rgba(255,255,255,0.08)",
    text: "#F2F0EC",
    text2: "#A6A29B",
    accent: "#90BAF1",
    accentA: "#90BAF133",
    onAccent: "#0E1220",
    ok: status("#82CB9B", "#0B0D0E"),
    warn: status("#E4B572", "#0B0D0E"),
    bad: status("#ED8C80", "#0B0D0E"),
    idle: { c: "#9C9893", a: "rgba(156,152,147,0.2)", fg: "#0B0D0E" } as StatusColor,
    secBg: "#2C2B29",
    shadow: "0 10px 30px rgba(0,0,0,0.4)",
    cardShadow: "0 12px 40px rgba(0,0,0,0.25)",
    grab: "rgba(255,255,255,0.25)",
    route: "#9DB4F2",
    routeAlt: "#7489C2",
    background: "#121211",
    backgroundElement: "#232220",
    backgroundSelected: "#2C2B29",
    textSecondary: "#A6A29B",
  },
} as const;

export type Palette = (typeof Colors)["light" | "dark"];

export function usePalette(): Palette {
  return Colors[useColorScheme() === "dark" ? "dark" : "light"];
}

/** Onest faces loaded in the root layout; RN needs one family per weight. */
export const Font = {
  light: "Onest_300Light",
  regular: "Onest_400Regular",
  medium: "Onest_500Medium",
  semibold: "Onest_600SemiBold",
  bold: "Onest_700Bold",
} as const;

export const Radius = {
  r: 12,
  rL: 24,
  pill: 999,
} as const;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: "system-ui",
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: "ui-serif",
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: "ui-rounded",
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: "ui-monospace",
  },
  default: {
    sans: "normal",
    serif: "serif",
    rounded: "normal",
    mono: "monospace",
  },
  web: {
    sans: "var(--font-display)",
    serif: "var(--font-serif)",
    rounded: "var(--font-rounded)",
    mono: "var(--font-mono)",
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
