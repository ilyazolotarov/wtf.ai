import * as Location from "expo-location";
import { useEffect, useState, type PropsWithChildren } from "react";
import { StyleSheet, useColorScheme, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";

import { CAR_COLOR, FALLBACK_PALETTE, type MapColors } from "@/components/guide/map-colors";
import { CONE, CONE_FILL_OPACITY, CONE_OUTLINE, DESTINATION_DOT, PIN_DOT, PUCK, PUCK_OUTER } from "@/components/map/puck-style";
import { GlassFill } from "@/components/ui/glass-fill";
import { T } from "@/components/ui/text";
import { useMapPalette } from "@/config/map";
import { Radius, usePalette, type StatusColor } from "@/constants/theme";

export type { MapColors };

/** The lesson maps in the colours the real map draws in now (its active style, light or Night Drive). */
export function useMapColors(): MapColors {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const palette = useMapPalette(scheme) ?? FALLBACK_PALETTE[scheme];
  return { ...palette, car: CAR_COLOR[scheme] };
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
          <Rect key={`b${i}`} x={b.x} y={b.y} width={b.w} height={b.h} rx={3} fill={c.building} />
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

/** A route as the map draws it (map-layers.tsx): the route colour over its casing, which sets it off the roads. */
export function RouteLine({ d }: { d: string }) {
  const palette = usePalette();
  return (
    <G fill="none" strokeLinecap="round" strokeLinejoin="round">
      <Path d={d} stroke={palette.routeCasing} strokeOpacity={0.9} strokeWidth={9} />
      <Path d={d} stroke={palette.route} strokeWidth={6} />
    </G>
  );
}


/**
 * The car's dot as the map draws it (map-layers.tsx, puck-style.ts): blue while GPS is trusted; otherwise yellow, a light
 * centre and a dashed circle; a thin dark edge round both. `headingDeg` (clockwise from up) draws the cone.
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
  const coneOutline = CONE_OUTLINE[useColorScheme() === "dark" ? "dark" : "light"];
  const tint = trusted ? palette.puck : palette.puckDoubt;
  let cone: string | null = null;
  if (headingDeg != null) {
    const h = (headingDeg * Math.PI) / 180;
    // The map's cone (puck-style.ts): a lesson map unit is about a point on screen.
    const point = (a: number) => `${x + CONE.r * Math.sin(a)} ${y - CONE.r * Math.cos(a)}`;
    cone = `M${x} ${y} L${point(h - CONE.halfAngleRad)} A${CONE.r} ${CONE.r} 0 0 1 ${point(h + CONE.halfAngleRad)} Z`;
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
      {cone && (
        <G strokeLinejoin="round">
          <Path d={cone} fill={tint} fillOpacity={CONE_FILL_OPACITY} stroke={palette.puckEdge} strokeWidth={coneOutline.edge} />
          {coneOutline.ring > 0 && <Path d={cone} fill="none" stroke={trusted ? palette.puckRing : palette.puckDoubt} strokeWidth={coneOutline.ring} />}
        </G>
      )}
      <Circle cx={x} cy={y + 2} r={PUCK_OUTER} fill="#000000" fillOpacity={0.12} />
      <Circle cx={x} cy={y} r={PUCK_OUTER} fill={palette.puckEdge} />
      {/* An SVG stroke straddles its circle: radius to the ring's middle, as MapLibre's stroke outside the fill. */}
      <Circle
        cx={x}
        cy={y}
        r={PUCK.r + PUCK.ring / 2}
        fill={trusted ? palette.puck : palette.bg}
        stroke={trusted ? palette.puckRing : palette.puckDoubt}
        strokeWidth={PUCK.ring}
      />
    </G>
  );
}

/**
 * A dropped pin as the map draws it (map-layers.tsx): a dot banded as the car's, in a faint halo; once a route goes
 * there (`destination`), the route's destination dot. SVG strokes straddle their circle: radius to the ring's middle.
 */
export function PinDot({ x, y, destination = false }: { x: number; y: number; destination?: boolean }) {
  const palette = usePalette();
  if (destination) {
    return (
      <Circle
        cx={x}
        cy={y}
        r={DESTINATION_DOT.r + DESTINATION_DOT.ring / 2}
        fill={palette.route}
        stroke={palette.routeCasing}
        strokeWidth={DESTINATION_DOT.ring}
      />
    );
  }
  return (
    <G>
      <Circle cx={x} cy={y} r={PIN_DOT.halo} fill={palette.accent} fillOpacity={0.18} />
      <Circle cx={x} cy={y} r={PIN_DOT.r + PIN_DOT.ring + PUCK.edge} fill={palette.puckEdge} />
      <Circle cx={x} cy={y} r={PIN_DOT.r + PIN_DOT.ring / 2} fill={palette.accent} stroke={palette.puckRing} strokeWidth={PIN_DOT.ring} />
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
      <T w={accent ? "semibold" : "medium"} size={12} color={accent ? palette.accent : palette.text2} style={styles.chipText}>
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
  // Wraps rather than running off the map (the Ukrainian "since trusted" line is long).
  chip: {
    position: "absolute",
    minHeight: 30,
    maxWidth: "94%",
    borderRadius: 15,
    paddingHorizontal: 12,
    paddingVertical: 6,
    justifyContent: "center",
  },
  chipText: { lineHeight: 16 },
});
