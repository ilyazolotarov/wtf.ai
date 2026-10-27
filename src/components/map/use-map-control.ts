import type { CameraRef, MapRef } from "@maplibre/maplibre-react-native";
import { useRef, type RefObject } from "react";

import { FLING_EASE_MS, FLING_S, pannedCenter, zoomedCenter } from "./map-moves";

/**
 * The map moved from outside the map view (the car's screen: Android Auto hands the app its gestures,
 * ANDROID-AUTO-SPEC §4), in the map's dp.
 */
export interface MapControl {
  /** A drag: the camera moves by (dx, dy), the distance the finger went back. */
  pan(dx: number, dy: number): void;
  /** A fling's velocity, dp/s, the way the finger went: the map carries on, eased out. */
  fling(vx: number, vy: number): void;
  /** Zoom `factor` times about a point of the map (null: its centre). */
  zoom(factor: number, focus: [number, number] | null, animated?: boolean): void;
  /** A tap: a grey route or its label under it is followed instead (ROUTING-SPEC §8.7). */
  tap(x: number, y: number): void;
}

interface Pending {
  dx: number;
  dy: number;
  factor: number;
  focus: [number, number] | null;
  durationMs: number;
}

const NONE: Pending = { dx: 0, dy: 0, factor: 1, focus: null, durationMs: 0 };

/**
 * `MapControl`'s moves for a map (the tap is the map surface's, which knows the routes): each move reads the camera and the ground under the screen (async), so moves that come
 * meanwhile (a drag sends one every frame) are added up and sent as one.
 */
export function useMapControl(
  mapRef: RefObject<MapRef | null>,
  cameraRef: RefObject<CameraRef | null>,
  size: RefObject<{ width: number; height: number }>,
): Omit<MapControl, "tap"> {
  const pending = useRef<Pending>(NONE);
  const busy = useRef(false);

  const run = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      while (pending.current !== NONE) {
        const p = pending.current;
        pending.current = NONE;
        const map = mapRef.current;
        const camera = cameraRef.current;
        if (!map || !camera) return;
        const [[lon, lat], zoom] = await Promise.all([map.getCenter(), map.getZoom()]);
        let center = { lat, lon };
        if (p.dx !== 0 || p.dy !== 0) {
          const mid: [number, number] = [size.current.width / 2, size.current.height / 2];
          const [[aLon, aLat], [bLon, bLat]] = await Promise.all([map.unproject(mid), map.unproject([mid[0] + p.dx, mid[1] + p.dy])]);
          center = pannedCenter(center, { lat: aLat, lon: aLon }, { lat: bLat, lon: bLon });
        }
        if (p.factor !== 1) {
          const focus = p.focus ? await map.unproject(p.focus) : null;
          center = zoomedCenter(center, focus && { lat: focus[1], lon: focus[0] }, p.factor);
        }
        const stop = { center: [center.lon, center.lat] as [number, number], zoom: zoom + Math.log2(p.factor) };
        if (p.durationMs > 0) camera.easeTo({ ...stop, duration: p.durationMs, easing: "ease" });
        else camera.jumpTo(stop);
      }
    } catch {
      // The map view went (the car's screen showed a list over it): the move is dropped.
      pending.current = NONE;
    } finally {
      busy.current = false;
    }
  };

  const add = (more: Partial<Pending>) => {
    const p = pending.current;
    pending.current = {
      dx: p.dx + (more.dx ?? 0),
      dy: p.dy + (more.dy ?? 0),
      factor: p.factor * (more.factor ?? 1),
      focus: more.focus !== undefined ? more.focus : p.focus,
      durationMs: Math.max(p.durationMs, more.durationMs ?? 0),
    };
    void run();
  };

  return {
    pan: (dx, dy) => add({ dx, dy }),
    fling: (vx, vy) => add({ dx: -vx * FLING_S, dy: -vy * FLING_S, durationMs: FLING_EASE_MS }),
    zoom: (factor, focus, animated = false) => add({ factor, focus, durationMs: animated ? 300 : 0 }),
  };
}
