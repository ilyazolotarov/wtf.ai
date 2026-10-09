import type { PropsWithChildren } from "react";
import { StyleSheet, useColorScheme, View } from "react-native";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";

import { T } from "@/components/ui/text";
import { Radius, usePalette, type StatusColor } from "@/constants/theme";

/** Map colours of the lessons' drawn maps, close to the Liberty style the real map uses. */
const MAP_COLORS = {
  light: {
    land: "#F2EFE9",
    block: "#E6E1D8",
    park: "#D5E8C8",
    water: "#BFD9EC",
    minorCasing: "#DCD5C8",
    minor: "#FFFFFF",
    majorCasing: "#E3C77E",
    major: "#F8DFA0",
    car: "#1D1C1A",
  },
  dark: {
    land: "#1E1D1B",
    block: "#2A2926",
    park: "#23301F",
    water: "#1F2E3A",
    minorCasing: "#2F2E2B",
    minor: "#3D3B37",
    majorCasing: "#5A4A26",
    major: "#6E5A2E",
    car: "#F2F0EC",
  },
} as const;

export type MapColors = (typeof MAP_COLORS)["light" | "dark"];

export function useMapColors(): MapColors {
  return MAP_COLORS[useColorScheme() === "dark" ? "dark" : "light"];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A drawn street map, `width`×`height` in its own units, scaled to fill the frame (cropped, never stretched).
 * `minor` and `major` are SVG paths of the streets; `children` draw on top (route, puck, markers).
 */
export function MiniMap({
  width,
  height,
  blocks = [],
  parks = [],
  minor,
  major,
  children,
  overlay,
}: PropsWithChildren<{
  width: number;
  height: number;
  blocks?: Box[];
  parks?: Box[];
  minor?: string;
  major?: string;
  /** Views over the map (status pill, cards), laid out in the frame's own points. */
  overlay?: React.ReactNode;
}>) {
  const c = useMapColors();
  return (
    <View style={[styles.frame, { aspectRatio: width / height, backgroundColor: c.land }]}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid slice">
        <Rect width={width} height={height} fill={c.land} />
        {parks.map((b, i) => (
          <Rect key={`p${i}`} x={b.x} y={b.y} width={b.w} height={b.h} rx={5} fill={c.park} />
        ))}
        {blocks.map((b, i) => (
          <Rect key={`b${i}`} x={b.x} y={b.y} width={b.w} height={b.h} rx={3} fill={c.block} />
        ))}
        <G fill="none" strokeLinecap="round">
          {minor && <Path d={minor} stroke={c.minorCasing} strokeWidth={13} />}
          {minor && <Path d={minor} stroke={c.minor} strokeWidth={10} />}
          {major && <Path d={major} stroke={c.majorCasing} strokeWidth={17} />}
          {major && <Path d={major} stroke={c.major} strokeWidth={13} />}
        </G>
        {children}
      </Svg>
      {overlay}
    </View>
  );
}

/** The car's dot with its uncertainty circle, as the map draws it. */
export function Puck({ x, y, r }: { x: number; y: number; r: number }) {
  const palette = usePalette();
  return (
    <G>
      <Circle cx={x} cy={y} r={r} fill={`${palette.accent}24`} stroke={`${palette.accent}73`} strokeWidth={1.5} />
      <Circle cx={x} cy={y} r={8} fill={palette.accent} stroke="#FFFFFF" strokeWidth={3} />
    </G>
  );
}

/** A car seen from above, `x`,`y` its centre; faces up unless turned. */
export function CarGlyph({ x, y, rotate = 0, opacity = 1 }: { x: number; y: number; rotate?: number; opacity?: number }) {
  const c = useMapColors();
  return (
    <G opacity={opacity} transform={`translate(${x} ${y}) rotate(${rotate})`}>
      <Rect x={-8} y={-14} width={16} height={28} rx={5} fill={c.car} />
      <Rect x={-5} y={-9} width={10} height={7} rx={2} fill="#9DB4F2" />
    </G>
  );
}

/** The map's status pill, drawn over a lesson map. */
export function StatusPillMock({ color, label, sub }: { color: StatusColor; label: string; sub: string }) {
  const palette = usePalette();
  return (
    <View style={[styles.pill, { backgroundColor: palette.panelSolid }]}>
      <View style={[styles.halo, { backgroundColor: color.a }]}>
        <View style={[styles.haloDot, { backgroundColor: color.c }]} />
      </View>
      <View>
        <T w="semibold" size={14} numberOfLines={1}>
          {label}
        </T>
        <T size={11} color={palette.text2} numberOfLines={1}>
          {sub}
        </T>
      </View>
    </View>
  );
}

/** A small chip over a lesson map ("Trusted GPS 4 min ago, 2.3 km back"). */
export function MapChip({ text, accent, style }: { text: string; accent?: boolean; style?: object }) {
  const palette = usePalette();
  return (
    <View style={[styles.chip, { backgroundColor: palette.panelSolid }, style]}>
      <T w={accent ? "semibold" : "medium"} size={12} color={accent ? palette.accent : palette.text2} numberOfLines={1}>
        {text}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { width: "100%", borderRadius: Radius.rL, overflow: "hidden", borderCurve: "continuous" },
  pill: {
    position: "absolute",
    left: 10,
    top: 10,
    height: 46,
    borderRadius: Radius.pill,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingLeft: 8,
    paddingRight: 14,
  },
  halo: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  haloDot: { width: 10, height: 10, borderRadius: 5 },
  chip: {
    position: "absolute",
    height: 30,
    borderRadius: Radius.pill,
    paddingHorizontal: 12,
    justifyContent: "center",
  },
});
