import ExpoModulesCore

// The car's screen for the JS side (docs/CARPLAY-SPEC.md §4): what it shows, sent by the car session
// (src/components/car-screen/car-session.ts, the same as Android Auto's), and what the driver did there, as
// `onCarAction`; `onConnect` when the driver first opens the app on CarPlay, so a session starts. Every function that touches the
// templates runs on the main queue, where CarPlaySession lives.

struct CarStepRecord: Record {
  @Field var id: String = ""
  @Field var kind: String = ""
  @Field var exit: Int?
  @Field var instruction: String = ""
  @Field var distanceM: Double = 0
  @Field var timeS: Double = 0
  @Field var shownDistance: Double = 0
  @Field var shownUnit: String = "m"
}

struct CarAlternativeRecord: Record {
  @Field var index: Int = 0
  @Field var title: String = ""
  @Field var detail: String = ""
}

struct CarRouteRecord: Record {
  @Field var status: String = "planning"
  @Field var message: String?
  @Field var destinationName: String = ""
  @Field var destinationLat: Double = 0
  @Field var destinationLon: Double = 0
  @Field var replanning: Bool = false
  @Field var quiet: Bool = false
  @Field var steps: [CarStepRecord] = []
  @Field var remainingM: Double = 0
  @Field var remainingS: Double = 0
  @Field var remainingShown: Double = 0
  @Field var remainingUnit: String = "m"
  @Field var title: String = ""
  @Field var detail: String = ""
  @Field var alternatives: [CarAlternativeRecord] = []
}

struct CarPlaceRecord: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var detail: String?
  @Field var kind: String = "recent"
}

struct CarSearchRecord: Record {
  @Field var query: String = ""
  @Field var results: [CarPlaceRecord] = []
}

struct CarLabelsRecord: Record {
  @Field var destinations: String = ""
  @Field var saved: String = ""
  @Field var recent: String = ""
  @Field var noDestinations: String = ""
  @Field var search: String = ""
  @Field var searchHint: String = ""
  @Field var noResults: String = ""
  @Field var routes: String = ""
  @Field var thisRoute: String = ""
  @Field var cancel: String = ""
  @Field var close: String = ""
}

struct CarNoticeRecord: Record {
  @Field var kind: String = ""
  @Field var title: String = ""
  @Field var text: String = ""
  @Field var action: String = ""
}

struct CarCameraRecord: Record {
  @Field var id: Int = 0
  @Field var title: String = ""
  @Field var line: String?
  @Field var limitKph: Int?
  @Field var slowDown: Bool = false
}

/** Android Auto's payload (`CarSpeedPayload`): CarPlay takes the camera; the speed is its map root's to draw. */
struct CarSpeedRecord: Record {
  @Field var camera: CarCameraRecord?
}

