import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";

import { cameraReducer, INITIAL_CAMERA, type CameraState } from "@/components/map/camera-policy";
import { shiftedFollowZoom } from "@/components/map/map-moves";
import { MapSurface } from "@/components/map/map-surface";
import { COURSE_MIN_SPEED_MPS, useHeadingUp } from "@/components/map/use-compass-heading";
import type { MapControl } from "@/components/map/use-map-control";
import { I18nProvider } from "@/i18n/provider";
import { PositionProvider, usePosition } from "@/providers/position-provider";
import { useRoute } from "@/providers/route-provider";

import AndroidAuto, { type CarMapGesture } from "../../../modules/android-auto/src/AndroidAutoModule";

/** The part of the car's screen under Android Auto's cards and buttons, in dp from each edge. */
export interface CarInsets {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

export interface CarMapProps {
  /** The car's night mode (its own, not the phone's). */
  dark?: boolean;
  insets?: CarInsets;
  /** The map drawn this many times the car's density (CarMapSurface): bigger, as Android for Cars asks. */
  scale?: number;
}

/**
 * The car's map (docs/ANDROID-AUTO-SPEC.md §4): the React root `CarMap` (index.ts), which modules/android-auto mounts on
 * the car's screen while it shows the app, on the same JS runtime and services as the phone's screens. The phone's map,
 * heading-up and following the car in the part of the screen the template leaves free. What it shows of the route
 * besides the map, and the navigator kept running, are the car session's (car-session-task.ts).
 */
export function CarMapRoot({ dark = false, insets = {}, scale = 1 }: CarMapProps) {
  return (
    <I18nProvider>
      {/* The session runs the navigator: this map only draws it. */}
      <PositionProvider gnss={false}>
        <CarMap dark={dark} insets={insets} scale={scale} />
      </PositionProvider>
    </I18nProvider>
  );
}

const noop = () => {};
// A build older than `mapDrawn` (an update reaches it) has none.
const onMapDrawn = () => void AndroidAuto?.mapDrawn?.().catch(noop);

/**
 * Heading-up puts the dot this far down the car's visible map (the phone: 0.8 of its whole map): a car's screen is
 * wide and short, and the road ahead needs its height. Google Maps keeps its arrow lower still (about 0.92 on the head
 * unit), flat; tilted, the top already reaches far ahead.
 */
const CAR_HEADING_UP_DOT_AT = 0.85;

/** The destination whose routes the car's map last framed, kept across its remounts. */
let overviewShownFor: object | null = null;

/** Framing the routes: this much room inside the cards (map dp), for the routes' labels at their ends. */
const FRAME_GAP = 32;

/** The car's map follows heading-up; the driver's drag or pinch leaves it free (camera-policy.ts, as on the phone). */
const CAR_CAMERA: CameraState = { ...INITIAL_CAMERA, mode: "follow-heading" };

function CarMap({ dark, insets, scale }: Required<CarMapProps>) {
  const position = usePosition();
  const headingUp = useHeadingUp(position, null);
  const [camera, dispatch] = useReducer(cameraReducer, CAR_CAMERA);
  const free = camera.mode === "free";
  // The zoom buttons and pinches while following move the follow zoom; while free, the map's own.
  const [zoomShift, setZoomShift] = useState(0);
  const control = useRef<MapControl | null>(null);
  // Driving, a look around ends 10 s after the last touch, as on the phone (`RETURN_AFTER_TOUCH_MS`).
  const driving = (position?.speedMps ?? 0) > COURSE_MIN_SPEED_MPS;
  useEffect(() => {
    if (!driving) return;
    const timer = setInterval(() => dispatch({ type: "driving", nowMs: Date.now() }), 1000);
    return () => clearInterval(timer);
  }, [driving]);
  // Recentre shows while the map is free or its follow zoom moved: it also resets the zoom.
  const recentre = free || zoomShift !== 0;
  useEffect(() => {
    void AndroidAuto?.setRecentre?.(recentre).catch(noop);
  }, [recentre]);
  // A new route's alternatives while the car stands: the map frames them all once (ROUTING-SPEC §8.7), as the phone's;
  // driving off or recentre goes back to following. Once per destination across the map's remounts (a list shown over
  // it takes it down): back from the routes list it follows. (State adjusted during render, not in an effect.)
  const { route } = useRoute();
  const [overview, setOverview] = useState<number | null>(null);
  const [overviewFor, setOverviewFor] = useState<object | null>(() => overviewShownFor);
  useEffect(() => {
    overviewShownFor = overviewFor;
  }, [overviewFor]);
  if (route?.alternatives?.length && overviewFor !== route.destination) {
    setOverviewFor(route.destination);
    if (!driving) {
      dispatch({ type: "set", mode: "free" });
      setOverview(route.planId);
    }
  }
  const onGesture = useEffectEvent((g: CarMapGesture) => {
    const moved = () => dispatch({ type: "gesture", nowMs: Date.now() });
    switch (g.kind) {
      case "scroll":
        moved();
        return control.current?.pan(g.dx, g.dy);
      case "fling":
        moved();
        return control.current?.fling(g.vx, g.vy);
      case "scale":
      case "zoom": {
        const factor = g.kind === "zoom" ? 2 ** g.by : g.factor;
        if (!free) return setZoomShift((s) => shiftedFollowZoom(s, Math.log2(factor)));
        moved();
        const focus: [number, number] | null = g.kind === "scale" && g.x >= 0 && g.y >= 0 ? [g.x, g.y] : null;
        return control.current?.zoom(factor, focus, g.kind === "zoom");
      }
      case "click":
        return control.current?.tap(g.x, g.y);
      // Back to the car at the follow zoom's own level, whatever + and − did before.
      case "recentre":
        setZoomShift(0);
        if (free) dispatch({ type: "button", onTrip: false });
        return;
    }
  });
  useEffect(() => {
    const subscription = AndroidAuto?.addListener("onMapGesture", (g) => onGesture(g));
    return () => subscription?.remove();
  }, []);
  const padding = {
    left: Math.round(insets.left ?? 0),
    top: Math.round(insets.top ?? 0),
    right: Math.round(insets.right ?? 0),
    bottom: Math.round(insets.bottom ?? 0),
  };
  return (
    <MapSurface
      mode={camera.mode}
      ghostView={false}
      compass={null}
      headingUpRad={headingUp}
      onUserInteraction={noop}
      onLongPress={noop}
      pin={null}
      scheme={dark ? "dark" : "light"}
      insets={padding}
      onOwnScreen
      carScale={scale}
      headingUpDotAt={CAR_HEADING_UP_DOT_AT}
      // The credit is native there (CarMapSurface): this display draws React Native text clipped.
      creditAt={null}
      onReady={onMapDrawn}
      control={control}
      followZoomShift={zoomShift}
      overview={overview}
      framePadding={{
        top: padding.top + FRAME_GAP,
        bottom: padding.bottom + FRAME_GAP,
        left: padding.left + FRAME_GAP,
        right: padding.right + FRAME_GAP,
      }}
    />
  );
}
