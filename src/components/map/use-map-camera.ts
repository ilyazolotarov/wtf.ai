import type { CameraRef } from "@maplibre/maplibre-react-native";
import { useEffect, useMemo, useRef } from "react";
import { useWindowDimensions, type NativeSyntheticEvent } from "react-native";

import { haversineM, type Coordinate } from "@/nav/geo";
import type { PositionEstimate } from "@/nav/position/types";
import type { RouteSnapshot } from "@/services/navigation/route-service";

import { fitCircleZoom } from "./map-features";
import { fittedPadding } from "./map-moves";
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
/**
 * Until the car first moves after the app opens, the follow camera zooms out until the position's circle fits: a cell
 * fix's kilometres at zoom 17 tinted the whole screen and didn't read as a circle until zoomed out by hand. Its radius
 * at most this share of the screen's narrower side, so its edge shows between the panels. Driving keeps the follow zoom.
 */
const FIT_CIRCLE_SHARE = 0.35;

/**
 * Heading-up puts the dot this far down the map (top 0, bottom 1), not in the middle: the road ahead fills the screen,
 * not the road behind (a tester's first ask, 2026-10-19). Below the route banner, above the bottom bar: about 0.88 of
 * the map between them, where Google Maps keeps its arrow. North-up stays centred: the road ahead may lie any way.
 */
const HEADING_UP_DOT_AT = 0.8;
/**
 * iOS reports the screen's centre as the map's centre, not the dot's padded one: in heading-up (zoom 17, tilted) the
 * dot is a few hundred metres from it. The settle-back check allows that much more.
 */
const HEADING_UP_CENTRE_OFF_M = 1000;

/** Leaving follow by the button steps back to a flat overview. */
const FREE_ZOOM = 15.5;

interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const NO_INSETS: Insets = { top: 0, bottom: 0, left: 0, right: 0 };

/** Room for the panels when framing several things at once (the routes, the ghost). */
const FRAME_PADDING = { top: 300, bottom: 260, left: 60, right: 60 };

/**
 * Drives the map camera (UI-SPEC §6.2): follows the position per mode, frames the route's alternatives and the GNSS
 * ghost, zooms in for placing the car, flattens after a gesture leaves a tilted mode, and logs what it shows.
 * Hand `cameraRef` to `<Camera>` and the two region handlers to `<Map>`.
 */
/** A camera command sent and let go: MapLibre rejects one whose map view is gone, and none is awaited. */
function send(command: () => unknown): void {
  try {
    void Promise.resolve(command()).catch(() => {});
  } catch {
    // No map view yet.
  }
}

