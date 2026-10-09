import * as Location from "expo-location";
import { useEffect, useState, type PropsWithChildren } from "react";
import { StyleSheet, useColorScheme, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";

import { GlassFill } from "@/components/ui/glass-fill";
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
  onLayout,
}: PropsWithChildren<{
  width: number;
  height: number;
  blocks?: Box[];
  parks?: Box[];
  minor?: string;
  major?: string;
  /** Views over the map (status pill, cards), laid out in the frame's own points. */
  overlay?: React.ReactNode;
  /** The frame's size: points per map unit is its width / `width`. */
  onLayout?: (event: LayoutChangeEvent) => void;
}>) {
  const c = useMapColors();
  return (
    <View style={[styles.frame, { aspectRatio: width / height, backgroundColor: c.land }]} onLayout={onLayout}>
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

/** The map's course cone: 28° each side (map-surface.native.tsx), in map units. */
const CONE_HALF_RAD = (28 * Math.PI) / 180;
const CONE_R = 34;

/**
 * The car's dot as the map draws it (map-surface.native.tsx): blue while GPS is trusted; otherwise yellow, a light
 * centre and a dashed circle. `headingDeg` (clockwise from up) draws the cone.
 */
export function Puck({
  x,
  y,
  r,
  trusted = true,
  headingDeg,
}: {
  x: number;
  y: number;
  r: number;
  trusted?: boolean;
  headingDeg?: number | null;
}) {
  const palette = usePalette();
  const tint = trusted ? palette.accent : palette.warn.c;
  let cone: string | null = null;
  if (headingDeg != null) {
    const h = (headingDeg * Math.PI) / 180;
    const point = (a: number) => `${x + CONE_R * Math.sin(a)} ${y - CONE_R * Math.cos(a)}`;
    cone = `M${x} ${y} L${point(h - CONE_HALF_RAD)} A${CONE_R} ${CONE_R} 0 0 1 ${point(h + CONE_HALF_RAD)} Z`;
  }
  return (
    <G>
      <Circle
        cx={x}
        cy={y}
        r={Math.max(r, 4)}
        fill={tint}
        fillOpacity={trusted ? 0.16 : 0.18}
        stroke={tint}
        strokeWidth={trusted ? 1 : 1.5}
        strokeDasharray={trusted ? undefined : "3 2"}
      />
      {cone && <Path d={cone} fill={tint} fillOpacity={0.28} />}
      <Circle cx={x} cy={y + 2} r={11} fill="#000000" fillOpacity={0.12} />
      <Circle cx={x} cy={y} r={7} fill={trusted ? palette.accent : palette.bg} stroke={trusted ? "#FFFFFF" : palette.warn.c} strokeWidth={4} />
    </G>
  );
}

/** How far turning the phone moves the cone: half the turn, at most this either way. */
const NUDGE_FACTOR = 0.5;
const NUDGE_CAP_DEG = 20;
const NUDGE_STEP_DEG = 1;

/**
 * The car's heading along its road (`baseDeg`, clockwise from up), nudged a little by turning the phone: half of how
 * far it has turned since the lesson opened, capped, so it always points along the road yet answers the hand. Without
 * a compass (or permission) it is just the road's.
 */
export function useNudgedHeading(baseDeg: number): number {
  const [nudge, setNudge] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;
    let reference: number | null = null;
    let last = 0;
    Location.watchHeadingAsync((h) => {
      const deg = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
      if (!(deg >= 0)) return;
      reference ??= deg;
      const turned = ((deg - reference + 540) % 360) - 180;
      const next = Math.max(-NUDGE_CAP_DEG, Math.min(NUDGE_CAP_DEG, turned * NUDGE_FACTOR));
      if (Math.abs(next - last) < NUDGE_STEP_DEG) return;
      last = next;
      setNudge(next);
    })
      .then((sub) => {
        if (cancelled) sub.remove();
        else subscription = sub;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);
  return baseDeg + nudge;
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

/** The map's status pill over a lesson map, drawn as the map screen draws it (index.tsx). */
export function StatusPillMock({
  color,
  label,
  source,
  accuracyM,
  trusted,
}: {
  color: StatusColor;
  label: string;
  source: string;
  accuracyM: number;
  trusted: boolean;
}) {
  const palette = usePalette();
  // As the map: the accuracy in the warning colour when it is rough and GPS isn't trusted.
  const accuracyColor = accuracyM > 25 && !trusted ? palette.warn.c : palette.text;
  return (
    <View style={[styles.pill, { boxShadow: palette.shadow }]}>
      <GlassFill radius={Radius.pill} />
      <View style={[styles.halo, { backgroundColor: color.a }]}>
        <View style={[styles.haloDot, { backgroundColor: color.c }]} />
      </View>
      <View style={styles.pillCopy}>
        <T w="semibold" size={15} numberOfLines={1}>
          {label}
        </T>
        <T size={12} color={palette.text2} numberOfLines={1}>
          {source} ·{" "}
          <T size={12} color={accuracyColor}>
            {`±${Math.round(accuracyM)} m`}
          </T>
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
    right: 10,
    top: 10,
    minHeight: 56,
    borderRadius: Radius.pill,
    borderCurve: "continuous",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingLeft: 12,
    paddingRight: 18,
    paddingVertical: 8,
  },
  halo: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  haloDot: { width: 12, height: 12, borderRadius: 6 },
  pillCopy: { flex: 1, gap: 1 },
  chip: {
    position: "absolute",
    height: 30,
    borderRadius: Radius.pill,
    paddingHorizontal: 12,
    justifyContent: "center",
  },
});
