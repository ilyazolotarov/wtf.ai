import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { Platform } from "react-native";

import { cameraReducer, INITIAL_CAMERA, type CameraState } from "@/components/map/camera-policy";
import { shiftedFollowZoom } from "@/components/map/map-moves";
import { MapSurface } from "@/components/map/map-surface";
import { onRecentreRequest } from "@/components/map/recentre-request";
import { COURSE_MIN_SPEED_MPS, useHeadingUp } from "@/components/map/use-compass-heading";
import type { MapControl } from "@/components/map/use-map-control";
import { I18nProvider } from "@/i18n/provider";
import { PositionProvider, usePosition } from "@/providers/position-provider";

import AndroidAuto from "../../../modules/android-auto/src/AndroidAutoModule";
import CarPlay from "../../../modules/car-play/src/CarPlayModule";
import { ensureCarPlaySession } from "./car-session-task";
import { CarSpeedPill } from "./car-speed-pill";
import type { CarMapGesture } from "./car-types";

/** What the car's map needs of its platform's module: the driver's gestures, and the buttons to show. */
interface CarMapNative {
  addListener(event: "onMapGesture", listener: (g: CarMapGesture) => void): { remove(): void };
  setRecentre?(shown: boolean): Promise<void>;
}

const native: CarMapNative | null = Platform.OS === "ios" ? CarPlay : AndroidAuto;

/** The part of the car's screen under the template's cards and buttons, in dp (points on iOS) from each edge. */
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
  /** The map drawn this many times the car's density (CarMapSurface; CarPlay's root): bigger, for a driver. */
  scale?: number;
  /** The follow zoom moved by this many levels for the car's screen (CarPlay: its points are several pixels). */
  zoom?: number;
  /** CarPlay: the camera's alert is up with its sign (CarPlaySession), so the speed's pill shows none of its own. */
  cameraSign?: boolean;
  /**
   * CarPlay: the speed's pill's room on the right in the corner above the map's buttons, points (CarPlaySession). A
   * build without it: beside the buttons' column (`insets.right`).
   */
  speedRight?: number;
}

/**
 * The car's map (docs/ANDROID-AUTO-SPEC.md §4, docs/CARPLAY-SPEC.md §4): the React root `CarMap` that
 * modules/android-auto mounts on the car's screen while it shows the app, `CarPlayMap` that modules/car-play mounts
 * while CarPlay is connected (index.ts), on the same JS runtime and services as the phone's screens. The phone's map,
 * heading-up and following the car in the part of the screen the template leaves free. What it shows of the route
 * besides the map, and the navigator kept running, are the car session's (car-session-task.ts).
 */
export function CarMapRoot({ dark = false, insets = {}, scale = 1, zoom = 0, cameraSign = false, speedRight }: CarMapProps) {
  return (
    <I18nProvider>
      {/* The session runs the navigator: this map only draws it. */}
      <PositionProvider gnss={false}>
        <CarMap dark={dark} insets={insets} scale={scale} zoom={zoom} cameraSign={cameraSign} speedRight={speedRight} />
      </PositionProvider>
    </I18nProvider>
  );
}

const noop = () => {};
/**
 * CarPlay's map: it draws its own speed (Android Auto's is native, React Native text on its display being drawn at the
 * phone's density), and its points are made for the car's screen, so the POIs keep the style's sizes. Neither car's map
 * shows the map data credit: the phone's map shows it as it opens and Settings keeps it (UI-SPEC §6.1), and on CarPlay
 * Apple's guide keeps the base view to the map. (Older Android Auto builds draw one natively only once told the map
 * has drawn, which nothing does now.)
 */
const carPlay = Platform.OS === "ios";
/** The speed this far in from its corner, as Android Auto's (CarMapSurface). */
const SPEED_GAP = 8;

/**
 * Heading-up puts the dot this far down the car's visible map (the phone: 0.8 of its whole map): a car's screen is
 * wide and short, and the road ahead needs its height. Google Maps keeps its arrow lower still (about 0.92 on the head
 * unit), flat; tilted, the top already reaches far ahead.
 */
const CAR_HEADING_UP_DOT_AT = 0.85;

/**
 * The car's map follows heading-up; the driver's drag or pinch leaves it free (camera-policy.ts, as on the phone). It
 * frames no overview of a new route's alternatives as the phone does: a car's screen is too small to read the routes
 * on, a car without a touch screen can't zoom or pick one on the map, and the routes button lists them (2026-10-31).
 */
const CAR_CAMERA: CameraState = { ...INITIAL_CAMERA, mode: "follow-heading" };

function CarMap({ dark, insets, scale, zoom, cameraSign, speedRight }: Required<Omit<CarMapProps, "speedRight">> & Pick<CarMapProps, "speedRight">) {
  const position = usePosition();
  const headingUp = useHeadingUp(position, null);
  // The car shows the app: its session runs (car-session-task.ts), started here if its start was missed.
  useEffect(() => {
    if (carPlay) ensureCarPlaySession();
  }, []);
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
    void native?.setRecentre?.(recentre).catch(noop);
  }, [recentre]);
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
    const subscription = native?.addListener("onMapGesture", (g) => onGesture(g));
    return () => subscription?.remove();
  }, []);
  // The phone's camera button recentres the car's map too (UI-SPEC §6.2), as the car's own recentre button does: the
  // driver who can't reach the car's buttons (a knob that gives no focus) has the phone in the holder.
  useEffect(() => onRecentreRequest(() => onGesture({ kind: "recentre" })), []);
  const padding = {
    left: Math.round(insets.left ?? 0),
    top: Math.round(insets.top ?? 0),
    right: Math.round(insets.right ?? 0),
    bottom: Math.round(insets.bottom ?? 0),
  };
  // CarPlay's speed in the corner above the map's buttons; while CarPlay's bar shows (a top inset: the card and the
  // pill would come down level with the buttons) at the visible map's bottom left.
  const speedAt =
    padding.top > 0
      ? { left: padding.left + SPEED_GAP, bottom: padding.bottom + SPEED_GAP }
      : { right: Math.round(speedRight ?? padding.right) + SPEED_GAP, top: padding.top + SPEED_GAP };
  return (
    <>
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
        carGuidelineSizes={!carPlay}
        headingUpDotAt={CAR_HEADING_UP_DOT_AT}
        creditAt={null}
        control={control}
        followZoomShift={zoom + zoomShift}
      />
      {carPlay && (
        <CarSpeedPill at={speedAt} dark={dark} cameraSign={cameraSign} />
      )}
    </>
  );
}
