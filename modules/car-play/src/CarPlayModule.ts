import { NativeModule, requireOptionalNativeModule } from "expo";

import type {
  CarAction,
  CarLabelsPayload,
  CarMapGesture,
  CarNote,
  CarNoticePayload,
  CarPlacePayload,
  CarRequest,
  CarRoutePayload,
  CarSearchPayload,
  CarSpeedPayload,
} from "../../../src/components/car-screen/car-types";

// Typed binding for modules/car-play (iOS; docs/CARPLAY-SPEC.md §4): what the car's screen shows, and what the driver
// did there, with the payloads and actions of Android Auto's (src/components/car-screen/car-types.ts). Null on Android,
// on web and in builds without it.

export type CarPlayEvents = {
  /**
   * The driver opened the app on CarPlay, the first time since its scene connected: a car session starts, until the
   * car disconnects (`isConnected` tells a runtime that came up after).
   */
  onConnect: () => void;
  onCarAction: (event: CarAction) => void;
  onMapGesture: (event: CarMapGesture) => void;
};

declare class CarPlayNativeModule extends NativeModule<CarPlayEvents> {
  /** The car session is open: the driver opened the app on CarPlay since its scene connected. */
  isConnected(): boolean;
  setLabels(labels: CarLabelsPayload): Promise<void>;
  setRoute(route: CarRoutePayload | null): Promise<void>;
  setPlaces(places: CarPlacePayload[]): Promise<void>;
  /** Null: no voice (volume 0), no button. */
  setVoiceMuted(muted: boolean | null): Promise<void>;
  setNotice(notice: CarNoticePayload | null): Promise<void>;
  setSearch(search: CarSearchPayload | null): Promise<void>;
  /** The speed camera ahead as CarPlay's alert over the map; null: none. The speed itself the map's root draws. */
  setSpeed(speed: CarSpeedPayload | null): Promise<void>;
  /** The answers to `query` in a list over the map (after `setSearch` with them): CarPlay's search can't be typed in. */
  openSearch(query: string): Promise<void>;
  /** The map, with a list or the search open over it gone (a place asked for is gone to). */
  showMap(): Promise<void>;
  /** The recentre button: shown while the driver has moved the car's map or zoomed it from the follow zoom. */
  setRecentre(shown: boolean): Promise<void>;
  /** A place asked for, once: taking it clears it. */
  takeRequest(): Promise<CarRequest | null>;
  /** The native side's notes since the last call. */
  takeNotes(): Promise<CarNote[]>;
}

export default requireOptionalNativeModule<CarPlayNativeModule>("CarPlay");
