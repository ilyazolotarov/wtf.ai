import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  type CameraRef,
  type PressEvent,
} from "@maplibre/maplibre-react-native";
import type {
  Feature,
  FeatureCollection,
  LineString,
  Point,
  Polygon,
} from "geojson";
import { useEffect, useMemo, useRef, type ComponentProps } from "react";
import { useColorScheme, View, type NativeSyntheticEvent } from "react-native";

import { ANDROID_BLURS } from "@/components/ui/glass-fill";
import { useMapStyle } from "@/config/map";
import { Colors } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { circlePolygon, destinationAtBearing, haversineM, type Coordinate } from "@/nav/geo";
import type { PositionEstimate } from "@/nav/position/types";
import { usePosition } from "@/providers/position-provider";
import { useDevSettings, useRuntime } from "@/providers/runtime-provider";
import type { MapMatchOverlay } from "@/services/navigation/navigator-service";
import type { AlternativeRoute } from "@/services/navigation/route-service";
import { useRoute } from "@/providers/route-provider";
import { COURSE_MIN_SPEED_MPS, mapBearingDeg, type CompassHeading } from "./use-compass-heading";

type CameraMode = "follow" | "follow-heading" | "free";

interface MapSurfaceProps {
  mode: CameraMode;
  /** Frame both the position and the raw (spoofed) GNSS fix. */
  ghostView: boolean;
  /** Walking compass (see `walkingCompass`): beam replaces the course cone and drives heading-up. */
  compass: CompassHeading | null;
  /**
   * Map bearing in follow-heading (see `useHeadingUp`); null: no direction known. Standing, the map keeps the bearing
   * it has; moving, the follow camera instead.
   */
  headingUpRad: number | null;
  onUserInteraction(): void;
  /** Long press: where on the map. */
  onLongPress(at: Coordinate): void;
  /** A dropped pin, before routing to it. */
  pin: Coordinate | null;
  /** Camera lines for the trip log: the mode shown, and in heading-up the bearing asked vs the map's. */
  logCamera?(text: string): void;
  /**
   * The driver puts the car on the map (NAVIGATOR-SPEC §6.2): "position" zooms in on `placeFrom` and reports the
   * map centre as it settles (`onCenter`); "heading" reports taps (`onTap`).
   */
  placing?: "position" | "heading" | null;
  placeFrom?: Coordinate | null;
  onCenter?(at: Coordinate): void;
  onTap?(at: Coordinate): void;
  /**
   * Where the driver put the car, with an arrow the way it faces (null: skipped): `draft` while choosing, else the
   * confirmed one, fainter, kept until the car has driven away from it.
   */
  placedMark?: { at: Coordinate; headingRad: number | null; draft: boolean } | null;
  /** Changes when the route and its alternatives should be framed (they came while the car stood). */
  overview?: number | null;
  /** Points from the bottom for MapLibre's attribution button: above the screen's bottom bar, which would cover it. */
  attributionBottom?: number;
}

/** The placed car's arrow: narrow and long enough to read at zoom 18. */
const PLACED_ARROW_HALF_ANGLE_RAD = (14 * Math.PI) / 180;
const PLACED_ARROW_M = 28;

/** Placing the car: close enough to see the yard and the street. */
const PLACE_ZOOM = 18;

/** Heading-up: the map's bearing against the one asked for, this often (sooner when they differ). */
const CAMERA_LOG_EVERY_MS = 15_000;
const CAMERA_LOG_OFF_DEG = 20;

/** The follow camera's ease between position updates. */
const FOLLOW_EASE_MS = 450;
/**
 * Beyond this, the position did not drive there: it snapped (GNSS back after an outage, a reset, a placing).
 * `easeTo` would pan the whole way at follow zoom, and the next update (2 Hz) restarts the ease from wherever
 * the pan reached, so the camera crawls in asymptotically — 10 km took a visible age (2026-10-06).
 * The camera jumps instead. At 140 km/h a car covers 19 m between two positions (2 Hz): 80 m is never driving.
 */
const FOLLOW_JUMP_M = 80;

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

