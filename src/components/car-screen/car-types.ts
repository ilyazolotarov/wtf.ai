// What the car's screen shows and what the driver did there, the same for Android Auto (modules/android-auto,
// docs/ANDROID-AUTO-SPEC.md §4) and CarPlay (modules/car-play, docs/CARPLAY-SPEC.md §4): the car session
// (car-session.ts) decides it, each platform's native side only draws it with its templates.

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
  /** Where the route goes: CarPlay's trip names it, a new one is a new trip. */
  destinationLat: number;
  destinationLon: number;
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
  /** The routes list's row for the route followed: the street it goes by, else "This route"; its time and distance. */
  title: string;
  detail: string;
  /** The other ways to choose from (ROUTING-SPEC §8.7): none while planning, planned again or arrived. */
  alternatives: CarAlternativePayload[];
}

/**
 * Another way to the destination: `index` in the route's alternatives; the street it goes by (else its time against
 * the route); its time against the route, its own time and distance.
 */
export interface CarAlternativePayload {
  index: number;
  title: string;
  detail: string;
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
 * A place the car's assistant or another app asked for: a `geo:` URI; `navigate`, to go there (Android Auto's
 * `androidx.car.app.action.NAVIGATE`, a `google.navigation:` link), else to look for it.
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
  /** The phone's notification while the car session keeps the position (Android). */
  notification: string;
  /** The routes list's title; its row for the route followed. */
  routes: string;
  thisRoute: string;
  /** CarPlay's alerts: the button that drops a held route; the one that closes arrival and a failed plan. */
  cancel: string;
  close: string;
}

/**
 * What the driver must do before the car can guide, shown instead of the route. `no-map`: no offline map installed
 * (the button only closes it: nothing on the car's screen downloads one); `location`: no location permission
 * (the button asks for it on the phone, parked only); `held-route`: a route without an adapter waits for the driver's
 * word (the button gives it, a close button drops the route).
 */
export interface CarNoticePayload {
  kind: "location" | "held-route" | "no-map";
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
 * `end-route`: the driver ended the route on the car's screen, or the car did (another navigator started one);
 * `go`: a destination or search result picked (`id`); `choose-alternative`: a route picked in the routes list;
 * `search`: the search screen's text changed; `request`: a place asked for, to take; `toggle-voice`; `confirm-held`,
 * `cancel-held`: the held route's buttons; `permission`: the location request answered; `notes`: native notes to take;
 * `session-ended`: the car's screen is gone.
 */
export type CarAction =
  | { action: "end-route" }
  | { action: "go"; id: string }
  | { action: "choose-alternative"; index: number }
  | { action: "search"; text: string }
  | { action: "request" }
  | { action: "toggle-voice" }
  | { action: "confirm-held" }
  | { action: "cancel-held" }
  | { action: "permission" }
  | { action: "notes" }
  /** Android Auto asks for its test drive (quality guideline NF-7): each route started is driven along. */
  | { action: "test-drive" }
  | { action: "session-ended" };

/**
 * The driver on the car's map, in the map's dp (points on iOS): `scroll`, the distance the finger went back since the
 * last (the camera moves by it); `fling`, the finger's velocity, dp/s; `scale`, a pinch or double tap about a focus
 * (-1, -1: none), relative to the last; `zoom`, the zoom buttons (+1 in, -1 out); `recentre`, the recentre button;
 * `click`, a tap on the map.
 */
export type CarMapGesture =
  | { kind: "scroll"; dx: number; dy: number }
  | { kind: "fling"; vx: number; vy: number }
  | { kind: "scale"; x: number; y: number; factor: number }
  | { kind: "zoom"; by: number }
  | { kind: "recentre" }
  | { kind: "click"; x: number; y: number };
