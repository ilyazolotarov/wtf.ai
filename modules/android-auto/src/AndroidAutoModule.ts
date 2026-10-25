import { NativeModule, requireOptionalNativeModule } from "expo";

// Typed binding for modules/android-auto (docs/ANDROID-AUTO-SPEC.md §4): what the car's screen shows, and what the driver
// did there. Android only; null on iOS, on web and in builds without it.

/** One maneuver ahead. */
export interface CarStepPayload {
  /** The app's maneuver kind (src/nav/routing/maneuvers.ts). */
  kind: string;
  /** Roundabouts: the exit to take, 1-based. */
  exit?: number | null;
  /** "Turn left", in the app's language. */
  instruction: string;
  /** From the car (the first) or the step before (the second), m and s. */
  distanceM: number;
  timeS: number;
  /** The distance as the phone's banner rounds it: "m", "km", or "km1" (one decimal). */
  shownDistance: number;
  shownUnit: CarDistanceUnit;
}

export type CarDistanceUnit = "m" | "km" | "km1";

export interface CarRoutePayload {
  status: "planning" | "active" | "arrived" | "failed";
  /** Shown instead of a maneuver: planning, a failure, arrival. */
  message?: string | null;
  destinationName: string;
  /** Planning again after leaving the route. */
  replanning: boolean;
  /** The next maneuver, and the one after when it follows closely. */
  steps: CarStepPayload[];
  remainingM: number;
  remainingS: number;
  remainingShown: number;
  remainingUnit: CarDistanceUnit;
}

export interface CarPlacePayload {
  id: string;
  title: string;
  detail?: string | null;
  kind: "home" | "work" | "favorite" | "recent";
}

/** The car screen's own words, in the app's language. */
export interface CarLabelsPayload {
  endRoute: string;
  destinations: string;
  saved: string;
  recent: string;
  noDestinations: string;
  voiceOn: string;
  voiceOff: string;
  /** The phone's notification while the car session keeps the position. */
  notification: string;
}

/**
 * `end-route`: the driver ended the route on the car's screen, or the host did (another navigator started one);
 * `go`: a destination picked in the list (`id`); `toggle-voice`; `session-ended`: the car's screen is gone.
 */
export type CarAction =
  | { action: "end-route" }
  | { action: "go"; id: string }
  | { action: "toggle-voice" }
  | { action: "session-ended" };

export type AndroidAutoEvents = {
  onCarAction: (event: CarAction) => void;
};

declare class AndroidAutoNativeModule extends NativeModule<AndroidAutoEvents> {
  /** A car's screen is connected to the app (its session is open). */
  isConnected(): boolean;
  setLabels(labels: CarLabelsPayload): Promise<void>;
  setRoute(route: CarRoutePayload | null): Promise<void>;
  setPlaces(places: CarPlacePayload[]): Promise<void>;
  /** Null: no voice (volume 0), no button. */
  setVoiceMuted(muted: boolean | null): Promise<void>;
}

export default requireOptionalNativeModule<AndroidAutoNativeModule>("AndroidAuto");
