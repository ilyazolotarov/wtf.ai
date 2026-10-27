import Foundation

// What CarPlay's templates show of the car session's state (docs/CARPLAY-SPEC.md §4), decided without CarPlay's
// classes: the JS side's payloads in (src/components/car-screen/car-types.ts, the same as Android Auto's), the trip's
// steps, the buttons, the turn banners and the gestures out. CarPlaySession turns them into templates. Foundation only,
// unit-tested with SwiftPM (Package.swift at the repo root); Android Auto's counterpart is CarGuidanceLogic.kt.

/** One maneuver ahead, as the JS side sends it (`CarStepPayload`). */
struct CarStep: Equatable {
  /** The same maneuver on the road keeps it across plans (`carManeuverId`): its banner pops up once. */
  var id: String
  /** The app's maneuver kind (src/nav/routing/maneuvers.ts). */
  var kind: String
  /** Roundabouts: the exit to take, 1-based. */
  var exit: Int?
  /** "Turn left", in the app's language. */
  var instruction: String
  /** From the car, m, and the time to it at the plan's pace, s. */
  var distanceM: Double
  var timeS: Double
  /** The distance from the car as the phone's banner rounds it: a value and "m", "km" or "km1" (one decimal). */
  var shownDistance: Double
  var shownUnit: String
}

/** The route as the car's screen shows it (`CarRoutePayload`). */
struct CarRoute: Equatable {
  /** `planning`, `active`, `arrived` or `failed`. */
  var status: String
  /** What the screen says instead of a maneuver: planning (again), a failure, arrival. */
  var message: String?
  var destinationName: String
  var destinationLat: Double
  var destinationLon: Double
  /** Planning again after leaving the route: the old maneuvers are no guide meanwhile. */
  var replanning: Bool
  /** The driver keeps to their own way: the route shows, nothing pops up until they follow it. */
  var quiet: Bool
  /** The next maneuver, and the one after when it follows closely. */
  var steps: [CarStep]
  var remainingM: Double
  var remainingS: Double
  var remainingShown: Double
  var remainingUnit: String
  /** The routes list's row for the route followed: the street it goes by (empty: "This route"); its time and distance. */
  var title: String = ""
  var detail: String = ""
  /** The other ways to the destination (ROUTING-SPEC §8.7), to choose from. */
  var alternatives: [CarAlternative] = []
}

/** Another way to the destination: `index` in the route's alternatives; the street it goes by, else its time; more. */
struct CarAlternative: Equatable {
  var index: Int
  var title: String
  var detail: String
}

/** A destination to pick: a saved place, a recent one, or a search result (`result`). */
struct CarPlace: Equatable {
  var id: String
  var title: String
  var detail: String?
  var kind: String
}

/** What the car's search found (the JS side's offline search), and the text it answers. */
struct CarSearch: Equatable {
  var query: String
  var results: [CarPlace]
}

/** The car's own words, in the app's language (the JS side's strings; English until it sends them). */
struct CarLabels: Equatable {
  var destinations = "Destinations"
  var saved = "Saved"
  var recent = "Recent"
  var noDestinations = "Saved places and recent destinations from your phone will appear here."
  var search = "Search"
  var searchHint = "Search addresses and places"
  var noResults = "Nothing found in the downloaded region"
  /** Shown when the car sends the driver to the phone (the permission dialog). */
  var checkPhone = "Check your phone only when it's safe."
  var routes = "Routes"
  var thisRoute = "This route"
  var cancel = "Cancel"
  var close = "Close"
}

/**
 * What the driver must do before the car can guide (the JS side decides when): `location`, the app has no location
 * permission (its button asks for it); `held-route`, a route picked without an adapter waits for the driver's word (its
 * button gives it, the cancel button drops the route).
 */
struct CarNotice: Equatable {
  var kind: String
  var title: String
  var text: String
  var action: String

