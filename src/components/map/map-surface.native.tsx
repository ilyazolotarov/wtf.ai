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
import { circlePolygon, destinationAtBearing } from "@/nav/geo";
import type { PositionEstimate } from "@/nav/position/types";
import { usePosition } from "@/providers/position-provider";
import { useRoute } from "@/providers/route-provider";

type CameraMode = "follow" | "follow-heading" | "free";

interface MapSurfaceProps {
  mode: CameraMode;
  onUserInteraction(): void;
  onLongPress(): void;
}

export function MapSurface({
  mode,
  onUserInteraction,
  onLongPress,
}: MapSurfaceProps) {
  const scheme = useColorScheme();
  const position = usePosition();
  const { activeRoute } = useRoute();
  const cameraRef = useRef<CameraRef | null>(null);

  useEffect(() => {
    if (!position || mode === "free") return;
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
  }, [mode, position]);

  const handleRegionChange = (
    event: NativeSyntheticEvent<{ userInteraction?: boolean }>,
  ) => {
    if (event.nativeEvent.userInteraction) onUserInteraction();
  };
  const accuracy = position ? accuracyFeatures(position) : emptyPolygons();
  const puck = position ? puckFeatures(position) : emptyPoints();
  const route = activeRoute
    ? routeFeatures(activeRoute.coordinates)
    : emptyLines();

  return (
    <Map
      mapStyle={getMapStyle(scheme === "dark" ? "dark" : "light")}
      style={{ flex: 1 }}
      attribution
      compass
      compassPosition={{ top: 18, right: 16 }}
      logo
      logoPosition={{ bottom: 12, left: 12 }}
      scaleBar={false}
      onLongPress={onLongPress}
      onRegionIsChanging={handleRegionChange}
    >
      <Camera
        ref={cameraRef}
        initialViewState={{
          center: [30.5234, 50.4501],
          zoom: 12,
          pitch: 0,
          bearing: 0,
        }}
      />
      <GeoJSONSource id="position-accuracy" data={accuracy}>
        <Layer
          id="position-accuracy-fill"
          type="fill"
          paint={{ "fill-color": "#1676D2", "fill-opacity": 0.17 }}
        />
        <Layer
          id="position-accuracy-outline"
          type="line"
          paint={{
            "line-color": "#1676D2",
            "line-width": 1.5,
            "line-opacity": 0.45,
          }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="position-puck" data={puck}>
        <Layer
          id="position-heading"
          type="line"
          filter={["==", ["geometry-type"], "LineString"]}
          layout={{ "line-cap": "round" }}
          paint={{ "line-color": "#175F99", "line-width": 4 }}
        />
        <Layer
          id="position-dot"
          type="circle"
          filter={["==", ["geometry-type"], "Point"]}
          paint={{
            "circle-radius": 8,
            "circle-color": "#1676D2",
            "circle-stroke-color": "#FFFFFF",
            "circle-stroke-width": 3,
          }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="active-route" data={route}>
        <Layer
          id="active-route-line"
          type="line"
          paint={{
            "line-color": "#176FA9",
            "line-width": 4,
            "line-dasharray": [2, 1.5],
            "line-opacity": 0.9,
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

function puckFeatures(
  position: PositionEstimate,
): FeatureCollection<Point | LineString> {
  const point: Feature<Point> = {
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [position.lon, position.lat] },
  };
  const features: Feature<Point | LineString>[] = [point];
  if (position.headingRad != null) {
    const direction = destinationAtBearing(position, position.headingRad, 20);
    features.push({
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [position.lon, position.lat],
          [direction.lon, direction.lat],
        ],
      },
    });
  }
  return { type: "FeatureCollection", features };
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

function emptyPoints(): FeatureCollection<Point | LineString> {
  return { type: "FeatureCollection", features: [] };
}

function emptyLines(): FeatureCollection<LineString> {
  return { type: "FeatureCollection", features: [] };
}
