import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { useMemo } from "react";
import type { NativeSyntheticEvent } from "react-native";

import type { Palette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import type { Coordinate } from "@/nav/geo";
import type { PositionEstimate } from "@/nav/position/types";
import { useDevSettings, useRuntime } from "@/providers/runtime-provider";
import type { RouteSnapshot } from "@/services/navigation/route-service";

import {
  accuracyFeatures,
  alternativeFeatures,
  alternativeLabelFeatures,
  alternativeLineFeatures,
  emptyLines,
  emptyPoints,
  emptyPolygons,
  hypothesisFeatures,
  particleFeatures,
  pointFeatures,
  routeFeatures,
  screenSectorFeatures,
  sectorFeatures,
  type CameraView,
} from "./map-features";
import { CONE, CONE_FILL_OPACITY, CONE_OUTLINE, DESTINATION_DOT, PIN_DOT, PUCK, PUCK_OUTER } from "./puck-style";
import type { CompassHeading } from "./use-compass-heading";

/**
 * The map's own layers, in groups. MapLibre stacks layers in the order they are declared, so `MapSurface` renders
 * the groups bottom to top: route, marks, position, debug, puck.
 */

/** The placed car's arrow: narrow and long enough to read at zoom 18. */
const PLACED_ARROW_HALF_ANGLE_RAD = (14 * Math.PI) / 180;
const PLACED_ARROW_M = 28;


/**
 * The app's own labels: a font stack of the offline style, by the name its glyph folders have (tools/tiles style.py
 * `font_slug`: "Noto Sans Bold" → `noto-sans-bold`). The display name finds no glyphs there and every label is blank.
 */
const LABEL_FONT = ["noto-sans-bold"];

const ROUTE_LAYOUT = { "line-cap": "round", "line-join": "round" } as const;
/** Butt caps keep the dashes crisp (round caps would grow each dash into the next gap). */
const ROUTE_HEAD_LAYOUT = { "line-cap": "butt", "line-join": "round" } as const;

/** Without trusted GPS the position is drawn in amber, its circle dashed. */
function deadReckoning(position: PositionEstimate | null): boolean {
  return position != null && position.trust !== "TRUSTED";
}

/**
 * The route (ROUTING-SPEC §8): only what is ahead of the car, faded while planning again, its next maneuver, the
 * destination. Alternatives (§8.7): fainter lines under it, each labelled with its time against it; a tap on either
 * follows it (`onChoose`).
 */
export function RouteLayers({
  route,
  palette,
  onChoose,
}: {
  route: RouteSnapshot | null;
  palette: Palette;
  onChoose(index: number): void;
}) {
  const { t } = useT();
  // A long route has thousands of points and the position updates several times a second, so the line from the
  // next vertex on is rebuilt only when a vertex is passed; the stretch from the car's progress to that vertex is a
  // two-point line of its own.
  const plan = route?.plan;
  const progress = route?.guidance;
  const aheadFrom = progress ? progress.passedIndex + 1 : 0;
  const routeAhead = useMemo(
    () => (plan ? routeFeatures(plan.coordinates.slice(aheadFrom).map((c) => [c.lon, c.lat])) : emptyLines()),
    [plan, aheadFrom],
  );
  const headTo = plan?.coordinates[aheadFrom];
  const routeHead =
    progress && headTo
      ? routeFeatures([
          [progress.progressAt.lon, progress.progressAt.lat],
          [headTo.lon, headTo.lat],
        ])
      : emptyLines();
  const opacity = route?.replanning ? 0.4 : 1;
  const routeCasing = { "line-color": palette.routeCasing, "line-width": 9, "line-opacity": route?.replanning ? 0.4 : 0.9 };
  const routePaint = { "line-color": palette.route, "line-width": 6, "line-opacity": opacity };
  const routeHeadPaint = {
    "line-color": palette.accent,
    "line-width": 5,
    "line-dasharray": [1.5, 1],
    "line-opacity": opacity,
  };
  const nextManeuver =
    route?.maneuvers && route.guidance && route.guidance.state !== "arrived"
      ? route.maneuvers[route.guidance.nextIndex]
      : undefined;
  const maneuverPoint = nextManeuver && nextManeuver.kind !== "arrive" ? pointFeatures(nextManeuver) : emptyPoints();
  const destination = route ? pointFeatures(route.destination) : emptyPoints();
  const alternativeRoutes = route?.alternatives;
  const alternativeLines = useMemo(() => alternativeLineFeatures(alternativeRoutes), [alternativeRoutes]);
  const alternativeLabels = alternativeLabelFeatures(alternativeRoutes, (deltaS) => {
    const n = Math.round(Math.abs(deltaS) / 60);
    return n === 0 ? t("alternativeSame") : t(deltaS > 0 ? "alternativeSlower" : "alternativeFaster").replace("{n}", String(n));
  });
  const pickAlternative = (event: NativeSyntheticEvent<{ features: GeoJSON.Feature[] }>) => {
    const index = event.nativeEvent.features?.[0]?.properties?.index;
    if (typeof index !== "number") return;
    event.stopPropagation();
    onChoose(index);
  };
  return (
    <>
      <GeoJSONSource id="alternative-routes" data={alternativeLines} onPress={pickAlternative}>
        <Layer id="alternative-route-casing" type="line" layout={ROUTE_LAYOUT} paint={{ "line-color": palette.routeAltCasing, "line-width": 8 }} />
        <Layer id="alternative-route-line" type="line" layout={ROUTE_LAYOUT} paint={{ "line-color": palette.routeAlt, "line-width": 5 }} />
      </GeoJSONSource>
      <GeoJSONSource id="active-route" data={routeAhead}>
        <Layer id="active-route-casing" type="line" layout={ROUTE_LAYOUT} paint={routeCasing} />
        <Layer id="active-route-line" type="line" layout={ROUTE_LAYOUT} paint={routePaint} />
      </GeoJSONSource>
      {/* The stretch the car is on: dashed accent, no casing (a casing reads as a grey or dark bar here). */}
      <GeoJSONSource id="active-route-head" data={routeHead}>
        <Layer id="active-route-head-line" type="line" layout={ROUTE_HEAD_LAYOUT} paint={routeHeadPaint} />
      </GeoJSONSource>
      <GeoJSONSource id="route-next-maneuver" data={maneuverPoint}>
        <Layer
          id="route-next-maneuver-dot"
          type="circle"
          paint={{ "circle-radius": 5, "circle-color": palette.maneuver, "circle-stroke-color": palette.maneuverEdge, "circle-stroke-width": 3 }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="route-destination" data={destination}>
        <Layer
          id="route-destination-dot"
          type="circle"
          paint={{ "circle-radius": DESTINATION_DOT.r, "circle-color": palette.route, "circle-stroke-color": palette.routeCasing, "circle-stroke-width": DESTINATION_DOT.ring }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="alternative-route-labels" data={alternativeLabels} onPress={pickAlternative}>
        <Layer
          id="alternative-route-label"
          type="symbol"
          layout={{
            "text-field": ["get", "label"],
            "text-font": LABEL_FONT,
            "text-size": 14,
            "text-allow-overlap": true,
          }}
          paint={{ "text-color": palette.route, "text-halo-color": palette.bg, "text-halo-width": 3 }}
        />
      </GeoJSONSource>
    </>
  );
}

/**
 * A dropped pin, and where the driver put the car with an arrow the way it faces (null: skipped): full strength
 * while choosing (`draft`), fainter once confirmed.
 */
export function MarkLayers({
  pin,
  placedMark,
  palette,
  scheme,
}: {
  pin: Coordinate | null;
  placedMark: { at: Coordinate; headingRad: number | null; draft: boolean } | null;
  palette: Palette;
  scheme: "light" | "dark";
}) {
  const pinPoint = pin ? pointFeatures(pin) : emptyPoints();
  const placedPoint = placedMark ? pointFeatures(placedMark.at) : emptyPoints();
  const placedArrow =
    placedMark && placedMark.headingRad !== null
      ? sectorFeatures(placedMark.at, placedMark.headingRad, PLACED_ARROW_HALF_ANGLE_RAD, PLACED_ARROW_M)
      : emptyPolygons();
  const placedOpacity = placedMark?.draft ? 1 : 0.45;
  const arrowOutline = CONE_OUTLINE[scheme];
  return (
    <>
      {/* Pins and marks are banded as the car's dot (puck-style.ts): a white ring, a dark edge outside it. */}
      <GeoJSONSource id="dropped-pin" data={pinPoint}>
        <Layer
          id="dropped-pin-halo"
          type="circle"
          paint={{ "circle-radius": PIN_DOT.halo, "circle-color": palette.accent, "circle-opacity": 0.18 }}
        />
        <Layer id="dropped-pin-edge" type="circle" paint={{ "circle-radius": PIN_DOT.r + PIN_DOT.ring + PUCK.edge, "circle-color": palette.puckEdge }} />
        <Layer
          id="dropped-pin-dot"
          type="circle"
          paint={{ "circle-radius": PIN_DOT.r, "circle-color": palette.accent, "circle-stroke-color": palette.puckRing, "circle-stroke-width": PIN_DOT.ring }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="placed-arrow" data={placedArrow}>
        <Layer
          id="placed-arrow-fill"
          type="fill"
          paint={{ "fill-color": palette.accent, "fill-opacity": 0.55 * placedOpacity }}
        />
        {/* Outlined as the heading cone. */}
        <Layer
          id="placed-arrow-edge"
          type="line"
          layout={{ "line-join": "round" }}
          paint={{ "line-color": palette.puckEdge, "line-width": arrowOutline.edge, "line-opacity": placedOpacity }}
        />
        <Layer
          id="placed-arrow-ring"
          type="line"
          layout={{ "line-join": "round" }}
          paint={{ "line-color": palette.puckRing, "line-width": arrowOutline.ring, "line-opacity": placedOpacity }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="placed-point" data={placedPoint}>
        <Layer
          id="placed-point-edge"
          type="circle"
          paint={{ "circle-radius": 7 + 3 + PUCK.edge, "circle-color": palette.puckEdge, "circle-opacity": placedOpacity }}
        />
        <Layer
          id="placed-point-dot"
          type="circle"
          paint={{
            "circle-radius": 7,
            "circle-color": palette.accent,
            "circle-opacity": placedOpacity,
            "circle-stroke-color": palette.puckRing,
            "circle-stroke-width": 3,
            "circle-stroke-opacity": placedOpacity,
          }}
        />
      </GeoJSONSource>
    </>
  );
}

/**
 * Under the puck: its accuracy circle, the heading cone (from the walking compass, `compass`, away from the car), and the raw GNSS
 * fix while it is suspected of spoofing (the ghost).
 */
export function PositionLayers({
  position,
  compass,
  palette,
  scheme,
  view,
}: {
  position: PositionEstimate | null;
  compass: CompassHeading | null;
  palette: Palette;
  scheme: "light" | "dark";
  /** The camera now: the heading cone looks the same on screen in every one (puck-style.ts). */
  view: CameraView;
}) {
  const dr = deadReckoning(position);
  const tint = dr ? palette.puckDoubt : palette.puck;
  const coneOutline = CONE_OUTLINE[scheme];
  const accuracy = position ? accuracyFeatures(position) : emptyPolygons();
  // The heading cone, the same on screen at every zoom and as in the lessons; walking (`compass`), the phone's compass
  // draws it, as wide each side as the compass is unsure.
  const cone =
    position && compass
      ? screenSectorFeatures(position, compass.headingRad, compass.uncertaintyRad, CONE.r, view)
      : position && position.headingRad != null
        ? screenSectorFeatures(position, position.headingRad, CONE.halfAngleRad, CONE.r, view)
        : emptyPolygons();
  const ghost = position?.trust === "UNTRUSTED" && position.rawGnss ? position.rawGnss : null;
  const ghostPoint = ghost ? pointFeatures(ghost) : emptyPoints();
  return (
    <>
      <GeoJSONSource id="position-accuracy" data={accuracy}>
        <Layer
          id="position-accuracy-fill"
          type="fill"
          paint={{
            "fill-color": tint,
            "fill-opacity": dr ? 0.18 : 0.16,
          }}
        />
        <Layer
          id="position-accuracy-outline"
          type="line"
          paint={{
            "line-color": tint,
            "line-width": dr ? 1.5 : 1,
            ...(dr ? { "line-dasharray": [3, 2] } : {}),
          }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="position-cone" data={cone}>
        <Layer
          id="position-cone-fill"
          type="fill"
          paint={{ "fill-color": tint, "fill-opacity": CONE_FILL_OPACITY }}
        />
        {/* Its outline, as the dot's bands (puck-style.ts); the ring line is drawn at width 0 in light, not unmounted,
            so the layers keep their order when the theme changes. */}
        <Layer
          id="position-cone-edge"
          type="line"
          layout={{ "line-join": "round" }}
          paint={{ "line-color": palette.puckEdge, "line-width": coneOutline.edge }}
        />
        <Layer
          id="position-cone-ring"
          type="line"
          layout={{ "line-join": "round" }}
          paint={{ "line-color": dr ? palette.puckDoubt : palette.puckRing, "line-width": coneOutline.ring }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="gnss-ghost" data={ghostPoint}>
        <Layer
          id="gnss-ghost-halo"
          type="circle"
          paint={{
            "circle-radius": 16,
            "circle-color": palette.bad.c,
            "circle-opacity": 0.18,
          }}
        />
        <Layer id="gnss-ghost-edge" type="circle" paint={{ "circle-radius": 6 + 3 + PUCK.edge, "circle-color": palette.puckEdge }} />
        <Layer
          id="gnss-ghost-dot"
          type="circle"
          paint={{
            "circle-radius": 6,
            "circle-color": palette.bad.c,
            "circle-stroke-color": palette.puckRing,
            "circle-stroke-width": 3,
          }}
        />
        <Layer
          id="gnss-ghost-label"
          type="symbol"
          layout={{
            "text-field": "GPS?",
            "text-font": LABEL_FONT,
            "text-size": 11,
            "text-offset": [0, 1.9],
            "text-anchor": "top",
            "text-allow-overlap": true,
          }}
          paint={{
            "text-color": palette.bad.c,
            "text-halo-color": palette.bg,
            "text-halo-width": 2,
          }}
        />
      </GeoJSONSource>
    </>
  );
}

/**
 * Test tools (Developer settings): the filter's particles (heaviest 200, size by weight, amber off-road) and its
 * hypotheses as rings of their spread, labelled with their weight; under a simulated outage, where the withheld GPS
 * says the car is.
 */
export function DebugLayers({ position, palette }: { position: PositionEstimate | null; palette: Palette }) {
  const { showParticles } = useDevSettings();
  const { position: navigator } = useRuntime();
  // Recomputed by the service once per published position.
  const overlay = showParticles && position ? navigator.getMapMatchOverlay() : null;
  const particles = particleFeatures(overlay);
  const hypotheses = hypothesisFeatures(overlay);
  const truth = position?.simulatedOutage?.gnss ? pointFeatures(position.simulatedOutage.gnss) : emptyPoints();
  return (
    <>
      <GeoJSONSource id="map-match-hypotheses" data={hypotheses.rings}>
        <Layer
          id="map-match-hypothesis-ring"
          type="line"
          paint={{ "line-color": palette.text2, "line-width": 1.5, "line-dasharray": [2, 2] }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="map-match-particles" data={particles}>
        <Layer
          id="map-match-particle"
          type="circle"
          paint={{
            "circle-radius": ["interpolate", ["linear"], ["get", "w"], 0, 1.5, 1, 4.5],
            "circle-color": ["case", ["==", ["get", "off"], 1], palette.warn.c, palette.accent],
            "circle-opacity": 0.7,
          }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="map-match-hypothesis-labels" data={hypotheses.labels}>
        <Layer
          id="map-match-hypothesis-label"
          type="symbol"
          layout={{
            "text-field": ["get", "label"],
            "text-font": LABEL_FONT,
            "text-size": 11,
            "text-anchor": "bottom",
            "text-allow-overlap": true,
          }}
          paint={{ "text-color": palette.text, "text-halo-color": palette.bg, "text-halo-width": 2 }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="simulated-outage-gps" data={truth}>
        <Layer
          id="simulated-outage-gps-dot"
          type="circle"
          paint={{
            "circle-radius": 5,
            "circle-color": palette.ok.c,
            "circle-stroke-color": palette.bg,
            "circle-stroke-width": 2,
          }}
        />
        <Layer
          id="simulated-outage-gps-label"
          type="symbol"
          layout={{
            "text-field": "GPS",
            "text-font": LABEL_FONT,
            "text-size": 11,
            "text-offset": [0, 1.2],
            "text-anchor": "top",
            "text-allow-overlap": true,
          }}
          paint={{ "text-color": palette.ok.c, "text-halo-color": palette.bg, "text-halo-width": 2 }}
        />
      </GeoJSONSource>
    </>
  );
}

/** On top: the other roads the car may be on while map matching can't tell (MAPMATCH-SPEC §6.2), then the puck. */
export function PuckLayers({ position, palette }: { position: PositionEstimate | null; palette: Palette }) {
  const dr = deadReckoning(position);
  const alternatives = alternativeFeatures(position?.alternatives ?? []);
  const puck = position ? pointFeatures(position) : emptyPoints();
  return (
    <>
      <GeoJSONSource id="map-match-alternatives" data={alternatives}>
        {/* As the dot in doubt, smaller: an amber ring round a light centre, a dark edge outside it. */}
        <Layer
          id="map-match-alternative-edge"
          type="circle"
          paint={{
            "circle-radius": 6 + 2 + PUCK.edge,
            "circle-color": palette.puckEdge,
            "circle-opacity": ["interpolate", ["linear"], ["get", "weight"], 0, 0.35, 0.5, 0.9],
          }}
        />
        <Layer
          id="map-match-alternative-dot"
          type="circle"
          paint={{
            "circle-radius": 6,
            "circle-color": palette.bg,
            "circle-opacity": ["interpolate", ["linear"], ["get", "weight"], 0, 0.35, 0.5, 0.9],
            "circle-stroke-color": palette.puckDoubt,
            "circle-stroke-width": 2,
            "circle-stroke-opacity": ["interpolate", ["linear"], ["get", "weight"], 0, 0.35, 0.5, 0.9],
          }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="position-puck" data={puck}>
        <Layer
          id="position-shadow"
          type="circle"
          paint={{
            "circle-radius": PUCK_OUTER + 2,
            "circle-color": "#000000",
            "circle-opacity": 0.22,
            "circle-blur": 0.8,
            "circle-translate": [0, 2],
          }}
        />
        {/* The dark edge (puck-style.ts): a disc under the dot, showing past its ring (strokes are drawn outside). */}
        <Layer id="position-edge" type="circle" paint={{ "circle-radius": PUCK_OUTER, "circle-color": palette.puckEdge }} />
        <Layer
          id="position-dot"
          type="circle"
          paint={{
            "circle-radius": PUCK.r,
            "circle-color": dr ? palette.bg : palette.puck,
            "circle-stroke-color": dr ? palette.puckDoubt : palette.puckRing,
            "circle-stroke-width": PUCK.ring,
          }}
        />
      </GeoJSONSource>
    </>
  );
}
