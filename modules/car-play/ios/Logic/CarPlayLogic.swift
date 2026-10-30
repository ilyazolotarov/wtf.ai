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
  var routes = "Routes"
  var thisRoute = "This route"
  var cancel = "Cancel"
  var close = "Close"
}

/**
 * What the driver must do before the car can guide (the JS side decides when): `no-map`, no offline map is installed
 * (the condition only: nothing on the car's screen downloads one); `location`, the app has no location permission (its
 * button asks for it); `held-route`, a route picked without an adapter waits for the driver's word (its button gives
 * it, the cancel button drops the route).
 */
struct CarNotice: Equatable {
  var kind: String
  var title: String
  var text: String
  var action: String

  static let noMap = "no-map"
  static let location = "location"
  static let heldRoute = "held-route"
}

/**
 * A speed camera ahead (UI-SPEC §6.5), as the JS side sends it (src/components/car-screen/car-guidance.ts `carSpeed`):
 * CarPlay's alert over the map.
 */
struct CarCamera: Equatable {
  var id: Int
  /** "Speed camera in 600 m"; past the driver's margin, "Slow down". */
  var title: String
  /** Past the margin: the distance; else nil. */
  var line: String?
  /** The camera's limit, the alert's image as its sign; nil: none known (the camera's glyph). */
  var limitKph: Int?
  /** Past the margin. */
  var slowDown: Bool
}

/** The camera's alert as presented: the same while this holds, its words updated in place. */
struct CarCameraAlert: Hashable {
  var id: Int
  var limitKph: Int?
  var slowDown: Bool
}

