import { StyleSheet } from "react-native";
import Svg, { Circle, G, Path } from "react-native-svg";

import { usePalette } from "@/constants/theme";

import { PUCK } from "./puck-style";

/** A teardrop whose point is the placed spot (0, 0), its head a circle of 16 round (0, -32). */
const PATH = "M0 0 C -4 -10 -16 -20 -16 -32 a16 16 0 1 1 32 0 C 16 -20 4 -10 0 0 Z";
const RING = 2.5;
const POINT_R = 3;
/** Room round the shape for its outline and edge. */
const PAD = RING / 2 + PUCK.edge + 1;
const BOX = { x: -16 - PAD, y: -48 - PAD, w: 32 + 2 * PAD, h: 48 + POINT_R + 2 * PAD };

/**
 * The pin that puts the car on the map (NAVIGATOR-SPEC §6.2), its point the spot placed. Banded as the car's dot
 * (puck-style.ts): a white outline, and a dark edge outside it that holds it off the yellow road the car stands on.
 * SVG strokes straddle the path, so the edge's is wider by both sides. Inside an `<Svg>`, at (0, 0) of its group.
 */
export function PlacingPinShape() {
  const palette = usePalette();
  return (
    <G strokeLinejoin="round">
      <Path d={PATH} fill="none" stroke={palette.puckEdge} strokeWidth={RING + 2 * PUCK.edge} />
      <Path d={PATH} fill={palette.accent} stroke={palette.puckRing} strokeWidth={RING} />
      <Circle cx={0} cy={-32} r={6} fill={palette.puckRing} />
      <Circle cx={0} cy={0} r={POINT_R + RING / 2 + PUCK.edge} fill={palette.puckEdge} />
      <Circle cx={0} cy={0} r={POINT_R} fill={palette.accent} stroke={palette.puckRing} strokeWidth={RING} />
    </G>
  );
}

/** The pin on its own, its point at the centre of the view it is placed in (the map screen's centre). */
export function PlacingPin() {
  return (
    <Svg
      pointerEvents="none"
      width={BOX.w}
      height={BOX.h}
      viewBox={`${BOX.x} ${BOX.y} ${BOX.w} ${BOX.h}`}
      style={[styles.pin, { marginLeft: BOX.x, marginTop: BOX.y }]}
    >
      <PlacingPinShape />
    </Svg>
  );
}

const styles = StyleSheet.create({
  pin: { position: "absolute", left: "50%", top: "50%" },
});
