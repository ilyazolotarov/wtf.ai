import { Camera, LogManager, Map, type PressEvent, type ViewStateChangeEvent } from "@maplibre/maplibre-react-native";
import { useState, type ComponentProps } from "react";
import { useColorScheme, View, type NativeSyntheticEvent } from "react-native";

import { ANDROID_BLURS } from "@/components/ui/glass-fill";
import { useMapStyle } from "@/config/map";
import { Sentry } from "@/config/sentry";
import { Colors } from "@/constants/theme";
import type { Coordinate } from "@/nav/geo";
import { usePosition } from "@/providers/position-provider";

import { useSmoothedPosition } from "./use-smoothed-position";
import { useRoute } from "@/providers/route-provider";
import { useMapPacks } from "@/services/offline-map/map-packs";

import type { CameraView } from "./map-features";
import { DebugLayers, MarkLayers, PositionLayers, PuckLayers, RouteLayers } from "./map-layers";
import type { CameraMode } from "./use-camera-mode";
import type { CompassHeading } from "./use-compass-heading";
import { useMapCamera } from "./use-map-camera";
import type { PlacingStep } from "./use-placing";

/** The camera's zoom until the map reports one (and the start without a region's bounds). */
const INITIAL_ZOOM = 15.4;

// MapLibre's own errors (a tile it can't read, a style it can't load) reach JS only as console lines, which Sentry
// keeps as logs, not issues. Each kind becomes an issue once per run: a broken pack fails every tile on screen.
const reportedMapErrors = new Set<string>();
LogManager.onLog(({ level, tag, message }) => {
  const kind = `${tag}: ${message.replace(/\d+/g, "#")}`;
  if (level === "error" && !reportedMapErrors.has(kind)) {
    reportedMapErrors.add(kind);
    Sentry.captureMessage(`MapLibre ${tag}: ${message}`, { level: "error", tags: { feature: "map" } });
  }
  return false; // and logged as before
});

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
  placing?: PlacingStep | null;
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
  /**
   * Where MapLibre's attribution button goes, in points from the map's edges: clear of the screen's panels, which
   * would cover it.
   */
  attributionPosition?: { top?: number; bottom?: number; left?: number; right?: number };
}

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
  attributionPosition = { bottom: 8, left: 18 },
}: MapSurfaceProps) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const palette = Colors[scheme];
  const mapStyle = useMapStyle(scheme);
  const { installed } = useMapPacks();
  const region = installed.active ? installed.regions[installed.active] : null;
  const position = usePosition();
  // Drawn and followed smoothly between the navigator's 2 Hz positions (pose-smoother.ts).
  const shown = useSmoothedPosition(position);
  const smoothing = shown !== position;
  const { route, chooseAlternative } = useRoute();
  // Camera commands wait for the style (`useMapCamera`); a new map (after none) waits again.
  const [mapReady, setMapReady] = useState(false);
  if (mapStyle == null && mapReady) setMapReady(false);
  // Heading-up places the dot by the map's own height (turned sideways, it is the screen's width).
  const [mapHeightPt, setMapHeightPt] = useState(0);
  const { cameraRef, onRegionIsChanging, onRegionDidChange } = useMapCamera({
    mapReady,
    mapHeightPt,
    mode,
    // Heading-up turns with the smoothed heading too, unless the walking compass leads.
    headingUpRad: smoothing && !compass && shown?.headingRad != null ? shown.headingRad : headingUpRad,
    position: shown,
    smoothing,
    route,
    ghostView,
    placing,
    placeFrom,
    overview,
    onCenter,
    onUserInteraction,
    logCamera,
  });

  // The camera now, rounded (zoom to 0.1, bearing and tilt to a degree): the heading cone looks the same on screen in
  // every camera (puck-style.ts), and a camera that holds draws nothing again.
  const [view, setView] = useState<CameraView>({ zoom: INITIAL_ZOOM, bearingDeg: 0, pitchDeg: 0 });
  const trackView = (event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
    const { zoom, bearing, pitch } = event.nativeEvent;
    if (![zoom, bearing, pitch].every(Number.isFinite)) return;
    const next = { zoom: Math.round(zoom * 10) / 10, bearingDeg: Math.round(bearing), pitchDeg: Math.round(pitch) };
    setView((was) =>
      was.zoom === next.zoom && was.bearingDeg === next.bearingDeg && was.pitchDeg === next.pitchDeg ? was : next,
    );
  };

  // No offline region yet (the map-setup screen asks for one): a plain canvas, never online tiles.
  if (mapStyle == null)
    return <View style={{ flex: 1, backgroundColor: palette.bg }} />;

  return (
    <Map
      mapStyle={mapStyle as ComponentProps<typeof Map>["mapStyle"]}
      style={{ flex: 1 }}
      onLayout={(event) => setMapHeightPt(Math.round(event.nativeEvent.layout.height))}
      // The panels' blur redraws the views under it, and a GLSurfaceView (the default) isn't part of that drawing:
      // the blur came out empty. A TextureView is, so use it wherever blur runs (Android 12+).
      androidView={ANDROID_BLURS ? "texture" : "surface"}
      attribution
      attributionPosition={attributionPosition as ComponentProps<typeof Map>["attributionPosition"]}
      compass={false}
      logo={false}
      scaleBar={false}
      // Two-finger rotation fires during pinch zoom and can't be given a threshold; the map
      // still turns in heading-up mode.
      touchRotate={false}
      // Tilt is the camera's (heading-up's navigator view): a two-finger drag, easily set off by a pinch, tilted the
      // map while placing the car.
      touchPitch={false}
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
      onRegionIsChanging={(event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
        onRegionIsChanging(event);
        trackView(event);
      }}
      onRegionDidChange={(event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
        onRegionDidChange(event);
        trackView(event);
      }}
      onDidFinishLoadingStyle={() => setMapReady(true)}
    >
      {/* Until the first position: the downloaded region, never a place outside it (an empty black map). */}
      <Camera
        ref={cameraRef}
        initialViewState={
          region
            ? { bounds: region.bounds, pitch: 0, bearing: 0 }
            : { zoom: INITIAL_ZOOM, pitch: 0, bearing: 0 }
        }
      />
      {/* Bottom to top: MapLibre stacks layers in the order they are declared. */}
      <RouteLayers route={route} palette={palette} onChoose={chooseAlternative} />
      <MarkLayers pin={pin} placedMark={placedMark} palette={palette} scheme={scheme} />
      <PositionLayers position={shown} compass={compass} palette={palette} scheme={scheme} view={view} />
      <DebugLayers position={position} palette={palette} />
      <PuckLayers position={shown} palette={palette} scheme={scheme} />
    </Map>
  );
}