export function useMapCamera({
  mapReady,
  mapHeightPt,
  mapWidthPt = 0,
  insets = NO_INSETS,
  zoomOffset = 0,
  headingUpDotAt = HEADING_UP_DOT_AT,
  mode,
  headingUpRad,
  position,
  smoothing = false,
  route,
  ghostView,
  placing,
  placeFrom,
  overview,
  framePadding = FRAME_PADDING,
  onCenter,
  onUserInteraction,
  logCamera,
}: {
  /** The map's style has loaded: MapLibre drops a camera command sent before, and then shows its initial view. */
  mapReady: boolean;
  /** The map's own height (turned sideways, the screen's width); 0 before its layout: the screen's height. */
  mapHeightPt: number;
  /** The map's own width; 0 before its layout: the screen's. */
  mapWidthPt?: number;
  /** Edges of the map covered by others' panels (the car's screen): following keeps the position in the rest. */
  insets?: Insets;
  /** Added to the follow zooms: the car's map, drawn bigger, zooms out to show the same ground. */
  zoomOffset?: number;
  /** Heading-up's dot this far down the visible map (top 0, bottom 1); the phone's `HEADING_UP_DOT_AT` by default. */
  headingUpDotAt?: number;
  mode: CameraMode;
  headingUpRad: number | null;
  position: PositionEstimate | null;
  /** `position` is redrawn every frame (use-smoothed-position.ts): follow it frame by frame, without easing. */
  smoothing?: boolean;
  route: RouteSnapshot | null;
  ghostView: boolean;
  placing: PlacingStep | null;
  placeFrom: Coordinate | null;
  overview: number | null;
  /** Room for what covers the map when framing several things at once, points from each edge. */
  framePadding?: Insets;
  onCenter?(at: Coordinate): void;
  onUserInteraction(): void;
  logCamera?(text: string): void;
}) {
  const cameraRef = useRef<CameraRef | null>(null);
  // The car's map is taken down while Android Auto shows a list or the search over it: commands meanwhile fail.
  const commands = {
    jumpTo: (...a: Parameters<CameraRef["jumpTo"]>) => send(() => cameraRef.current?.jumpTo(...a)),
    easeTo: (...a: Parameters<CameraRef["easeTo"]>) => send(() => cameraRef.current?.easeTo(...a)),
    fitBounds: (...a: Parameters<CameraRef["fitBounds"]>) => send(() => cameraRef.current?.fitBounds(...a)),
    setStop: (...a: Parameters<CameraRef["setStop"]>) => send(() => cameraRef.current?.setStop(...a)),
  };
  const screenPt = useWindowDimensions();
  const fitRadiusPt = FIT_CIRCLE_SHARE * Math.min(screenPt.width, screenPt.height);
  const mapHeight = mapHeightPt > 0 ? mapHeightPt : screenPt.height;
  const mapWidth = mapWidthPt > 0 ? mapWidthPt : screenPt.width;
  // A small map under big panels (the car's) keeps some of itself for what is framed.
  const framing = () => fittedPadding(framePadding, mapWidth, mapHeight);
  // North up and flat. MapLibre on iOS fits bounds as the camera looks at the moment of asking: tilted and turned
  // close in (heading-up), a route's far end lies past the horizon and the fit landed zoomed into an empty block near
  // the destination (CarPlay's map). Flat first, then the fit.
  const frameFlat = (bounds: [number, number, number, number]) => {
    commands.setStop({ pitch: 0, bearing: 0, duration: 0 });
    commands.fitBounds(bounds, { padding: framing(), bearing: 0, pitch: 0, duration: 900 });
  };
  // By their numbers: the insets are a new object with every render.
  const { top: insetTop, bottom: insetBottom, left: insetLeft, right: insetRight } = insets;
  const ghost = position?.trust === "UNTRUSTED" && position.rawGnss ? position.rawGnss : null;
  // Heading-up with no direction known. Standing (none yet: parked on phone GPS, the app just opened): still tilted and
  // close in, the map left at the bearing it has, so the view doesn't drop flat and north while the button says
  // heading-up. Moving without one (the navigator anchored under jamming): the follow camera, north up, flat, so it
  // never looks like a heading-up view pointing the wrong way.
  const noDirection = mode === "follow-heading" && headingUpRad === null;
  const moving = (position?.speedMps ?? 0) > COURSE_MIN_SPEED_MPS;
  const camera = noDirection && moving ? "follow" : mode;
  // One object per mode and offset: the follow effect runs when it changes.
  const follow = useMemo(
    () => (camera === "free" ? null : { ...FOLLOW_CAMERA[camera], zoom: FOLLOW_CAMERA[camera].zoom + zoomOffset }),
    [camera, zoomOffset],
  );
  const followBearing =
    camera === "follow-heading" ? (headingUpRad !== null ? mapBearingDeg(headingUpRad) : undefined) : 0;

  useEffect(() => {
    logCamera?.(
      `camera ${mode}${camera !== mode ? ` shown as ${camera}: moving, no direction known` : noDirection ? ": no direction known, the map keeps its bearing" : ""}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, camera, noDirection]);
  const lastCameraLog = useRef(0);
  // Where the map last settled: placing logs the view it starts from.
  const lastView = useRef<{ pitch: number; bearing: number; zoom: number } | null>(null);
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
  // up, close in. Its step for the direction is flat and north up too, around the spot placed (the map's centre).
  useEffect(() => {
    if (!placing) return;
    if (placing === "position") {
      const v = lastView.current;
      logCamera?.(`camera placing from ${v ? `tilt ${Math.round(v.pitch)}°, bearing ${Math.round(v.bearing)}°, zoom ${v.zoom.toFixed(1)}` : "an unknown view"}`);
    }
    commands.setStop({
      ...(placing === "position" && placeFrom ? { center: [placeFrom.lon, placeFrom.lat] as [number, number] } : {}),
      ...(placing === "position" ? { zoom: PLACE_ZOOM } : {}),
      pitch: 0,
      bearing: 0,
      duration: 500,
      easing: "ease",
    });
    // Once per step (`placeFrom` is set when a placing starts), not on every position update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placing, placeFrom]);

  // A gesture that drops follow keeps the zoom the finger chose; only the button zooms out.
  const leftByGesture = useRef(false);
  // Free is flat (the map has no tilt gesture), but nothing may animate under the finger: a gesture that leaves a
  // tilted follow mode flattens once the map settles.
  const flattenPending = useRef(false);
  const flattenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flattenTimer.current), []);
  useEffect(() => {
    if (mode !== "free") {
      flattenPending.current = false;
      clearTimeout(flattenTimer.current);
      return;
    }
    const byGesture = leftByGesture.current;
    leftByGesture.current = false;
    // Placing and the ghost view set their own camera: a second command now would cancel theirs and start from the
    // map as it is, keeping heading-up's bearing (placing came out rotated at zoom 16, not north up at 18).
    if (byGesture || ghostView || placing) return;
    commands.setStop({
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
  // Followed since the map loaded. The first follow waits for it and jumps: sent before, it was dropped, and a dot that
  // stands still (a held or parked position) sends no other, so the map stayed on its initial view until the button.
  const followed = useRef(false);
  // The last follow stop, and whether the map has since been put back on it once (`onRegionDidChange`).
  const followStop = useRef<{
    center: [number, number];
    zoom: number;
    bearing?: number;
    pitch: number;
    padding: { top: number; bottom: number; left: number; right: number };
  } | null>(null);
  const followRestored = useRef(false);
  // The car has moved since the app opened: the follow zoom no longer makes room for the circle.
  const movedSinceOpen = useRef(false);
  const loggedFitZoom = useRef<number | null>(null);
  useEffect(() => {
    if (!mapReady) {
      followed.current = false;
      followCenter.current = null;
      return;
    }
    if (!position || !follow || ghostView) {
      followCenter.current = null;
      return;
    }
    const was = followCenter.current;
    const snapped = !followed.current || (was !== null && haversineM(was, position) > FOLLOW_JUMP_M);
    followed.current = true;
    followCenter.current = { lat: position.lat, lon: position.lon };
    if (moving) movedSinceOpen.current = true;
    const zoom = movedSinceOpen.current
      ? follow.zoom
      : fitCircleZoom(position.lat, Math.max(5, position.accuracyM), fitRadiusPt, follow.zoom);
    const fitted = zoom < follow.zoom ? zoom : null;
    if (fitted !== loggedFitZoom.current) {
      loggedFitZoom.current = fitted;
      logCamera?.(
        fitted !== null
          ? `camera follow: zoom ${fitted.toFixed(1)} to fit the circle (${Math.round(position.accuracyM)} m)`
          : `camera follow: zoom ${follow.zoom}${movedSinceOpen.current ? ", the car moved" : ", the circle fits"}`,
      );
    }
    // Heading-up lowers the dot, unless zoomed out for a wide circle: that stays centred so it fits between the panels.
    // Both in the part of the map no one else's panels cover.
    const lowered = camera === "follow-heading" && fitted === null;
    const visibleHeight = Math.max(0, mapHeight - insetTop - insetBottom);
    const stop = {
      center: [position.lon, position.lat] as [number, number],
      zoom,
      ...(followBearing !== undefined ? { bearing: followBearing } : {}),
      pitch: follow.pitch,
      padding: {
        top: insetTop + (lowered ? Math.round((2 * headingUpDotAt - 1) * visibleHeight) : 0),
        bottom: insetBottom,
        left: insetLeft,
        right: insetRight,
      },
    };
    followStop.current = stop;
    followRestored.current = false;
    // Smoothed, every frame is a small step: an ease per frame would lag and restart 30 times a second.
    if (snapped || smoothing) commands.jumpTo(stop);
    else commands.easeTo({ ...stop, duration: FOLLOW_EASE_MS });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, follow, position, ghostView, followBearing, smoothing, fitRadiusPt, mapHeight, insetTop, insetBottom, insetLeft, insetRight, headingUpDotAt]);

  // The route and its alternatives at once (ROUTING-SPEC §8.7), north up: framed once when asked, once the map can
  // take it (the car's map, made again after a list over it, asked before its style had loaded).
  useEffect(() => {
    if (!mapReady || overview == null || !route?.plan) return;
    const all = [route.plan, ...(route.alternatives ?? []).map((a) => a.plan)].flatMap((p) => p.coordinates);
    if (all.length < 2) return;
    // A loop, not Math.min(...all): spread, a long route's points could pass the engine's limit on arguments.
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of all) {
      box[0] = Math.min(box[0], c.lon);
      box[1] = Math.min(box[1], c.lat);
      box[2] = Math.max(box[2], c.lon);
      box[3] = Math.max(box[3], c.lat);
    }
    frameFlat(box);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, mapReady]);

  const hasGhost = ghost != null;
  useEffect(() => {
    if (!ghostView || !position || !ghost) return;
    frameFlat([Math.min(position.lon, ghost.lon), Math.min(position.lat, ghost.lat), Math.max(position.lon, ghost.lon), Math.max(position.lat, ghost.lat)]);
    // Frame once when the ghost view opens, not on every fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghostView, hasGhost]);

  const onRegionIsChanging = (event: NativeSyntheticEvent<{ userInteraction?: boolean }>) => {
    // Still moving: the gesture hasn't settled yet.
    clearTimeout(flattenTimer.current);
    if (!event.nativeEvent.userInteraction) return;
    if (follow) {
      leftByGesture.current = true;
      flattenPending.current = follow.pitch > 0;
    }
    onUserInteraction();
  };
  const onRegionDidChange = (
    event: NativeSyntheticEvent<{
      pitch: number;
      zoom?: number;
      bearing?: number;
      center?: [number, number];
      userInteraction?: boolean;
    }>,
  ) => {
    const { bearing, center, pitch, zoom } = event.nativeEvent;
    if (bearing !== undefined && zoom !== undefined) lastView.current = { pitch, bearing, zoom };
    if (placing === "position" && center) onCenter?.({ lat: center[1], lon: center[0] });
    // Following, the map settled by itself far from the dot: iOS applies the initial view (the region's bounds) at the
    // map's first layout, which can come after the style has loaded and the first follow has jumped. A dot that stands
    // still sends no other, so the map stayed on the whole region (2026-10-14). Jump back, once per follow stop.
    const stop = followStop.current;
    const sent = followCenter.current;
    if (center && stop && sent && follow && !ghostView && !event.nativeEvent.userInteraction && !followRestored.current) {
      const offM = haversineM({ lat: center[1], lon: center[0] }, sent);
      if (offM > FOLLOW_JUMP_M + (stop.padding.top > 0 ? HEADING_UP_CENTRE_OFF_M : 0)) {
        followRestored.current = true;
        logCamera?.(`camera follow: the map settled ${Math.round(offM)} m from the dot by itself, back to it`);
        commands.jumpTo(stop);
      }
    }
    if (logCamera && camera === "follow-heading" && bearing !== undefined && followBearing !== undefined) {
      const off = Math.abs(((bearing - followBearing + 540) % 360) - 180);
      // Tilt too: a flat heading-up view with the right bearing looks north-up and leaves no other trace.
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
    if (!flattenPending.current) return;
    // A pan cancelling the follow ease reports did-change at its start, so wait for quiet.
    clearTimeout(flattenTimer.current);
    flattenTimer.current = setTimeout(() => {
      flattenPending.current = false;
      commands.setStop({ pitch: 0, duration: 300, easing: "ease" });
    }, 80);
  };

  /**
   * A gesture the map view didn't see (the car's screen) leaves following: the map stays where the finger took it, as
   * after one of its own, not stepping back to `FREE_ZOOM`.
   */
  const onOutsideGesture = () => {
    if (follow) leftByGesture.current = true;
  };

  return { cameraRef, onRegionIsChanging, onRegionDidChange, onOutsideGesture };
}