  static let location = "location"
  static let heldRoute = "held-route"
}

/** A maneuver as CarPlay's `CPManeuverType` knows it, and the app's icon for it. */
enum CarManeuverKind: Equatable {
  case depart, straight, slightLeft, slightRight, left, right, sharpLeft, sharpRight, keepLeft, keepRight, uTurn
  /** Counter-clockwise: traffic drives on the right, as everywhere the app has maps. */
  case roundabout
  case arrive

  /** The phone banner's icons (MANEUVER_ICON), drawn by scripts/car-icons.py into the module's asset catalog. */
  var icon: String {
    switch self {
    case .depart, .straight: return "car_straight"
    case .slightLeft: return "car_turn_slight_left"
    case .slightRight: return "car_turn_slight_right"
    case .left: return "car_turn_left"
    case .right: return "car_turn_right"
    case .sharpLeft: return "car_turn_sharp_left"
    case .sharpRight: return "car_turn_sharp_right"
    case .keepLeft: return "car_fork_left"
    case .keepRight: return "car_fork_right"
    case .uTurn: return "car_u_turn_left"
    case .roundabout: return "car_roundabout_left"
    case .arrive: return "car_flag"
    }
  }
}

/** The trip's guidance panel: what the navigation session shows now. */
enum CarTripShows: Equatable {
  /** No trip. */
  case none
  /** Planned, or planned again after leaving the route (`rerouting`): the panel waits. */
  case loading(rerouting: Bool)
  /** The next maneuvers and the estimates. */
  case steps
  /** At the destination. */
  case arrived
}

/** What the navigation session is told for a new route state. */
struct CarTripPlan: Equatable {
  enum End: Equatable { case finish, cancel }
  /** The trip shown ends first: arrived (`finish`), or stopped, failed or another destination (`cancel`). */
  var end: End?
  /** A trip starts for the route's destination (`CarPlayLogic.tripKey`). */
  var start: String?
  var shows: CarTripShows
}

/** The search list for the text typed now. */
enum CarSearchList: Equatable {
  /** Nothing typed: the destinations. */
  case empty
  /** Typed, not answered yet. */
  case loading
  /** The answer (empty: nothing found). */
  case results([CarPlace])
}

/** The map template's navigation bar buttons. */
enum CarBarButton: Equatable {
  case destinations, search, endRoute, routes
  case voice(muted: Bool)
  /** Leaves the panning interface (cars with a knob or a touchpad). */
  case endPanning
}

/** The map's own buttons on the right, top to bottom (CarPlay shows four at most). */
enum CarMapButton: Equatable {
  case pan, recentre, zoomIn, zoomOut
}

enum CarPlayLogic {
  /**
   * The car's map is drawn this many times bigger than the car's points. CarPlay's points are made for the car's screen
   * (its own text is in them), unlike Android Auto's dp, which its map multiplies by `MAP_SCALE`: 1.4 here looked
   * zoomed in, little of the map on a small screen. Kept as a knob: CarPlayMapController and the gestures follow it.
   */
  static let mapScale = 1.0

  static func maneuverKind(_ kind: String) -> CarManeuverKind {
    switch kind {
    case "depart": return .depart
    case "slight-left": return .slightLeft
    case "slight-right": return .slightRight
    case "left": return .left
    case "right": return .right
    case "sharp-left": return .sharpLeft
    case "sharp-right": return .sharpRight
    case "keep-left": return .keepLeft
    case "keep-right": return .keepRight
    case "u-turn": return .uTurn
    case "roundabout": return .roundabout
    case "arrive": return .arrive
    default: return .straight
    }
  }

  /** A distance as the phone's banner rounds it, for CarPlay to write in the car's language: km, or m. */
  static func distance(_ shown: Double, unit: String) -> (value: Double, kilometers: Bool) {
    (max(0, shown), unit == "km" || unit == "km1")
  }

