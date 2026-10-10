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
    // Every colour here stands out at 3:1 on everything the map draws under it (map-contrast.test.ts).
    route: "#3D5CBC",
    /**
     * Alternative routes: solid (a translucent route colour over the casing turned muddy on the dark map), quieter. In
     * light the route's inverse, a light line in a dark casing: a light line in a light casing vanished on the map.
     */
    routeAlt: "#B8C7EE",
    routeAltCasing: "#53618A",
    /** The outline of the route and the destination dot. */
    routeCasing: "#F5F4F1",
    /** The next maneuver's dot: fill and ring. */
    maneuver: "#F5F4F1",
    maneuverEdge: "#3D5CBC",
    /**
     * The car's dot while GPS is trusted: brighter and more cyan than the route's indigo, so the line doesn't run into
     * it; its white ring and a thin dark edge keep it apart from yellow roads too (`puck-style.ts`).
     */
    puck: "#0A84FF",
    /** The dot in doubt: its ring (round a light centre), circle and cone; a deeper amber than `warn` for 3:1 inside it. */
    puckDoubt: "#B47D38",
    puckRing: "#FFFFFF",
    // Dark enough for 3:1 even on the route's indigo, where the doubt dot's amber ring alone differs only in hue.
    puckEdge: "rgba(0,0,0,0.9)",
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
    // Night Drive: azure, opposite the map's amber and orange roads and far lighter than its ground and water (~8:1),
    // with a near-black outline where it runs along an amber road; light enough for 3:1 on the grey minor roads.
    route: "#47B2FF",
    // Grey-blue: as light as the route (the minor roads leave no darker line room), quieter by its colour.
    routeAlt: "#93ABC4",
    routeAltCasing: "#001428",
    routeCasing: "#001428",
    maneuver: "#FFFFFF",
    maneuverEdge: "#001428",
    // Periwinkle: apart from the azure route by its hue, and 3:1 inside its white ring; the black edge holds the ring
    // off the amber roads.
    puck: "#6B8CFF",
    puckDoubt: "#E4B572",
    puckRing: "#FFFFFF",
    puckEdge: "#000000",
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
