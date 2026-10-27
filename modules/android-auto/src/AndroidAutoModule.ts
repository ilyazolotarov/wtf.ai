import { NativeModule, requireOptionalNativeModule } from "expo";

// Typed binding for modules/android-auto (docs/ANDROID-AUTO-SPEC.md §4): what the car's screen shows, and what the driver
// did there. Android only; null on iOS, on web and in builds without it.

/** One maneuver ahead. */
export interface CarStepPayload {
  /** The same maneuver on the road keeps it across plans (`carManeuverId`): the car's notification pops up once. */
  id: string;
  /** The app's maneuver kind (src/nav/routing/maneuvers.ts). */
  kind: string;
  /** Roundabouts: the exit to take, 1-based. */
  exit?: number | null;
  /** "Turn left", in the app's language. */
  instruction: string;
  /** From the car, m, and the time to it at the plan's pace, s. */
  distanceM: number;
  timeS: number;
  /** The distance from the car as the phone's banner rounds it: "m", "km", or "km1" (one decimal). */
  shownDistance: number;
  shownUnit: CarDistanceUnit;
  /** The same as the banner writes it, in the app's language ("1,2 км"): the notification's title. */
  distanceText: string;
}

export type CarDistanceUnit = "m" | "km" | "km1";

export interface CarRoutePayload {
  status: "planning" | "active" | "arrived" | "failed";
  /** Shown instead of a maneuver: planning (again), a failure, arrival. */
  message?: string | null;
  destinationName: string;
  /** Planning again after leaving the route. */
  replanning: boolean;
  /** The driver keeps to their own way: the route shows, nothing pops up (`RouteSnapshot.ownWay`). */
  quiet: boolean;
  /** The next maneuver, and the one after when it follows closely. */
  steps: CarStepPayload[];
  remainingM: number;
  remainingS: number;
  remainingShown: number;
  remainingUnit: CarDistanceUnit;
}

/** A destination to pick: a saved place, a recent one, or a search result. */
export interface CarPlacePayload {
  id: string;
  title: string;
  detail?: string | null;
  kind: "home" | "work" | "favorite" | "recent" | "result";
}

/** What the car's search found, and the text it answers (the screen shows it only for that text). */
export interface CarSearchPayload {
  query: string;
  results: CarPlacePayload[];
}

/**
 * A place the car's assistant or another app asked for: a `geo:` URI; `navigate`, to go there
 * (`androidx.car.app.action.NAVIGATE`), else to look for it.
 */
export interface CarRequest {
  navigate: boolean;
  uri: string;
}

/** The car screen's own words, in the app's language. */
export interface CarLabelsPayload {
  endRoute: string;
  destinations: string;
  saved: string;
  recent: string;
  noDestinations: string;
  /** The search button's name; the search field's hint; its list with nothing found. */
  search: string;
  searchHint: string;
  noResults: string;
  /** Shown when the car sends the driver to the phone (the permission dialog): look at it only when it's safe. */
  checkPhone: string;
  /** The phone's notification while the car session keeps the position. */
  notification: string;
}

/**
 * What the driver must do before the car can guide, shown instead of the route. `location`: no location permission
 * (the button asks for it on the phone, parked only); `held-route`: a route without an adapter waits for the driver's
 * word (the button gives it, a close button drops the route).
 */
export interface CarNoticePayload {
  kind: "location" | "held-route";
  title: string;
  text: string;
  /** The button's words. */
  action: string;
}

/** What happened on the native side, for the trip log; `problem`: reported too. */
export interface CarNote {
  text: string;
  problem: boolean;
}

/**
 * `end-route`: the driver ended the route on the car's screen, or the host did (another navigator started one);
 * `go`: a destination or search result picked (`id`); `search`: the search screen's text changed; `request`: a place
 * asked for, to take; `toggle-voice`; `confirm-held`, `cancel-held`: the held route's buttons; `permission`: the
 * location request answered; `notes`: native notes to take; `session-ended`: the car's screen is gone.
 */
export type CarAction =
  | { action: "end-route" }
  | { action: "go"; id: string }
  | { action: "search"; text: string }
  | { action: "request" }
  | { action: "toggle-voice" }
  | { action: "confirm-held" }
  | { action: "cancel-held" }
  | { action: "permission" }
  | { action: "notes" }
  | { action: "session-ended" };

/**
 * The driver on the car's map, in the map's dp: `scroll`, the distance the finger went back since the last (the camera
 * moves by it); `fling`, the finger's velocity, dp/s; `scale`, a pinch or double tap about a focus (-1, -1: none);
 * `zoom`, the zoom buttons (+1 in, -1 out); `recentre`, the recentre button.
 */
export type CarMapGesture =
  | { kind: "scroll"; dx: number; dy: number }
  | { kind: "fling"; vx: number; vy: number }
  | { kind: "scale"; x: number; y: number; factor: number }
  | { kind: "zoom"; by: number }
  | { kind: "recentre" };

export type AndroidAutoEvents = {
  onCarAction: (event: CarAction) => void;
  onMapGesture: (event: CarMapGesture) => void;
};

declare class AndroidAutoNativeModule extends NativeModule<AndroidAutoEvents> {
  /** A car's screen is connected to the app (its session is open). */
  isConnected(): boolean;
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