  /**
   * A distance rounded as the phone's banner rounds it (`carDistance` in car-guidance.ts): 10 m under 300 m, 50 m under
   * 1 km, then 0.1 km, whole kilometres from 100 km. For the gap between two maneuvers, which the JS side doesn't send.
   */
  static func shownDistance(_ meters: Double) -> (value: Double, kilometers: Bool) {
    let m = max(0, meters)
    if m < 300 { return ((m / 10).rounded() * 10, false) }
    if m < 1000 { return ((m / 50).rounded() * 50, false) }
    if m < 100_000 { return ((m / 100).rounded() / 10, true) }
    return ((m / 1000).rounded(), true)
  }

  /** The car navigates while a route is planned, followed or arrived at; a failed plan or no route ends it. */
  static func navigating(_ route: CarRoute?) -> Bool {
    guard let route else { return false }
    return route.status == "planning" || route.status == "active" || route.status == "arrived"
  }

  /** Turn-by-turn shows only on a followed route with a maneuver ahead, not while it is planned again. */
  static func showsSteps(_ route: CarRoute?) -> Bool {
    guard let route else { return false }
    return route.status == "active" && !route.replanning && !route.steps.isEmpty
  }

  /** A trip per destination: a re-plan or an alternative to the same one is the same trip. */
  static func tripKey(_ route: CarRoute) -> String {
    String(format: "%.6f,%.6f", route.destinationLat, route.destinationLon)
  }

  /**
   * The navigation session for a new route state, given the trip shown (`current`, its key) and whether it arrived.
   * Arrival keeps the trip, paused, until the route goes: CarPlay says so in the panel. A failed plan cancels it
   * (an alert says why).
   */
  static func tripPlan(current: String?, arrived: Bool, route: CarRoute?) -> CarTripPlan {
    let ending: CarTripPlan.End? = current == nil ? nil : arrived ? .finish : .cancel
    guard let route, navigating(route) else { return CarTripPlan(end: ending, start: nil, shows: .none) }
    let key = tripKey(route)
    let same = current == key
    let shows: CarTripShows
    if route.status == "arrived" {
      shows = .arrived
    } else if showsSteps(route) {
      shows = .steps
    } else {
      shows = .loading(rerouting: route.replanning)
    }
    // Back on the way after arriving (a new route to the same place): a trip of its own.
    let again = same && arrived && route.status != "arrived"
    if same && !again { return CarTripPlan(end: nil, start: nil, shows: shows) }
    return CarTripPlan(end: ending, start: key, shows: shows)
  }

  /**
   * A maneuver pops up within this distance, m, or this time at the plan's pace, s: about when the voice first says it
   * (ROUTING-SPEC §8.5), as on Android Auto (`CarGuidanceLogic.ALERT_M`, `ALERT_S`).
   */
  static let alertM = 300.0
  static let alertS = 20.0

  /**
   * The maneuver whose banner may pop up now (`CarStep.id`), while another app fills CarPlay's screen; nil: none.
   * `alerted`: the one popped up for last. The departure doesn't (the driver has just started), nor anything while the
   * driver keeps to their own way, as the voice says nothing (Android Auto's rule, `CarGuidanceLogic.turnNotification`).
   */
  static func turnAlert(_ route: CarRoute?, alerted: String?) -> String? {
    guard let route, showsSteps(route), let step = route.steps.first else { return nil }
    let near = step.distanceM <= alertM || step.timeS <= alertS
    guard near, step.id != alerted, step.kind != "depart", !route.quiet else { return nil }
    return step.id
  }

  /** The maneuver is made within this distance, m, or this time, s (CarPlay's metadata for the car's cluster). */
  static let executeM = 50.0
  static let executeS = 5.0