/**
 * The app's own labels: a font stack of the offline style, by the name its glyph folders have (tools/tiles style.py
 * `font_slug`: "Noto Sans Bold" → `noto-sans-bold`). The display name finds no glyphs there and every label is blank.
 */
const LABEL_FONT = ["noto-sans-bold"];

const ROUTE_LAYOUT = { "line-cap": "round", "line-join": "round" } as const;
/** Butt caps keep the dashes crisp (round caps would grow each dash into the next gap). */
const ROUTE_HEAD_LAYOUT = { "line-cap": "butt", "line-join": "round" } as const;

export function MapSurface({
  mode,
  ghostView,
  compass,
  headingUpRad,
  onUserInteraction,
  onLongPress,
  pin,
  logCamera,
  placing = null,
  placeFrom = null,
  onCenter,
  onTap,
  placedMark = null,
  overview = null,
  attributionBottom = 8,
}: MapSurfaceProps) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const palette = Colors[scheme];
  const mapStyle = useMapStyle(scheme);
  const position = usePosition();
  const { route, chooseAlternative } = useRoute();
  const { t } = useT();
  const { showParticles } = useDevSettings();
  const { position: navigator } = useRuntime();
  const cameraRef = useRef<CameraRef | null>(null);
  const ghost =
    position?.trust === "UNTRUSTED" && position.rawGnss
      ? position.rawGnss
      : null;
  const deadReckoning = position != null && position.trust !== "TRUSTED";
  const tint = deadReckoning ? palette.warn.c : palette.accent;
  // Heading-up with no direction known. Standing (none yet: parked on phone GPS, the app just opened): still tilted and
  // close in, the map left at the bearing it has, so the view doesn't drop flat and north while the button says
  // heading-up. Moving without one (the navigator anchored under jamming): the follow camera, north up, flat, so it
  // never looks like a heading-up view pointing the wrong way.
  const noDirection = mode === "follow-heading" && headingUpRad === null;
  const moving = (position?.speedMps ?? 0) > COURSE_MIN_SPEED_MPS;
  const camera = noDirection && moving ? "follow" : mode;
  const follow = camera === "free" ? null : FOLLOW_CAMERA[camera];
  const followBearing =
    camera === "follow-heading" ? (headingUpRad !== null ? mapBearingDeg(headingUpRad) : undefined) : 0;

  useEffect(() => {
    logCamera?.(
      `camera ${mode}${camera !== mode ? ` shown as ${camera}: moving, no direction known` : noDirection ? ": no direction known, the map keeps its bearing" : ""}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, camera, noDirection]);
  const lastCameraLog = useRef(0);
  // Both put the map flat and north up (the GNSS ghost framed; placing the car).
  const loggedViews = useRef({ ghostView, placing });
  useEffect(() => {
    const was = loggedViews.current;
    if (ghostView !== was.ghostView) logCamera?.(`camera ghost view ${ghostView ? "on" : "off"}`);
    if (placing !== was.placing) logCamera?.(`camera placing ${placing ?? "off"}`);
    loggedViews.current = { ghostView, placing };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghostView, placing]);

  // Placing starts at the dot, the pin or the search result it came from (or wherever the map was), flat and north
  // up, close in.
  useEffect(() => {
    if (placing !== "position") return;
    void cameraRef.current?.setStop({
      ...(placeFrom ? { center: [placeFrom.lon, placeFrom.lat] as [number, number] } : {}),
      zoom: PLACE_ZOOM,
      pitch: 0,
      bearing: 0,
      duration: 500,
      easing: "ease",
    });
    // Once per placing (`placeFrom` is set when it starts), not on every position update.
  }, [placing, placeFrom]);

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

  // Where the follow camera was last sent; cleared when it stops following, so coming back
  // to follow still eases in from wherever the map was left.
  const followCenter = useRef<Coordinate | null>(null);
  useEffect(() => {
    if (!position || !follow || ghostView) {
      followCenter.current = null;
      return;
    }
    const was = followCenter.current;
    const snapped = was !== null && haversineM(was, position) > FOLLOW_JUMP_M;
    followCenter.current = { lat: position.lat, lon: position.lon };
    const stop = {
      center: [position.lon, position.lat] as [number, number],
      zoom: follow.zoom,
      ...(followBearing !== undefined ? { bearing: followBearing } : {}),
      pitch: follow.pitch,
    };
    if (snapped) cameraRef.current?.jumpTo(stop);
    else cameraRef.current?.easeTo({ ...stop, duration: FOLLOW_EASE_MS });
  }, [follow, position, ghostView, followBearing]);

  // The route and its alternatives at once (ROUTING-SPEC §8.7), north up: framed once when asked.
  useEffect(() => {
    if (overview == null || !route?.plan) return;
    const all = [route.plan, ...(route.alternatives ?? []).map((a) => a.plan)].flatMap((p) => p.coordinates);
    if (all.length < 2) return;
    const lons = all.map((c) => c.lon);
    const lats = all.map((c) => c.lat);
    cameraRef.current?.fitBounds([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)], {
      padding: { top: 300, bottom: 260, left: 60, right: 60 },
      bearing: 0,
      pitch: 0,
      duration: 900,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview]);

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
    event: NativeSyntheticEvent<{ pitch: number; zoom?: number; bearing?: number; center?: [number, number] }>,
  ) => {
    const { bearing, center } = event.nativeEvent;
    if (placing === "position" && center) onCenter?.({ lat: center[1], lon: center[0] });
    if (logCamera && camera === "follow-heading" && bearing !== undefined && followBearing !== undefined) {
      const off = Math.abs(((bearing - followBearing + 540) % 360) - 180);
      // Tilt too: a flat heading-up view with the right bearing looks north-up and leaves no other trace.
      const { pitch, zoom } = event.nativeEvent;
      const flat = follow && Math.abs(pitch - follow.pitch) > 10;
      const now = Date.now();
      if (now - lastCameraLog.current >= (off > CAMERA_LOG_OFF_DEG || flat ? 3000 : CAMERA_LOG_EVERY_MS)) {
        lastCameraLog.current = now;
        logCamera(
          `camera heading-up: map bearing ${Math.round(bearing)}°, asked ${Math.round(followBearing)}°; tilt ${Math.round(pitch)}°` +
            `${zoom !== undefined ? `, zoom ${zoom.toFixed(1)}` : ""}${ghostView ? ", ghost view" : ""}`,
        );
      }
    }
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
  // The route (ROUTING-SPEC §8): only what is ahead of the car, faded while planning again, its next maneuver, the
  // destination; a dropped pin. A long route has thousands of points and the position updates several times a
  // second, so the line from the next vertex on is rebuilt only when a vertex is passed; the stretch from the
  // car's progress to that vertex is a two-point line of its own.
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
  const routeCasing = { "line-color": palette.routeCasing, "line-width": 9, "line-opacity": route?.replanning ? 0.4 : 0.9 };
  const routePaint = { "line-color": palette.route, "line-width": 6, "line-opacity": route?.replanning ? 0.4 : 1 };
  const routeHeadPaint = {
    "line-color": palette.accent,
    "line-width": 5,
    "line-dasharray": [1.5, 1],
    "line-opacity": route?.replanning ? 0.4 : 1,
  };
  const nextManeuver =
    route?.maneuvers && route.guidance && route.guidance.state !== "arrived"
      ? route.maneuvers[route.guidance.nextIndex]
      : undefined;
  const maneuverPoint = nextManeuver && nextManeuver.kind !== "arrive" ? pointFeatures(nextManeuver) : emptyPoints();
  const destination = route ? pointFeatures(route.destination) : emptyPoints();
  // Alternatives (ROUTING-SPEC §8.7): fainter lines under the route, each labelled with its time against it; a tap
  // on either follows it.
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
    chooseAlternative(index);
  };
  const pinPoint = pin ? pointFeatures(pin) : emptyPoints();
  const placedPoint = placedMark ? pointFeatures(placedMark.at) : emptyPoints();
  const placedArrow =
    placedMark && placedMark.headingRad !== null
      ? sectorFeatures(placedMark.at, placedMark.headingRad, PLACED_ARROW_HALF_ANGLE_RAD, PLACED_ARROW_M)
      : emptyPolygons();
  const placedOpacity = placedMark?.draft ? 1 : 0.45;

  // No offline region yet (the map-setup screen asks for one): a plain canvas, never online tiles.
  if (mapStyle == null)
    return <View style={{ flex: 1, backgroundColor: palette.bg }} />;

  return (
    <Map
      mapStyle={mapStyle as ComponentProps<typeof Map>["mapStyle"]}
      style={{ flex: 1 }}
      // The panels' blur redraws the views under it, and a GLSurfaceView (the default) isn't part of that drawing:
      // the blur came out empty. A TextureView is, so use it wherever blur runs (Android 12+).
      androidView={ANDROID_BLURS ? "texture" : "surface"}
      attribution
      attributionPosition={{ bottom: attributionBottom, left: 18 }}
      compass={false}
      logo={false}
      scaleBar={false}
      // Two-finger rotation fires during pinch zoom and can't be given a threshold; the map
      // still turns in heading-up mode.
      touchRotate={false}
      onLongPress={(event: NativeSyntheticEvent<PressEvent>) => {
        if (placing) return;
        const [lon, lat] = event.nativeEvent.lngLat;
        onLongPress({ lat, lon });
      }}
      onPress={(event: NativeSyntheticEvent<PressEvent>) => {
        if (placing !== "heading") return;
        const [lon, lat] = event.nativeEvent.lngLat;
        onTap?.({ lat, lon });
      }}
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
      <GeoJSONSource id="alternative-routes" data={alternativeLines} onPress={pickAlternative}>
        <Layer id="alternative-route-casing" type="line" layout={ROUTE_LAYOUT} paint={{ "line-color": palette.routeCasing, "line-width": 8, "line-opacity": 0.9 }} />
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
          paint={{ "circle-radius": 8, "circle-color": palette.route, "circle-stroke-color": palette.routeCasing, "circle-stroke-width": 3 }}
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
      <GeoJSONSource id="dropped-pin" data={pinPoint}>
        <Layer
          id="dropped-pin-halo"
          type="circle"
          paint={{ "circle-radius": 16, "circle-color": palette.accent, "circle-opacity": 0.18 }}
        />
        <Layer
          id="dropped-pin-dot"
          type="circle"
          paint={{ "circle-radius": 7, "circle-color": palette.accent, "circle-stroke-color": palette.bg, "circle-stroke-width": 3 }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="placed-arrow" data={placedArrow}>
        <Layer
          id="placed-arrow-fill"
          type="fill"
          paint={{ "fill-color": palette.accent, "fill-opacity": 0.55 * placedOpacity }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="placed-point" data={placedPoint}>
        <Layer
          id="placed-point-dot"
          type="circle"
          paint={{
            "circle-radius": 7,
            "circle-color": palette.accent,
            "circle-opacity": placedOpacity,
            "circle-stroke-color": palette.bg,
            "circle-stroke-width": 3,
            "circle-stroke-opacity": placedOpacity,
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
  position: { lat: number; lon: number },
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
  if (coordinates.length < 2) return emptyLines();
  const feature: Feature<LineString> = {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates },
  };
  return { type: "FeatureCollection", features: [feature] };
}

function alternativeLineFeatures(alternatives: AlternativeRoute[] | undefined): FeatureCollection<LineString> {
  return {
    type: "FeatureCollection",
    features: (alternatives ?? []).map((a, index) => ({
      type: "Feature",
      properties: { index },
      geometry: { type: "LineString", coordinates: a.plan.coordinates.map((c) => [c.lon, c.lat]) },
    })),
  };
}

function alternativeLabelFeatures(alternatives: AlternativeRoute[] | undefined, label: (deltaS: number) => string): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: (alternatives ?? []).map((a, index) => ({
      type: "Feature",
      properties: { index, label: label(a.deltaS) },
      geometry: { type: "Point", coordinates: [a.labelAt.lon, a.labelAt.lat] },
    })),
  };
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
