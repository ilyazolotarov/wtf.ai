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
} from "../../../src/components/car-screen/car-types";

// Typed binding for modules/android-auto (docs/ANDROID-AUTO-SPEC.md §4): what the car's screen shows, and what the driver
// did there (the payloads are the car session's, src/components/car-screen/car-types.ts, shared with CarPlay). Android
// only; null on iOS, on web and in builds without it.

export type AndroidAutoEvents = {
  onCarAction: (event: CarAction) => void;
  onMapGesture: (event: CarMapGesture) => void;
};

declare class AndroidAutoNativeModule extends NativeModule<AndroidAutoEvents> {
  /** A car's screen is connected to the app (its session is open). */
  isConnected(): boolean;
  /** The car asked for its test drive in this session (`test-drive`, maybe before the JS side listened). */
  isTestDrive(): boolean;
  setLabels(labels: CarLabelsPayload): Promise<void>;
  setRoute(route: CarRoutePayload | null): Promise<void>;
  setPlaces(places: CarPlacePayload[]): Promise<void>;
  /** Null: no voice (volume 0), no button. */
  setVoiceMuted(muted: boolean | null): Promise<void>;
  setNotice(notice: CarNoticePayload | null): Promise<void>;
  setSearch(search: CarSearchPayload | null): Promise<void>;
  /** The search screen with `query` typed, over the map (after `setSearch` with its answers). */
  openSearch(query: string): Promise<void>;
  /** The map, with a list or the search open over it gone (a place asked for is gone to). */
  showMap(): Promise<void>;
  /** The recentre button: shown while the driver has moved the car's map or zoomed it from the follow zoom. */
  setRecentre(shown: boolean): Promise<void>;
  /** The car's map has drawn its style: the map data credit shows from now. */
  mapDrawn(): Promise<void>;
  /** A place asked for, once: taking it clears it. */
  takeRequest(): Promise<CarRequest | null>;
  /** The native side's notes since the last call. */
  takeNotes(): Promise<CarNote[]>;
}

export default requireOptionalNativeModule<AndroidAutoNativeModule>("AndroidAuto");