  /**
   * The next maneuver's state for the car's own displays (`CPManeuverState`: continue 0, prepare 2, execute 3): being
   * made, coming near (as close as its banner pops up), or still ahead.
   */
  static func maneuverState(_ step: CarStep) -> Int {
    if step.distanceM <= executeM || step.timeS <= executeS { return 3 }
    if step.distanceM <= alertM || step.timeS <= alertS { return 2 }
    return 0
  }

  /**
   * The maneuvers as sent to the navigation session, by what makes them new to CarPlay: other steps ahead, or the next
   * one coming near enough to pop up (CarPlay asks about a banner only for maneuvers it is given).
   */
  static func maneuversKey(_ route: CarRoute, alert: String?) -> String {
    route.steps.map(\.id).joined(separator: "|") + "!" + (alert ?? "")
  }

  /** The results shown answer the text typed (an older text's would mislead); none yet while it is searched. */
  static func searchList(_ search: CarSearch?, typed: String) -> CarSearchList {
    let text = typed.trimmingCharacters(in: .whitespaces)
    if text.isEmpty { return .empty }
    guard let search, search.query.trimmingCharacters(in: .whitespaces) == text else { return .loading }
    return .results(search.results)
  }

  /** The routes button: while the route is followed with other ways to choose from (not while planned again). */
  static func showsRoutes(_ route: CarRoute?) -> Bool {
    guard let route else { return false }
    return showsSteps(route) && !route.alternatives.isEmpty
  }

  /**
   * The navigation bar (two buttons a side), kept small over the map: without a route, the destinations and search on
   * the left; with one, the routes there while there are others to choose. On the right the voice, but under a notice
   * (no route to speak, its alert takes the driver's attention), and left of it the X that stops guidance. While
   * panning, only the button that ends it. The bar hides with the map's buttons while nobody touches the screen; while
   * it shows, CarPlay sets the guidance card below its row, buttons in it or not.
   */
  static func barButtons(route: CarRoute?, notice: CarNotice?, voiceMuted: Bool?, panning: Bool) -> (leading: [CarBarButton], trailing: [CarBarButton]) {
    if panning { return ([.endPanning], []) }
    let leading: [CarBarButton] = route == nil ? [.destinations, .search] : showsRoutes(route) ? [.routes] : []
    // CarPlay puts the first of them rightmost.
    var trailing: [CarBarButton] = []
    if notice == nil, let muted = voiceMuted { trailing.append(.voice(muted: muted)) }
    if route != nil { trailing.append(.endRoute) }
    return (leading, trailing)
  }

  /** Pan (CarPlay's panning interface, for cars without a touch screen), recentre while it applies, zoom in and out. */
  static func mapButtons(recentre: Bool) -> [CarMapButton] {
    recentre ? [.pan, .recentre, .zoomIn, .zoomOut] : [.pan, .zoomIn, .zoomOut]
  }

  /** A pan gesture's change since the last, as the distance the finger went back (Android Auto's scroll). */
  static func scroll(from last: (x: Double, y: Double), to translation: (x: Double, y: Double)) -> (dx: Double, dy: Double) {
    (last.x - translation.x, last.y - translation.y)
  }

  /** How far one press of the panning interface's arrows moves the map, points. */
  static let panStep = 120.0

  /**
   * The panning interface's arrows (`CPPanDirection`: left 1, right 2, up 4, down 8) as a scroll: the map shows more of
   * that side, as a finger dragging the other way would.
   */
  static func panScroll(direction: Int) -> (dx: Double, dy: Double) {
    var dx = 0.0
    var dy = 0.0
    if direction & 1 != 0 { dx -= panStep }
    if direction & 2 != 0 { dx += panStep }
    if direction & 4 != 0 { dy -= panStep }
    if direction & 8 != 0 { dy += panStep }
    return (dx, dy)
  }

  /** A pinch's change since the last, from its scale since it began (Android Auto's `onScale` factor). */
  static func zoomFactor(from last: Double, to scale: Double) -> Double {
    guard last > 0, scale > 0 else { return 1 }
    return scale / last
  }
}
