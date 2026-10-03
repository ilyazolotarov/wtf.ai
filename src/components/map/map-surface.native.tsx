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
import { useEffect, useRef } from "react";
import { useColorScheme, type NativeSyntheticEvent } from "react-native";

import { getMapStyle } from "@/config/map";
import { Colors } from "@/constants/theme";
import { circlePolygon, destinationAtBearing } from "@/nav/geo";
import type { PositionEstimate } from "@/nav/position/types";
import { usePosition } from "@/providers/position-provider";
import { useRoute } from "@/providers/route-provider";

type CameraMode = "follow" | "follow-heading" | "free";

interface MapSurfaceProps {
  mode: CameraMode;
  /** Frame both the position and the raw (spoofed) GNSS fix. */
  ghostView: boolean;
  onUserInteraction(): void;
  onLongPress(): void;
}

const CONE_RADIUS_M = 45;
const CONE_HALF_ANGLE_RAD = (28 * Math.PI) / 180;

export function MapSurface({
  mode,
  ghostView,
  onUserInteraction,
  onLongPress,
}: MapSurfaceProps) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const palette = Colors[scheme];
  const position = usePosition();
  const { activeRoute } = useRoute();
  const cameraRef = useRef<CameraRef | null>(null);
  const ghost =
    position?.trust === "UNTRUSTED" && position.rawGnss ? position.rawGnss : null;
  const deadReckoning = position != null && position.trust !== "TRUSTED";
  const tint = deadReckoning ? palette.warn.c : palette.accent;

  useEffect(() => {
    if (!position || mode === "free" || ghostView) return;
    const bearing =
      mode === "follow-heading" &&
      (position.speedMps ?? 0) > 2 &&
      position.headingRad != null
        ? (position.headingRad * 180) / Math.PI
        : 0;
    cameraRef.current?.easeTo({
      center: [position.lon, position.lat],
      bearing,
      duration: 450,
    });
  }, [mode, position, ghostView]);

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
        duration: 900,
      },
    );
    // Frame once when the ghost view opens, not on every fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghostView, hasGhost]);

  const handleRegionChange = (
    event: NativeSyntheticEvent<{ userInteraction?: boolean }>,
  ) => {
    if (event.nativeEvent.userInteraction) onUserInteraction();
  };
  const accuracy = position ? accuracyFeatures(position) : emptyPolygons();
  const cone = position ? coneFeatures(position) : emptyPolygons();
  const puck = position ? pointFeatures(position) : emptyPoints();
  const ghostPoint = ghost ? pointFeatures(ghost) : emptyPoints();
  const route = activeRoute
    ? routeFeatures(activeRoute.coordinates)
    : emptyLines();

  return (
    <Map
      mapStyle={getMapStyle(scheme)}
      style={{ flex: 1 }}
      attribution
      attributionPosition={{ bottom: 8, left: 8 }}
      compass={false}
      logo={false}
      scaleBar={false}
      onLongPress={onLongPress}
      onRegionIsChanging={handleRegionChange}
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
          paint={{ "fill-color": tint, "fill-opacity": deadReckoning ? 0.18 : 0.16 }}
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

/** Heading cone: a 56° sector ahead of the puck. */
function coneFeatures(position: PositionEstimate): FeatureCollection<Polygon> {
  if (position.headingRad == null) return emptyPolygons();
  const ring: [number, number][] = [[position.lon, position.lat]];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const bearing =
      position.headingRad - CONE_HALF_ANGLE_RAD + (2 * CONE_HALF_ANGLE_RAD * i) / steps;
    const p = destinationAtBearing(position, bearing, CONE_RADIUS_M);
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

function pointFeatures(point: { lat: number; lon: number }): FeatureCollection<Point> {
  const feature: Feature<Point> = {
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [point.lon, point.lat] },
  };
  return { type: "FeatureCollection", features: [feature] };
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
