import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  type CameraRef,
} from "@maplibre/maplibre-react-native";
import type {
  Feature,
  FeatureCollection,
  LineString,
  Point,
  Polygon,
} from "geojson";
import { useEffect, useRef, type ComponentProps } from "react";
import { useColorScheme, View, type NativeSyntheticEvent } from "react-native";

import { useMapStyle } from "@/config/map";
import { Colors } from "@/constants/theme";
import { circlePolygon, destinationAtBearing } from "@/nav/geo";
import type { PositionEstimate } from "@/nav/position/types";
import { usePosition } from "@/providers/position-provider";
import { useDevSettings, useRuntime } from "@/providers/runtime-provider";
import type { MapMatchOverlay } from "@/services/navigation/navigator-service";
import { useRoute } from "@/providers/route-provider";
import type { CompassHeading } from "./use-compass-heading";

type CameraMode = "follow" | "follow-heading" | "free";

interface MapSurfaceProps {
  mode: CameraMode;
  /** Frame both the position and the raw (spoofed) GNSS fix. */
  ghostView: boolean;
  /** Walking compass (see `walkingCompass`): beam replaces the course cone and drives heading-up. */
  compass: CompassHeading | null;
  /** Map bearing in follow-heading (see `useHeadingUp`). */
  headingUpRad: number;
  onUserInteraction(): void;
  onLongPress(): void;
}

const CONE_RADIUS_M = 45;
const CONE_HALF_ANGLE_RAD = (28 * Math.PI) / 180;
const BEAM_RADIUS_M = 70;
const BEAM_CORE_RADIUS_M = 40;

/**
 * Camera per follow mode; heading-up gets the navigator tilt. Any gesture drops to free,
 * so these never fight a pinch, and the tilt changes only when the mode does.
 */
const FOLLOW_CAMERA: Record<
  Exclude<CameraMode, "free">,
  { zoom: number; pitch: number }
> = {
  follow: { zoom: 16, pitch: 0 },
  "follow-heading": { zoom: 17, pitch: 50 },
};
/** Leaving follow by the button steps back to a flat overview. */
const FREE_ZOOM = 15.5;

