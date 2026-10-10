import type { CameraRef } from "@maplibre/maplibre-react-native";
import { useEffect, useRef } from "react";
import type { NativeSyntheticEvent } from "react-native";

import { haversineM, type Coordinate } from "@/nav/geo";
import type { PositionEstimate } from "@/nav/position/types";
import type { RouteSnapshot } from "@/services/navigation/route-service";

import type { CameraMode } from "./use-camera-mode";
import { COURSE_MIN_SPEED_MPS, mapBearingDeg } from "./use-compass-heading";
import type { PlacingStep } from "./use-placing";

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

/**
 * Camera per follow mode; heading-up gets the navigator tilt. Any gesture drops to free,
 * so these never fight a pinch, and the tilt changes only when the mode does.
 */
const FOLLOW_CAMERA: Record<Exclude<CameraMode, "free">, { zoom: number; pitch: number }> = {
  follow: { zoom: 16, pitch: 0 },
  "follow-heading": { zoom: 17, pitch: 50 },
};
/** Leaving follow by the button steps back to a flat overview. */
const FREE_ZOOM = 15.5;

/** Room for the panels when framing several things at once (the routes, the ghost). */
const FRAME_PADDING = { top: 300, bottom: 260, left: 60, right: 60 };

/**
 * Drives the map camera (UI-SPEC §6.2): follows the position per mode, frames the route's alternatives and the GNSS
 * ghost, zooms in for placing the car, flattens after a gesture leaves a tilted mode, and logs what it shows.
 * Hand `cameraRef` to `<Camera>` and the two region handlers to `<Map>`.
 */
export function useMapCamera({
  mode,
  headingUpRad,
  position,
  route,
  ghostView,
  placing,
  placeFrom,
  overview,
  onCenter,
  onUserInteraction,
  logCamera,
}: {
  mode: CameraMode;
  headingUpRad: number | null;
  position: PositionEstimate | null;
  route: RouteSnapshot | null;
  ghostView: boolean;
  placing: PlacingStep | null;
  placeFrom: Coordinate | null;
  overview: number | null;
  onCenter?(at: Coordinate): void;
  onUserInteraction(): void;
  logCamera?(text: string): void;
}) {
  const cameraRef = useRef<CameraRef | null>(null);
  const ghost = position?.trust === "UNTRUSTED" && position.rawGnss ? position.rawGnss : null;
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
      padding: FRAME_PADDING,
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
        padding: FRAME_PADDING,
        bearing: 0,
        pitch: 0,
        duration: 900,
      },
    );
    // Frame once when the ghost view opens, not on every fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghostView, hasGhost]);

  const onRegionIsChanging = (event: NativeSyntheticEvent<{ userInteraction?: boolean }>) => {
    // Still moving: the gesture hasn't settled yet.
    clearTimeout(flattenTimer.current);
    if (!event.nativeEvent.userInteraction) return;
    if (follow) {
      leftByGesture.current = true;
      flattenFrom.current = follow.pitch > 0 ? follow.pitch : null;
    }
    onUserInteraction();
  };
  const onRegionDidChange = (
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

  return { cameraRef, onRegionIsChanging, onRegionDidChange };
}