/** A notice's alert buttons. */
enum CarNoticeButtons: Equatable {
  /** Its action asks iOS for location. */
  case allow
  /** The driver's word for a held route, or Cancel. */
  case confirmOrCancel
  /** Only Close: the condition said, nothing on the car's screen changes it. */
  case close
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

/** The map template's navigation bar buttons: without a route, and while panning. */
enum CarBarButton: Equatable {
  case destinations, search
  case voice(muted: Bool)
  /** Leaves the panning interface (cars with a knob or a touchpad). */
  case endPanning
}

/** The map's own buttons on the right, top to bottom (CarPlay shows four at most). */
enum CarMapButton: Equatable {
  case pan, recentre, zoomIn, zoomOut
  /** On a route: stop guidance, the voice, the other ways to choose from. */
  case endRoute, routes
  case voice(muted: Bool)
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
   * Arrival keeps the trip until the route goes: the panel says so, with the flag. A failed plan cancels it
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
   * A trip starts at least this long after the one before it ended, s. CarPlay ends a trip outside the app: one started
   * in the same turn as the last one ended found that one still active, and CarPlay ended the app (2026-10-30: the
   * car's screen came on again with the last session's arrived route, then the phone's route to another place came).
   */
  static let tripRestartS = 1.0

  /** How long a trip waits to start, s (0: now), given when the last one ended (nil: none did) and the time now. */
  static func tripStartWait(endedAt: Double?, now: Double) -> Double {
    guard let endedAt else { return 0 }
    return max(0, tripRestartS - (now - endedAt))
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

  /**
   * Estimates as CarPlay shows them: the distance as rounded, the time in whole minutes. Apple's guide asks for updates
   * only when they change, not with every position.
   */
  static func estimatesKey(_ shown: Double, _ unit: String, _ seconds: Double) -> String {
    let d = distance(shown, unit: unit)
    return "\(d.value)\(d.kilometers ? "km" : "m") \(Int((max(0, seconds) / 60).rounded()))"
  }

  /**
   * A notice's buttons: location asks while iOS can (`canAsk`: it never has), else only closes, as no map does; a held
   * route takes the driver's word or is dropped.
   */
  static func noticeButtons(_ notice: CarNotice, canAsk: Bool) -> CarNoticeButtons {
    switch notice.kind {
    case CarNotice.location: return canAsk ? .allow : .close
    case CarNotice.heldRoute: return .confirmOrCancel
    default: return .close
    }
  }

  /**
   * Closed by CarPlay's own x, the notice stays closed (as by its Close) unless it asks something of the driver: the
   * location alert comes back until location is allowed, a held route until the driver decides.
   */
  static func closedByCarPlaysX(_ notice: CarNotice, canAsk: Bool) -> Bool {
    noticeButtons(notice, canAsk: canAsk) == .close
  }

  /**
   * The camera's alert: the camera ahead, unless the driver closed this alert (not again while the car is
   * connected). The same camera, sign and red is the same alert, its words updated as the distance counts down
   * (`updateTitleVariants`); another camera or sign is another alert (its image can't be updated), and so is "Slow
   * down": a subtitle given to an alert made without one never shows (iOS 26.3), and a warning sliding in is news.
   * "Slow down" comes after a far alert closed: the voice speaks once, as the camera is first in sight.
   */
  static func cameraAlert(_ camera: CarCamera?, closed: Set<CarCameraAlert>) -> CarCameraAlert? {
    guard let camera else { return nil }
    let alert = CarCameraAlert(id: camera.id, limitKph: camera.limitKph, slowDown: camera.slowDown)
    return closed.contains(alert) ? nil : alert
  }

  /** The camera alert's words: "Speed camera in 600 m"; past the margin "Slow down", the distance under it. */
  static func cameraWords(_ camera: CarCamera) -> (titles: [String], subtitles: [String]) {
    ([camera.title], camera.line.map { [$0] } ?? [])
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
   * The navigation bar (two buttons a side), without a route: the destinations and search on the left, the voice on
   * the right, but under a notice (no route to speak, its alert takes the driver's attention). While it shows (some
   * seconds after a touch) CarPlay sets the guidance card below its row, buttons in it or not: on a route it stays
   * empty, and the map's buttons hold what it held. While panning, only the X that ends it, on the right: the map's
   * buttons there show only as many as fit beside the panning arrows (two on a 400×240 pt screen), and CarPlay keeps
   * the arrows below the bar's row, empty or not. No search while the car allows no keyboard (`keyboard` false: many
   * do while driving): the destinations are the way then.
   */
  static func barButtons(
    route: CarRoute?, notice: CarNotice?, voiceMuted: Bool?, panning: Bool, keyboard: Bool = true
  ) -> (leading: [CarBarButton], trailing: [CarBarButton]) {
    if panning { return ([], [.endPanning]) }
    if route != nil { return ([], []) }
    let leading: [CarBarButton] = keyboard ? [.destinations, .search] : [.destinations]
    guard notice == nil, let muted = voiceMuted else { return (leading, []) }
    return (leading, [.voice(muted: muted)])
  }

  /**
   * The map's buttons. Without a route: pan (CarPlay's panning interface, for cars without a touch screen), recentre
   * while it applies, zoom in and out. On a route, what the bar held: the X that stops guidance, the voice (not under a
   * notice), the routes while there are others to choose; then pan, or recentre in its place while it applies (the
   * overview of a new route's alternatives, a look around). Zooming is the panning interface's then. While panning,
   * zoom in and out: CarPlay shows the last two beside its arrows.
   */
  static func mapButtons(route: CarRoute?, notice: CarNotice?, voiceMuted: Bool?, panning: Bool, recentre: Bool) -> [CarMapButton] {
    if panning { return [.zoomIn, .zoomOut] }
    guard route != nil else { return recentre ? [.pan, .recentre, .zoomIn, .zoomOut] : [.pan, .zoomIn, .zoomOut] }
    var buttons: [CarMapButton] = [.endRoute]
    if notice == nil, let muted = voiceMuted { buttons.append(.voice(muted: muted)) }
    if showsRoutes(route) { buttons.append(.routes) }
    buttons.append(recentre ? .recentre : .pan)
    return buttons
  }

  /**
   * The map's buttons stay while the bar hides, on a route: the driver reaches them without touching the map, and the
   * bar, with the guidance card moved down below it, shows only for a touch on the map itself. Without a route they go
   * with the bar: there is no card to move, and the map is whole.
   */
  static func buttonsStay(route: CarRoute?) -> Bool {
    route != nil
  }

  /**
   * The follow zoom moved for the car's screen, levels: as much road per pixel as Android Auto shows (its map keeps
   * the phone's follow zoom per density-independent pixel, about one of the car's pixels), not per CarPlay point, which
   * is two or three of them. At the phone's zoom a 400×240 pt screen showed 150 m across, the road ahead within a block.
   */
  static func followZoomShift(screenScale: Double) -> Double {
    -log2(max(1, screenScale))
  }

  /**
   * The map's buttons' column, points from the screen's right edge: CarPlay's safe area ends there whether the
   * buttons show or not (iOS 26.3, 400×240 pt).
   */
  static let mapButtonColumn = 40.0

  /**
   * The speed's pill's room on the right, points, in the corner above the map's buttons, which CarPlay stacks from the
   * bottom: out of the buttons' column, beside anything else there (a right-hand drive car's dock). `right`: the safe
   * area's right inset or the buttons' layout guide, whichever is more. (While the bar shows the pill is at the bottom
   * left: CarMapRoot.)
   */
  static func speedRight(right: Double) -> Double {
    max(0, right - mapButtonColumn)
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