export function MapSurface({
  mode,
  ghostView,
  compass,
  headingUpRad,
  onUserInteraction,
  onLongPress,
}: MapSurfaceProps) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const palette = Colors[scheme];
  const mapStyle = useMapStyle(scheme);
  const position = usePosition();
  const { activeRoute } = useRoute();
  const { showParticles } = useDevSettings();
  const { position: navigator } = useRuntime();
  const cameraRef = useRef<CameraRef | null>(null);
  const ghost =
    position?.trust === "UNTRUSTED" && position.rawGnss
      ? position.rawGnss
      : null;
  const deadReckoning = position != null && position.trust !== "TRUSTED";
  const tint = deadReckoning ? palette.warn.c : palette.accent;
  const follow = mode === "free" ? null : FOLLOW_CAMERA[mode];

  const followBearing =
    mode === "follow-heading" && position
      ? (headingUpRad * 180) / Math.PI
      : 0;

  // A gesture that drops follow keeps the zoom the finger chose; only the button zooms out.
  const leftByGesture = useRef(false);
  // Free is flat, but nothing may animate under the finger: a gesture that leaves a tilted
  // follow mode flattens once the map settles. Holds the pitch that mode had.
  const flattenFrom = useRef<number | null>(null);
  const flattenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flattenTimer.current), []);
  useEffect(() => {
    if (mode !== "free") {
      flattenFrom.current = null;
      clearTimeout(flattenTimer.current);
      return;
    }
    const byGesture = leftByGesture.current;
    leftByGesture.current = false;
    if (byGesture || ghostView) return;
    void cameraRef.current?.setStop({
      zoom: FREE_ZOOM,
      pitch: 0,
      duration: 600,
      easing: "ease",
    });
    // Once per switch to free, not when the ghost view changes later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (!position || !follow || ghostView) return;
    cameraRef.current?.easeTo({
      center: [position.lon, position.lat],
      zoom: follow.zoom,
      bearing: followBearing,
      pitch: follow.pitch,
      duration: 450,
    });
  }, [follow, position, ghostView, followBearing]);

  const hasGhost = ghost != null;
  useEffect(() => {
    if (!ghostView || !position || !ghost) return;
    cameraRef.current?.fitBounds(
      [
        Math.min(position.lon, ghost.lon),
        Math.min(position.lat, ghost.lat),
        Math.max(position.lon, ghost.lon),
        Math.max(position.lat, ghost.lat),
      ],
      {
        padding: { top: 300, bottom: 260, left: 60, right: 60 },
        bearing: 0,
        pitch: 0,
        duration: 900,
      },
    );
    // Frame once when the ghost view opens, not on every fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghostView, hasGhost]);

  const handleRegionChange = (
    event: NativeSyntheticEvent<{ userInteraction?: boolean }>,
  ) => {
    // Still moving: the gesture hasn't settled yet.
    clearTimeout(flattenTimer.current);
    if (!event.nativeEvent.userInteraction) return;
    if (follow) {
      leftByGesture.current = true;
      flattenFrom.current = follow.pitch > 0 ? follow.pitch : null;
    }
    onUserInteraction();
  };
  const handleRegionDidChange = (
    event: NativeSyntheticEvent<{ pitch: number }>,
  ) => {
    const from = flattenFrom.current;
    if (from == null) return;
    const { pitch } = event.nativeEvent;
    // A pan cancelling the follow ease reports did-change at its start, so wait for quiet.
    clearTimeout(flattenTimer.current);
    flattenTimer.current = setTimeout(() => {
      flattenFrom.current = null;
      // A deliberate two-finger tilt sticks.
      if (Math.abs(pitch - from) > 2) return;
      void cameraRef.current?.setStop({ pitch: 0, duration: 300, easing: "ease" });
    }, 80);
  };
  const accuracy = position ? accuracyFeatures(position) : emptyPolygons();
  const cone =
    position && !compass && position.headingRad != null
      ? sectorFeatures(
          position,
          position.headingRad,
          CONE_HALF_ANGLE_RAD,
          CONE_RADIUS_M,
        )
      : emptyPolygons();
  const beam =
    position && compass
      ? sectorFeatures(
          position,
          compass.headingRad,
          compass.uncertaintyRad,
          BEAM_RADIUS_M,
        )
      : emptyPolygons();
  const beamCore =
    position && compass
      ? sectorFeatures(
          position,
          compass.headingRad,
          compass.uncertaintyRad,
          BEAM_CORE_RADIUS_M,
        )
      : emptyPolygons();
  const puck = position ? pointFeatures(position) : emptyPoints();
  const alternatives = alternativeFeatures(position?.alternatives ?? []);
  // Debug overlay: recomputed by the service once per published position.
  const overlay = showParticles && position ? navigator.getMapMatchOverlay() : null;
  const particles = particleFeatures(overlay);
  const hypotheses = hypothesisFeatures(overlay);
  // Simulated outage: where GPS (withheld from the navigator) says the car is.
  const truth = position?.simulatedOutage?.gnss
    ? pointFeatures(position.simulatedOutage.gnss)
    : emptyPoints();
  const ghostPoint = ghost ? pointFeatures(ghost) : emptyPoints();
  const route = activeRoute
    ? routeFeatures(activeRoute.coordinates)
    : emptyLines();

  // Dark style is still being tinted: hold a plain dark canvas instead of flashing light tiles.
  if (mapStyle == null)
    return <View style={{ flex: 1, backgroundColor: palette.bg }} />;

  return (
    <Map
      mapStyle={mapStyle as ComponentProps<typeof Map>["mapStyle"]}
      style={{ flex: 1 }}
      attribution
      attributionPosition={{ bottom: 8, left: 8 }}
      compass={false}
      logo={false}
      scaleBar={false}
      // Two-finger rotation fires during pinch zoom and can't be given a threshold; the map
      // still turns in heading-up mode.
      touchRotate={false}
      onLongPress={onLongPress}
      onRegionIsChanging={handleRegionChange}
      onRegionDidChange={handleRegionDidChange}
    >
      <Camera
        ref={cameraRef}
        initialViewState={{
          center: [30.5234, 50.4501],
          zoom: 15.4,
          pitch: 0,
          bearing: 0,
        }}
      />
      <GeoJSONSource id="active-route" data={route}>
        <Layer
          id="active-route-line"
          type="line"
          layout={{ "line-cap": "round" }}
          paint={{
            "line-color": palette.route,
            "line-width": 4,
            "line-dasharray": [2, 1.5],
          }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="position-accuracy" data={accuracy}>
        <Layer
          id="position-accuracy-fill"
          type="fill"
          paint={{
            "fill-color": tint,
            "fill-opacity": deadReckoning ? 0.18 : 0.16,
          }}
        />
        <Layer
          id="position-accuracy-outline"
          type="line"
          paint={{
            "line-color": tint,
            "line-width": deadReckoning ? 1.5 : 1,
            ...(deadReckoning ? { "line-dasharray": [3, 2] } : {}),
          }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="position-cone" data={cone}>
        <Layer
          id="position-cone-fill"
          type="fill"
          paint={{ "fill-color": tint, "fill-opacity": 0.28 }}
        />
      </GeoJSONSource>
      {/* Two stacked sectors fake a fade-out; wider and fainter than the course cone. */}
      <GeoJSONSource id="compass-beam" data={beam}>
        <Layer
          id="compass-beam-fill"
          type="fill"
          paint={{ "fill-color": tint, "fill-opacity": 0.1 }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="compass-beam-core" data={beamCore}>
        <Layer
          id="compass-beam-core-fill"
          type="fill"
          paint={{ "fill-color": tint, "fill-opacity": 0.14 }}
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
        <Layer
          id="gnss-ghost-dot"
          type="circle"
          paint={{
            "circle-radius": 6,
            "circle-color": palette.bad.c,
            "circle-stroke-color": palette.bg,
            "circle-stroke-width": 3,
          }}
        />
        <Layer
          id="gnss-ghost-label"
          type="symbol"
          layout={{
            "text-field": "GPS?",
            "text-font": ["Noto Sans Bold"],
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
      {/* Debug: the filter's particles (heaviest 200, size by weight, amber off-road) and its
          hypotheses as rings of their spread, labelled with their weight. */}
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
            "text-font": ["Noto Sans Bold"],
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
            "text-font": ["Noto Sans Bold"],
            "text-size": 11,
            "text-offset": [0, 1.2],
            "text-anchor": "top",
            "text-allow-overlap": true,
          }}
          paint={{ "text-color": palette.ok.c, "text-halo-color": palette.bg, "text-halo-width": 2 }}
        />
      </GeoJSONSource>
      {/* Other roads the car may be on while map matching can't tell (MAPMATCH-SPEC §6.2). */}
      <GeoJSONSource id="map-match-alternatives" data={alternatives}>
        <Layer
          id="map-match-alternative-dot"
          type="circle"
          paint={{
            "circle-radius": 6,
            "circle-color": palette.bg,
            "circle-opacity": ["interpolate", ["linear"], ["get", "weight"], 0, 0.35, 0.5, 0.9],
            "circle-stroke-color": palette.warn.c,
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
            "circle-radius": 13,
            "circle-color": "#000000",
            "circle-opacity": 0.22,
            "circle-blur": 0.8,
            "circle-translate": [0, 2],
          }}
        />
        <Layer
          id="position-dot"
          type="circle"
          paint={{
            "circle-radius": 7,
            "circle-color": deadReckoning ? palette.bg : palette.accent,
            "circle-stroke-color": deadReckoning ? palette.warn.c : "#FFFFFF",
            "circle-stroke-width": 4,
          }}
        />
      </GeoJSONSource>
    </Map>
  );
}

function accuracyFeatures(
  position: PositionEstimate,
): FeatureCollection<Polygon> {
  return {
    type: "FeatureCollection",
    features: [circlePolygon(position, Math.max(5, position.accuracyM), 48)],
  };
}

/** Sector ahead of the puck: the course cone or the compass beam. */
function sectorFeatures(
  position: PositionEstimate,
  headingRad: number,
  halfAngleRad: number,
  radiusM: number,
): FeatureCollection<Polygon> {
  const ring: [number, number][] = [[position.lon, position.lat]];
  const steps = Math.max(8, Math.round((halfAngleRad * 180) / Math.PI / 4));
  for (let i = 0; i <= steps; i++) {
    const bearing = headingRad - halfAngleRad + (2 * halfAngleRad * i) / steps;
    const p = destinationAtBearing(position, bearing, radiusM);
    ring.push([p.lon, p.lat]);
  }
  ring.push([position.lon, position.lat]);
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [ring] },
      },
    ],
  };
}