public class CarPlayModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CarPlay")

    Events("onConnect", "onCarAction", "onMapGesture")

    // Made with each JS runtime: the car's map waits for one, and is made again on a reload's; this runtime's car
    // session listens from now.
    OnCreate {
      DispatchQueue.main.async {
        CarPlaySession.shared.listen(self) { [weak self] event, body in self?.sendEvent(event, body) }
        CarPlaySession.shared.reactNativeStarted()
      }
    }

    OnDestroy {
      DispatchQueue.main.async { CarPlaySession.shared.listen(self, nil) }
    }

    /** The car session is open: the driver opened the app on CarPlay since its scene connected. */
    Function("isConnected") { CarPlaySession.shared.isOpen }

    AsyncFunction("setLabels") { (labels: CarLabelsRecord) in
      let d = CarLabels()
      let or = { (value: String, fallback: String) in value.isEmpty ? fallback : value }
      CarPlaySession.shared.setLabels(
        CarLabels(
          destinations: or(labels.destinations, d.destinations),
          saved: or(labels.saved, d.saved), recent: or(labels.recent, d.recent),
          noDestinations: or(labels.noDestinations, d.noDestinations), search: or(labels.search, d.search),
          searchHint: or(labels.searchHint, d.searchHint), noResults: or(labels.noResults, d.noResults),
          routes: or(labels.routes, d.routes),
          thisRoute: or(labels.thisRoute, d.thisRoute), cancel: or(labels.cancel, d.cancel), close: or(labels.close, d.close)))
    }.runOnQueue(.main)

    /** The route to show, or null: none. */
    AsyncFunction("setRoute") { (route: CarRouteRecord?) in
      CarPlaySession.shared.setRoute(
        route.map { r in
          CarRoute(
            status: r.status, message: r.message, destinationName: r.destinationName, destinationLat: r.destinationLat,
            destinationLon: r.destinationLon, replanning: r.replanning, quiet: r.quiet,
            steps: r.steps.map {
              CarStep(
                id: $0.id, kind: $0.kind, exit: $0.exit, instruction: $0.instruction, distanceM: $0.distanceM,
                timeS: $0.timeS, shownDistance: $0.shownDistance, shownUnit: $0.shownUnit)
            },
            remainingM: r.remainingM, remainingS: r.remainingS, remainingShown: r.remainingShown,
            remainingUnit: r.remainingUnit, title: r.title, detail: r.detail,
            alternatives: r.alternatives.map { CarAlternative(index: $0.index, title: $0.title, detail: $0.detail) })
        })
    }.runOnQueue(.main)

    AsyncFunction("setPlaces") { (places: [CarPlaceRecord]) in
      CarPlaySession.shared.setPlaces(places.map(Self.place))
    }.runOnQueue(.main)

    /** Muted or not; null: no voice, no button. */
    AsyncFunction("setVoiceMuted") { (muted: Bool?) in
      CarPlaySession.shared.setVoiceMuted(muted)
    }.runOnQueue(.main)

    /** The recentre button: shown while the driver has moved the car's map or zoomed it from the follow zoom. */
    AsyncFunction("setRecentre") { (shown: Bool) in
      CarPlaySession.shared.setRecentre(shown)
    }.runOnQueue(.main)

    /** What the driver must do first (`location`, `held-route`), in an alert over the map; null: nothing. */
    AsyncFunction("setNotice") { (notice: CarNoticeRecord?) in
      CarPlaySession.shared.setNotice(
        notice.map { CarNotice(kind: $0.kind, title: $0.title, text: $0.text, action: $0.action) })
    }.runOnQueue(.main)

    /** The speed camera ahead, as an alert over the map; null: none. */
    AsyncFunction("setSpeed") { (speed: CarSpeedRecord?) in
      CarPlaySession.shared.setCamera(
        speed?.camera.map {
          CarCamera(id: $0.id, title: $0.title, line: $0.line, limitKph: $0.limitKph, slowDown: $0.slowDown)
        })
    }.runOnQueue(.main)

    /** What the search's text found; null: nothing searched. */
    AsyncFunction("setSearch") { (search: CarSearchRecord?) in
      CarPlaySession.shared.setSearch(search.map { CarSearch(query: $0.query, results: $0.results.map(Self.place)) })
    }.runOnQueue(.main)

    /** The answers to `query` in a list over the map (after `setSearch` with them). */
    AsyncFunction("openSearch") { (query: String) in
      CarPlaySession.shared.openSearch(query)
    }.runOnQueue(.main)

    /** The map, with a list or the search open over it gone (a place asked for is gone to). */
    AsyncFunction("showMap") {
      CarPlaySession.shared.showMapTemplate()
    }.runOnQueue(.main)

    /** A place asked for while CarPlay shows the app, once: `{ navigate, uri }`, or null. */
    AsyncFunction("takeRequest") { () -> [String: Any]? in
      CarPlaySession.shared.takeRequest()
    }.runOnQueue(.main)

    /** The native side's notes since the last call, for the trip log (`problem`: reported too). */
    AsyncFunction("takeNotes") { () -> [[String: Any]] in
      CarPlaySession.shared.takeNotes()
    }.runOnQueue(.main)
  }

  private static func place(_ r: CarPlaceRecord) -> CarPlace {
    CarPlace(id: r.id, title: r.title, detail: r.detail, kind: r.kind)
  }
}