function pointFeatures(point: {
  lat: number;
  lon: number;
}): FeatureCollection<Point> {
  const feature: Feature<Point> = {
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [point.lon, point.lat] },
  };
  return { type: "FeatureCollection", features: [feature] };
}

function alternativeFeatures(
  points: { lat: number; lon: number; weight: number }[],
): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature",
      properties: { weight: p.weight },
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    })),
  };
}

function particleFeatures(overlay: MapMatchOverlay | null): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: (overlay?.particles ?? []).map(([lat, lon, w, off]) => ({
      type: "Feature",
      properties: { w, off },
      geometry: { type: "Point", coordinates: [lon, lat] },
    })),
  };
}

function hypothesisFeatures(overlay: MapMatchOverlay | null): {
  rings: FeatureCollection<Polygon>;
  labels: FeatureCollection<Point>;
} {
  const clusters = overlay?.clusters ?? [];
  return {
    rings: {
      type: "FeatureCollection",
      features: clusters.map((c) => circlePolygon(c, Math.max(3, c.spreadM), 32)),
    },
    labels: {
      type: "FeatureCollection",
      features: clusters.map((c) => ({
        type: "Feature",
        properties: { label: `${Math.round(c.weight * 100)}%` },
        geometry: {
          type: "Point",
          coordinates: (({ lat, lon }) => [lon, lat])(destinationAtBearing(c, 0, Math.max(3, c.spreadM))),
        },
      })),
    },
  };
}

function routeFeatures(
  coordinates: [number, number][],
): FeatureCollection<LineString> {
  const feature: Feature<LineString> = {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates },
  };
  return { type: "FeatureCollection", features: [feature] };
}

function emptyPolygons(): FeatureCollection<Polygon> {
  return { type: "FeatureCollection", features: [] };
}

function emptyPoints(): FeatureCollection<Point> {
  return { type: "FeatureCollection", features: [] };
}

function emptyLines(): FeatureCollection<LineString> {
  return { type: "FeatureCollection", features: [] };
}
