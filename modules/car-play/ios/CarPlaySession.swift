import CarPlay
import CoreLocation
import MapKit
import os

/** The car's screen coming and going, and what drew its map: in the device log (CARPLAY-SPEC §5). */
let carPlayLog = Logger(subsystem: "ai.wtf.navigator", category: "carplay")

/**
 * The car's screen (docs/CARPLAY-SPEC.md §4): what the car session's JS side last sent through CarPlayModule, drawn
 * with CarPlay's templates while its scene is connected, and what the driver does there, sent back as the module's
 * events. The scene and the JS runtime come and go independently, so what was sent is kept for whichever comes next,
 * as Android Auto's CarLink keeps it. Main thread only, but for `isOpen`.
 */
final class CarPlaySession: NSObject {
  static let shared = CarPlaySession()

  /** The JS root of the car's map (index.ts). */
  static let moduleName = "CarPlayMap"

  /** Notes kept for the JS side at most: the oldest go first. */
  private static let maxNotes = 50

  // What the JS side sent.
  private var labels = CarLabels()
  private var route: CarRoute?
  private var places: [CarPlace] = []
  /** Spoken guidance: muted or not; nil: no voice (its volume is 0), no button. */
  private var voiceMuted: Bool?
  private var recentre = false
  private var notice: CarNotice?
  private var search: CarSearch?
  /** The speed camera ahead: its alert over the map. */
  private var camera: CarCamera?

  /** The JS side's listener (CarPlayModule's events) and the module it is from; nil while no runtime has the module. */
  private var emit: ((String, [String: Any]) -> Void)?
  private var emitter: ObjectIdentifier?
  private var notes: [(text: String, problem: Bool)] = []
  /** A place asked for (a `geo:` link to the car's scene), kept until the JS side takes it. */
  private var request: (navigate: Bool, uri: String)?

  /**
   * The car session is open: the driver opened the app on the car's screen since its scene connected, until it
   * disconnects (Android Auto's session, made when the app is opened there). Read on the JS thread too.
   */
  private let openLock = NSLock()
  private var openFlag = false
  var isOpen: Bool {
    openLock.lock()
    defer { openLock.unlock() }
    return openFlag
  }

  // The connected scene's.
  private var scene: CPTemplateApplicationScene?
  private var interfaceController: CPInterfaceController?
  private var window: CPWindow?
  private var mapTemplate: CPMapTemplate?
  private var mapView: UIView?
  /** The React Native host the map's root was made on. */
  private weak var mapHost: AnyObject?
  private var leading: [CarBarButton] = []
  private var trailing: [CarBarButton] = []
  private var shownMapButtons: [CarMapButton] = []
  private var panning = false
  /** The car allows no keyboard now (many while driving): `CPSessionConfiguration`. */
  private var keyboardLimited = false
  private var sessionConfiguration: CPSessionConfiguration?
  private var panFrom = (x: 0.0, y: 0.0)
  private var zoomFrom = 1.0

  // The trip.
  private var navigation: CPNavigationSession?
  /** The destination of the trip shown (`CarPlayLogic.tripKey`), and what its panel shows. */
  private var tripKey: String?
  private var tripShows = CarTripShows.none
  private var maneuversKey: String?
  private var maneuvers: [CPManeuver] = []
  /** The estimates last sent, as CarPlay shows them: sent again only when that changes (Apple's guide). */
  private var stepEstimatesKey: String?
  private var tripEstimatesKey: String?
  /** The maneuver popped up for last, and the one CarPlay may pop up now (`CarPlayLogic.turnAlert`). */
  private var alerted: String?
  private var alertDue: String?

  // The alert over the map: a speed camera ahead, a notice, or why the route failed.
  private enum AlertContent: Equatable {
    /** Its words are updated in place as the camera comes nearer (`camera`). */
    case camera(CarCameraAlert)
    /** `canAsk`: iOS can still ask for location (never asked); else only the phone's Settings allow it. */
    case notice(CarNotice, canAsk: Bool)
    case failure(message: String, destination: String)
  }
  /** What the alert over the map shows, or is about to (nil: none). */
  private var alertShown: AlertContent?
  /** The alert presented, and what it shows: CarPlay's own (x) closes it without its action. */
  private weak var alertPresented: CPNavigationAlert?
  private var alertPresentedContent: AlertContent? {
    // Whether the camera's sign is up: the map's pill shows its own or none.
    didSet { if alertPresentedContent != oldValue { updateMapProps() } }
  }
  /** A failure the driver closed: not shown again. */
  private var failureClosed: AlertContent?
  /** A location notice the driver closed (iOS can't ask any more): not shown again until another notice. */
  private var noticeClosed: CarNotice?
  /** The camera alerts the driver closed while the car is connected: not shown again ("Slow down" after one still is). */
  private var camerasClosed: Set<CarCameraAlert> = []
  /** The location notice's button asked iOS: its answer goes to the session. */
  private var askedLocation = false
  /** iOS's location permission as last seen: a change redraws the alert's button. */
  private var authorization: CLAuthorizationStatus?

  // Lists and the search over the map, while open.
  private weak var destinationsList: CPListTemplate?
  private weak var routesList: CPListTemplate?
  private weak var resultsList: CPListTemplate?
  private var resultsQuery = ""
  private weak var searchTemplate: CPSearchTemplate?
  private var typed = ""
  private var searchCompletion: (([CPListItem]) -> Void)?

  private var locationManager: CLLocationManager?

  // MARK: - The scene

  func connect(_ scene: CPTemplateApplicationScene, _ controller: CPInterfaceController, window: CPWindow) {
    let states = ["unattached", "foreground active", "foreground inactive", "background"]
    let state = states.indices.contains(scene.activationState.rawValue + 1) ? states[scene.activationState.rawValue + 1] : "?"
    carPlayLog.notice("CarPlay scene connected (\(state, privacy: .public))")
    self.scene = scene
    interfaceController = controller
    self.window = window
    controller.delegate = self
    let configuration = CPSessionConfiguration(delegate: self)
    sessionConfiguration = configuration
    keyboardLimited = configuration.limitedUserInterfaces.contains(.keyboard)
    let template = CPMapTemplate()
    template.mapDelegate = self
    // The map is what the driver needs: the bar goes while nobody touches the screen, the buttons with it but on a
    // route (`refresh`, `CarPlayLogic.buttonsStay`).
    template.automaticallyHidesNavigationBar = true
    template.hidesButtonsWithNavigationBar = true
    mapTemplate = template
    controller.setRootTemplate(template, animated: false) { [weak self] _, error in
      if let error { self?.note("map template not shown: \(error.localizedDescription)", problem: true) }
    }
    // What the last session sent stays: a route followed when the car's screen came on again shows at once.
    syncTrip()
    refresh()
    // Opened from the car's screen: in the foreground already (else it comes there later, sceneWillEnterForeground).
    if scene.activationState == .foregroundActive || scene.activationState == .foregroundInactive { shown() }
  }

  /**
   * The car's screen shows the app. The first time since the scene connected the car session opens (CarPlay connects
   * the scene as soon as its screen comes on, whatever the driver opens there): the navigator runs and the adapter
   * connects from now until the car disconnects. The map's root is made each time: it lives only while it shows.
   */
  func shown() {
    guard window != nil else { return }
    if !isOpen {
      setOpen(true)
      note("opened on the car's screen")
      emit?("onConnect", [:])
    }
    if mapView == nil { showMap() }
    // After the scenes connecting at this launch: the phone's starts React Native as it connects.
    if !AppReactHost.isRunning {
      DispatchQueue.main.async { AppReactHost.startWithoutPhone() }
    }
  }

  /**
   * Another app fills the car's screen: the map's root goes (its frames and MapLibre's drawing for nobody, its
   * smoothing loop spinning the JS thread with the app in the background); the trip, its banners and the voice go on.
   */
  func hidden() {
    guard let window, mapView != nil else { return }
    carPlayLog.notice("CarPlay map: gone while another app shows")
    window.rootViewController = CarPlayMapController(nil, scale: CarPlayLogic.mapScale) {}
    mapView = nil
    mapHost = nil
  }

  func disconnect() {
    carPlayLog.notice("CarPlay scene disconnected")
    let wasOpen = isOpen
    setOpen(false)
    navigation?.cancelTrip()
    navigation = nil
    tripKey = nil
    tripShows = .none
    maneuversKey = nil
    maneuvers = []
    alertShown = nil
    camerasClosed = []
    searchCompletion?([])
    searchCompletion = nil
    panning = false
    sessionConfiguration = nil
    leading = []
    trailing = []
    shownMapButtons = []
    mapTemplate = nil
    // Unmounts the map's React root.
    window?.rootViewController = nil
    window = nil
    mapView = nil
    mapHost = nil
    interfaceController = nil
    scene = nil
    if wasOpen { send("session-ended") }
  }

  /** The car switched between day and night (the scene's content style). */
  func contentStyleChanged() {
    window?.backgroundColor = dark ? .black : .white
    updateMapProps()
    // The map's buttons are drawn in the day's or the night's colours.
    shownMapButtons = []
    refresh()
  }

  /**
   * A place asked for while CarPlay shows the app (a `geo:` link, or `google.navigation:` to go there), kept until the
   * JS side takes it: its session may not run yet. A newer one replaces it.
   */
  func request(_ url: URL) {
    let uri = url.absoluteString
    let scheme = url.scheme?.lowercased()
    guard scheme == "geo" || scheme == "google.navigation" else { return }
    let navigate = scheme == "google.navigation"
    note("\(navigate ? "navigation" : "search") asked for: \(uri)")
    request = (navigate, uri)
    emit?("onCarAction", ["action": "request"])
  }

  private func setOpen(_ value: Bool) {
    openLock.lock()
    openFlag = value
    openLock.unlock()
  }

  private var dark: Bool { scene?.contentStyle == .dark }

  // MARK: - The map's React root

  /**
   * A JS runtime came up (CarPlayModule's OnCreate). On a new host (the development launcher makes one at each load)
   * the map's root is made again: a root stays on the host it was made on, and the car's screen went black. A reload
   * on the same host restarts the root by itself, and making it again then too released the old one while React
   * Native's restart still held it (a debug assertion: "Surface must not be running").
   */
  func reactNativeStarted() {
    guard window != nil, scene?.activationState != .background, let host = AppReactHost.host, host !== mapHost else {
      return
    }
    carPlayLog.notice("React Native on a new host")
    showMap()
  }

  /** The React root `CarPlayMap` once React Native runs, a blank view until then. */
  private func showMap() {
    guard let window else { return }
    let react = AppReactHost.rootView(moduleName: Self.moduleName, initialProperties: mapProps())
    mapHost = react == nil ? nil : AppReactHost.host
    mapView = react
    sentMapProps = nil
    let drawnBy = react == nil ? "a blank view until React Native runs" : "the React root"
    carPlayLog.notice("CarPlay map: \(drawnBy, privacy: .public)")
    window.backgroundColor = dark ? .black : .white
    window.rootViewController = CarPlayMapController(react, scale: CarPlayLogic.mapScale) { [weak self] in
      self?.updateMapProps()
    }
  }

  /**
   * `dark`, the car's day or night; `insets`, what CarPlay's panels cover, in the map's points from each edge: the
   * window's safe area (the guidance card, the bar) and on the right the map's buttons (their layout guide), so the
   * camera keeps the car in the rest and the credit clear of them; `scale`, the map drawn bigger than the car's points
   * (CarMapRoot); `cameraSign`, the camera's alert is up with its sign, so the speed's pill shows none of its own
   * (CarSpeedPill): closed by the driver, the road's sign is back beside the speed.
   */
  private func mapProps() -> [String: Any] {
    let safe = window?.safeAreaInsets ?? .zero
    var right = safe.right
    if let window {
      let buttons = window.mapButtonSafeAreaLayoutGuide.layoutFrame
      if !buttons.isEmpty { right = max(right, window.bounds.maxX - buttons.maxX) }
    }
    let s = CarPlayLogic.mapScale
    let screenScale = window?.traitCollection.displayScale ?? 1
    return [
      "dark": dark,
      "insets": ["left": safe.left / s, "top": safe.top / s, "right": right / s, "bottom": safe.bottom / s],
      "scale": s,
      "zoom": CarPlayLogic.followZoomShift(screenScale: Double(screenScale)),
      "cameraSign": cameraSignShown,
    ]
  }

  private var cameraSignShown: Bool {
    if case .camera(let camera) = alertPresentedContent { return camera.limitKph != nil }
    return false
  }

  /** Sent again only when they changed: each is a render of the car's map. */
  private var sentMapProps: NSDictionary?

  private func updateMapProps() {
    guard let view = mapView, view.responds(to: NSSelectorFromString("setAppProperties:")) else { return }
    let props = mapProps() as NSDictionary
    guard props != sentMapProps else { return }
    sentMapProps = props
    view.setValue(props, forKey: "appProperties")
  }

  // MARK: - What the JS side sends

  func setLabels(_ value: CarLabels) {
    guard value != labels else { return }
    labels = value
    leading = []
    trailing = []
    refresh()
  }

  func setRoute(_ value: CarRoute?) {
    guard value != route else { return }
    route = value
    syncTrip()
    refresh()
  }

  func setPlaces(_ value: [CarPlace]) {
    guard value != places else { return }
    places = value
    refresh()
  }

  func setVoiceMuted(_ value: Bool?) {
    guard value != voiceMuted else { return }
    voiceMuted = value
    refresh()
  }

  func setRecentre(_ value: Bool) {
    guard value != recentre else { return }
    recentre = value
    refresh()
  }

  func setNotice(_ value: CarNotice?) {
    guard value != notice else { return }
    if value?.kind != CarNotice.location { askedLocation = false }
    if value != noticeClosed { noticeClosed = nil }
    notice = value
    refresh()
  }

  /** The speed camera ahead (UI-SPEC §6.5), or nil: none. The speed itself is the map root's (CarMapRoot). */
  func setCamera(_ value: CarCamera?) {
    guard value != camera else { return }
    camera = value
    syncAlert()
  }

  func setSearch(_ value: CarSearch?) {
    guard value != search else { return }
    search = value
    if let completion = searchCompletion, case .results = CarPlayLogic.searchList(search, typed: typed) {
      searchCompletion = nil
      completion(searchItems())
    }
    refresh()
  }

  /** The answers to a place asked for, in a list over the map (CarPlay's search template can't be given a text). */
  func openSearch(_ query: String) {
    guard interfaceController != nil else { return }
    let list = resultsTemplate(query)
    popToRoot(animated: false) { [weak self] in self?.push(list) }
  }

  /** The answers to `query` in a list, filled as they come. */
  private func resultsTemplate(_ query: String) -> CPListTemplate {
    resultsQuery = query
    let list = CPListTemplate(title: query, sections: resultsSections())
    list.emptyViewSubtitleVariants = [labels.noResults]
    resultsList = list
    return list
  }

  /** The map, with whatever list or search was open over it gone: the route to a place asked for shows. */
  func showMapTemplate() {
    popToRoot()
  }

  func takeRequest() -> [String: Any]? {
    defer { request = nil }
    return request.map { ["navigate": $0.navigate, "uri": $0.uri] }
  }

  func takeNotes() -> [[String: Any]] {
    defer { notes = [] }
    return notes.map { ["text": $0.text, "problem": $0.problem] }
  }

  /** The module of a new JS runtime listens from now; a module going only stops listening if it is the one. */
  func listen(_ module: AnyObject, _ emit: ((String, [String: Any]) -> Void)?) {
    if let emit {
      self.emit = emit
      emitter = ObjectIdentifier(module)
    } else if emitter == ObjectIdentifier(module) {
      self.emit = nil
      emitter = nil
    }
  }

  // MARK: - Sending to the JS side

  /** The driver's action on the car's screen, or the car's, for the JS side. */
  private func send(_ action: String, _ body: [String: Any] = [:]) {
    carPlayLog.info("action \(action, privacy: .public)")
    guard let emit else {
      carPlayLog.notice("no JS runtime for \(action, privacy: .public)")
      return
    }
    var event = body
    event["action"] = action
    emit("onCarAction", event)
  }

  /** The driver moved or zoomed the car's map, or pressed one of its buttons. Not logged: a drag sends one every frame. */
  private func gesture(_ body: [String: Any]) {
    emit?("onMapGesture", body)
  }

  /** A note for the trip log, kept until the JS side takes it. `problem`: what went wrong, reported too. */
  func note(_ text: String, problem: Bool = false) {
    if problem {
      carPlayLog.error("\(text, privacy: .public)")
    } else {
      carPlayLog.notice("\(text, privacy: .public)")
    }
    notes.append((text, problem))
    if notes.count > Self.maxNotes { notes.removeFirst(notes.count - Self.maxNotes) }
    emit?("onCarAction", ["action": "notes"])
  }

  // MARK: - The map template

  /** Labels, places, the route, the voice or the notice changed: the buttons, the alert and open lists follow. */
  private func refresh() {
    guard let mapTemplate else { return }
    let bar = CarPlayLogic.barButtons(
      route: route, notice: notice, voiceMuted: voiceMuted, panning: panning, keyboard: !keyboardLimited)
    if bar.leading != leading {
      leading = bar.leading
      mapTemplate.leadingNavigationBarButtons = bar.leading.map(barButton)
    }
    if bar.trailing != trailing {
      trailing = bar.trailing
      mapTemplate.trailingNavigationBarButtons = bar.trailing.map(barButton)
    }
    let buttons = CarPlayLogic.mapButtons(
      route: route, notice: notice, voiceMuted: voiceMuted, panning: panning, recentre: recentre)
    if buttons != shownMapButtons {
      shownMapButtons = buttons
      mapTemplate.mapButtons = buttons.map(mapButton)
    }
    let stay = CarPlayLogic.buttonsStay(route: route)
    if mapTemplate.hidesButtonsWithNavigationBar == stay { mapTemplate.hidesButtonsWithNavigationBar = !stay }
    syncAlert()
    destinationsList?.updateSections(destinationSections())
    routesList?.updateSections(routeSections())
    resultsList?.updateSections(resultsSections())
  }

  private func barButton(_ button: CarBarButton) -> CPBarButton {
    switch button {
    case .destinations:
      return CPBarButton(title: labels.destinations) { [weak self] _ in self?.openDestinations() }
    case .search:
      return CPBarButton(image: CarPlayImages.icon("car_search")) { [weak self] _ in
        carPlayLog.notice("search pressed")
        self?.openSearchTemplate()
      }
    case .voice(let muted):
      return CPBarButton(image: CarPlayImages.icon(muted ? "car_volume_off" : "car_volume_up")) { [weak self] _ in
        self?.send("toggle-voice")
      }
    case .endPanning:
      return CPBarButton(image: CarPlayImages.icon("car_close")) { [weak self] _ in
        self?.mapTemplate?.dismissPanningInterface(animated: true)
      }
    }
  }

  private func mapButton(_ button: CarMapButton) -> CPMapButton {
    let made: CPMapButton
    let icon: String
    switch button {
    case .pan:
      made = CPMapButton { [weak self] _ in self?.mapTemplate?.showPanningInterface(animated: true) }
      icon = "car_drag_pan"
    case .recentre:
      made = CPMapButton { [weak self] _ in self?.gesture(["kind": "recentre"]) }
      icon = "car_my_location"
    case .zoomIn:
      made = CPMapButton { [weak self] _ in self?.gesture(["kind": "zoom", "by": 1]) }
      icon = "car_add"
    case .zoomOut:
      made = CPMapButton { [weak self] _ in self?.gesture(["kind": "zoom", "by": -1]) }
      icon = "car_remove"
    // Icons, not Android Auto's words.
    case .endRoute:
      made = CPMapButton { [weak self] _ in self?.send("end-route") }
      icon = "car_close"
    case .routes:
      made = CPMapButton { [weak self] _ in self?.openRoutes() }
      icon = "car_alt_route"
    case .voice(let muted):
      made = CPMapButton { [weak self] _ in self?.send("toggle-voice") }
      icon = muted ? "car_volume_off" : "car_volume_up"
    }
    made.image = CarPlayImages.mapIcon(icon, dark ? .night : .day)
    made.focusedImage = CarPlayImages.mapIcon(icon, dark ? .focusedAtNight : .day)
    return made
  }

  // MARK: - The trip

  /** The navigation session follows the route: CarPlay's guidance panel, its banners, the car's cluster. */
  private func syncTrip() {
    guard let mapTemplate else { return }
    let plan = CarPlayLogic.tripPlan(current: tripKey, arrived: tripShows == .arrived, route: route)
    if let end = plan.end {
      if end == .finish { navigation?.finishTrip() } else { navigation?.cancelTrip() }
      navigation = nil
      tripKey = nil
      tripShows = .none
    }
    if let key = plan.start, let route {
      let destination = MKMapItem(
        placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: route.destinationLat, longitude: route.destinationLon)))
      destination.name = route.destinationName
      let choice = CPRouteChoice(
        summaryVariants: [route.detail.isEmpty ? route.destinationName : route.detail],
        additionalInformationVariants: [], selectionSummaryVariants: [])
      let trip = CPTrip(origin: MKMapItem.forCurrentLocation(), destination: destination, routeChoices: [choice])
      navigation = mapTemplate.startNavigationSession(for: trip)
      tripKey = key
      tripShows = .none
      maneuversKey = nil
      tripEstimatesKey = nil
      note("trip started")
    }
    guard let navigation, let route else { return }
    switch plan.shows {
    case .loading(let rerouting):
      if tripShows != plan.shows {
        navigation.pauseTrip(for: rerouting ? .rerouting : .loading, description: route.message)
        maneuversKey = nil
      }
    case .arrived:
      if tripShows != .arrived {
        navigation.pauseTrip(for: .arrived, description: route.message ?? route.destinationName)
        maneuversKey = nil
      }
    case .steps:
      guide(navigation, route)
    case .none:
      break
    }
    tripShows = plan.shows
  }

  /**
   * The next maneuvers, set again only when other ones are next or the next one comes near enough to pop up (CarPlay
   * asks about a banner for the maneuvers it is given); the estimates with every position.
   */
  private func guide(_ navigation: CPNavigationSession, _ route: CarRoute) {
    let alert = CarPlayLogic.turnAlert(route, alerted: alerted)
    let key = CarPlayLogic.maneuversKey(route, alert: alert)
    if key != maneuversKey {
      maneuversKey = key
      alertDue = alert
      var from = 0.0
      maneuvers = route.steps.map { step in
        let made = maneuver(step, gapM: step.distanceM - from)
        from = step.distanceM
        return made
      }
      navigation.upcomingManeuvers = maneuvers
      stepEstimatesKey = nil
    }
    if let next = maneuvers.first, let step = route.steps.first {
      let shown = CarPlayLogic.estimatesKey(step.shownDistance, step.shownUnit, step.timeS)
      if shown != stepEstimatesKey {
        stepEstimatesKey = shown
        navigation.updateEstimates(Self.estimates(step.shownDistance, step.shownUnit, step.timeS), for: next)
      }
      if #available(iOS 17.4, *) {
        let state = CPManeuverState(rawValue: CarPlayLogic.maneuverState(step)) ?? .continue
        if navigation.maneuverState != state { navigation.maneuverState = state }
      }
    }
    let left = CarPlayLogic.estimatesKey(route.remainingShown, route.remainingUnit, route.remainingS)
    if left != tripEstimatesKey {
      tripEstimatesKey = left
      mapTemplate?.updateEstimates(
        Self.estimates(route.remainingShown, route.remainingUnit, route.remainingS), for: navigation.trip)
    }
  }

  /** `gapM`: from the maneuver before (the first: from the car), which CarPlay shows with the one after. */
  private func maneuver(_ step: CarStep, gapM: Double) -> CPManeuver {
    let kind = CarPlayLogic.maneuverKind(step.kind)
    let maneuver = CPManeuver()
    maneuver.instructionVariants = [step.instruction]
    maneuver.symbolImage = CarPlayImages.icon(kind.icon, size: CarPlayImages.maneuverSize)
    let gap = CarPlayLogic.shownDistance(gapM)
    maneuver.initialTravelEstimates = Self.estimates(gap.value, gap.kilometers ? "km1" : "m", step.timeS)
    maneuver.userInfo = step.id
    if #available(iOS 17.4, *) {
      maneuver.maneuverType = Self.maneuverType(kind)
      maneuver.trafficSide = .right
      maneuver.junctionType = kind == .roundabout ? .roundabout : .intersection
    }
    return maneuver
  }

  @available(iOS 17.4, *)
  private static func maneuverType(_ kind: CarManeuverKind) -> CPManeuverType {
    switch kind {
    case .depart: return .startRoute
    case .straight: return .straightAhead
    case .slightLeft: return .slightLeftTurn
    case .slightRight: return .slightRightTurn
    case .left: return .leftTurn
    case .right: return .rightTurn
    case .sharpLeft: return .sharpLeftTurn
    case .sharpRight: return .sharpRightTurn
    case .keepLeft: return .keepLeft
    case .keepRight: return .keepRight
    case .uTurn: return .uTurn
    case .roundabout: return .enterRoundabout
    case .arrive: return .arriveAtDestination
    }
  }

  private static func estimates(_ shown: Double, _ unit: String, _ seconds: Double) -> CPTravelEstimates {
    let distance = CarPlayLogic.distance(shown, unit: unit)
    let length = Measurement(value: distance.value, unit: distance.kilometers ? UnitLength.kilometers : UnitLength.meters)
    return CPTravelEstimates(distanceRemaining: length, timeRemaining: max(0, seconds))
  }

  // MARK: - The alert: a speed camera ahead, a notice, or why the route failed

  private var alertWanted: AlertContent? {
    if let camera = CarPlayLogic.cameraAlert(camera, closed: camerasClosed) { return .camera(camera) }
    if let notice, notice != noticeClosed {
      return .notice(notice, canAsk: notice.kind != CarNotice.location || locationUndetermined)
    }
    if let route, route.status == "failed" {
      let failure = AlertContent.failure(message: route.message ?? "", destination: route.destinationName)
      return failure == failureClosed ? nil : failure
    }
    return nil
  }

  /**
   * One alert over the map at a time: a camera ahead first (it lasts seconds, and the road doesn't wait; what it took
   * down comes back after it), then a notice, as on Android Auto, where it takes the route's card.
   */
  private func syncAlert() {
    guard let mapTemplate else { return }
    let wanted = alertWanted
    guard wanted != alertShown else {
      updateCameraWords()
      return
    }
    alertShown = wanted
    // Whatever shows goes first (it calls back with `didDismiss`, which ignores an alert no longer presented).
    if mapTemplate.currentNavigationAlert != nil {
      alertPresented = nil
      alertPresentedContent = nil
      mapTemplate.dismissNavigationAlert(animated: true) { [weak self] _ in self?.presentAlert() }
    } else {
      presentAlert()
    }
  }

  /** The alert wanted now, if none is up (a dismissal still going on presents it when done). */
  private func presentAlert() {
    guard let template = mapTemplate, let wanted = alertShown, template.currentNavigationAlert == nil else { return }
    let alert = alert(wanted)
    alertPresented = alert
    alertPresentedContent = wanted
    carPlayLog.notice("alert shown")
    template.present(navigationAlert: alert, animated: true)
  }

  /**
   * The camera's alert up: its words follow the distance in place (`updateTitleVariants`), as Android Auto's card
   * counts down; a new alert would slide in again at each step.
   */
  private func updateCameraWords() {
    guard case .camera = alertPresentedContent, let alert = alertPresented, let camera else { return }
    let words = CarPlayLogic.cameraWords(camera)
    guard words.titles != alert.titleVariants || words.subtitles != alert.subtitleVariants else { return }
    alert.updateTitleVariants(words.titles, subtitleVariants: words.subtitles)
  }

  /** The driver closed a camera's alert (its x): not shown again; "Slow down" after it still is. */
  private func closeCamera(_ alert: CarCameraAlert) {
    guard camerasClosed.insert(alert).inserted else { return }
    note("camera alert closed by the driver #\(alert.id)\(alert.slowDown ? ", slow down" : "")")
  }

  private func alert(_ content: AlertContent) -> CPNavigationAlert {
    switch content {
    case .camera(let shown):
      // The phone card's words; its sign as the image (the glyph when no limit is known). No bar and no red:
      // CarPlay draws the alert, "Slow down" says it. Only CarPlay's x, until the camera is passed.
      let close = CPAlertAction(title: labels.close, style: .cancel) { [weak self] _ in self?.closeCamera(shown) }
      let words = camera.map(CarPlayLogic.cameraWords) ?? (titles: [], subtitles: [])
      let image =
        shown.limitKph.map { CarPlayImages.speedSign($0, dark: dark) }
        ?? CarPlayImages.icon("car_speed_camera", size: CarPlayImages.signSize)
      return CPNavigationAlert(
        titleVariants: words.titles, subtitleVariants: words.subtitles, image: image, primaryAction: close,
        secondaryAction: nil, duration: 0)
    case .notice(let notice, let canAsk):
      // Location refused before, or no map: nothing on the car's screen changes it, and its words may not send the
      // driver to the phone (Apple's guidelines): the alert says so and closes.
      let close = CPAlertAction(title: labels.close, style: .cancel) { [weak self] _ in self?.noticeClosed = notice }
      let primary: CPAlertAction
      var secondary: CPAlertAction?
      switch CarPlayLogic.noticeButtons(notice, canAsk: canAsk) {
      case .allow:
        primary = CPAlertAction(title: notice.action, style: .default) { [weak self] _ in self?.requestLocation() }
      case .confirmOrCancel:
        primary = CPAlertAction(title: notice.action, style: .default) { [weak self] _ in self?.send("confirm-held") }
        secondary = CPAlertAction(title: labels.cancel, style: .cancel) { [weak self] _ in self?.send("cancel-held") }
      case .close:
        primary = close
      }
      let icon = [CarNotice.location: "car_location_off", CarNotice.noMap: "car_map"][notice.kind] ?? "car_alt_route"
      let text = notice.text
      return CPNavigationAlert(
        titleVariants: [notice.title], subtitleVariants: text.isEmpty ? [] : [text], image: CarPlayImages.icon(icon),
        primaryAction: primary, secondaryAction: secondary, duration: 0)
    case .failure(let message, let destination):
      let close = CPAlertAction(title: labels.close, style: .cancel) { [weak self] _ in
        self?.failureClosed = content
      }
      // The reason in the subtitle, which takes more lines than the title (two).
      return CPNavigationAlert(
        titleVariants: [destination.isEmpty ? message : destination], subtitleVariants: destination.isEmpty ? [] : [message],
        image: nil, primaryAction: close, secondaryAction: nil, duration: 0)
    }
  }

  private var locationAuthorizer: CLLocationManager {
    let manager = locationManager ?? CLLocationManager()
    locationManager = manager
    manager.delegate = self
    return manager
  }

  /** iOS has never asked for location: the notice's button can ask. */
  private var locationUndetermined: Bool { locationAuthorizer.authorizationStatus == .notDetermined }

  /**
   * The location notice's button: iOS asks (its dialog is the system's, on the phone). Pressing it closed the alert: the
   * notice comes back until location is allowed, with Close once iOS can't ask any more.
   */
  private func requestLocation() {
    askedLocation = true
    note("location permission asked on the car's screen")
    locationAuthorizer.requestWhenInUseAuthorization()
    alertShown = nil
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.syncAlert() }
  }

  // MARK: - Lists and search over the map

  private func openDestinations() {
    let list = CPListTemplate(title: labels.destinations, sections: destinationSections())
    // A subtitle: the title is one line.
    list.emptyViewSubtitleVariants = [labels.noDestinations]
    destinationsList = list
    push(list)
  }

  /** Saved places first, then recent destinations, as many as CarPlay lists. */
  private func destinationSections() -> [CPListSection] {
    var left = Int(CPListTemplate.maximumItemCount)
    let saved = places.filter { $0.kind != "recent" }
    let recent = places.filter { $0.kind == "recent" }
    var sections: [CPListSection] = []
    for (header, list) in [(labels.saved, saved), (labels.recent, recent)] where !list.isEmpty && left > 0 {
      sections.append(CPListSection(items: list.prefix(left).map(placeItem), header: header, sectionIndexTitle: nil))
      left -= list.count
    }
    return sections
  }

  private func placeItem(_ place: CarPlace) -> CPListItem {
    let item = CPListItem(
      text: place.title.isEmpty ? "·" : place.title, detailText: place.detail?.isEmpty == false ? place.detail : nil,
      image: CarPlayImages.icon(CarPlayImages.placeIcon(place.kind), size: CarPlayImages.rowSize))
    item.userInfo = place.id
    item.handler = { [weak self] _, completion in
      self?.go(place.id)
      completion()
    }
    return item
  }

  private func go(_ id: String) {
    send("go", ["id": id])
    popToRoot()
  }

  /** The route followed first, then each other way by the street it goes by; one picked is followed instead. */
  private func openRoutes() {
    let list = CPListTemplate(title: labels.routes, sections: routeSections())
    routesList = list
    push(list)
  }

  private func routeSections() -> [CPListSection] {
    let current = CPListItem(
      text: route?.title.isEmpty == false ? route?.title : labels.thisRoute,
      detailText: route?.detail.isEmpty == false ? route?.detail : nil,
      image: CarPlayImages.icon("car_navigation", size: CarPlayImages.rowSize))
    current.handler = { [weak self] _, completion in
      self?.popToRoot()
      completion()
    }
    let others = (route?.alternatives ?? []).prefix(Int(CPListTemplate.maximumItemCount) - 1).map { alternative in
      let item = CPListItem(
        text: alternative.title.isEmpty ? "·" : alternative.title, detailText: alternative.detail,
        image: CarPlayImages.icon("car_alt_route", size: CarPlayImages.rowSize))
      item.handler = { [weak self] _, completion in
        self?.send("choose-alternative", ["index": alternative.index])
        self?.popToRoot()
        completion()
      }
      return item
    }
    return [CPListSection(items: [current] + others)]
  }

  private func resultsSections() -> [CPListSection] {
    guard case .results(let found) = CarPlayLogic.searchList(search, typed: resultsQuery) else { return [] }
    return found.isEmpty ? [] : [CPListSection(items: found.prefix(Int(CPListTemplate.maximumItemCount)).map(placeItem))]
  }

  /** The search: the phone's offline index as the driver types (CarPlay offers the keyboard only while parked). */
  private func openSearchTemplate() {
    let template = CPSearchTemplate()
    template.delegate = self
    searchTemplate = template
    typed = ""
    push(template)
  }

  /**
   * Back to the map, when something is over it. Every template operation has a completion: one that fails without
   * one raises an exception, and the app ended ("No templates were available to be popped": a place asked for, with
   * nothing open over the map).
   */
  private func popToRoot(animated: Bool = true, then: (() -> Void)? = nil) {
    guard let interfaceController, interfaceController.templates.count > 1 else {
      then?()
      return
    }
    interfaceController.popToRootTemplate(animated: animated) { [weak self] _, error in
      if let error { self?.note("lists not closed: \(error.localizedDescription)", problem: true) }
      then?()
    }
  }

  /** Over the map; CarPlay refusing it says why in the trip log. */
  private func push(_ template: CPTemplate) {
    interfaceController?.pushTemplate(template, animated: true) { [weak self] _, error in
      if let error { self?.note("\(type(of: template)) not shown: \(error.localizedDescription)", problem: true) }
    }
  }

  /** The answers for the text typed; with nothing typed, the destinations; nothing found says so. */
  private func searchItems() -> [CPListItem] {
    let limit = Int(CPListTemplate.maximumItemCount)
    switch CarPlayLogic.searchList(search, typed: typed) {
    case .empty:
      return places.prefix(limit).map(placeItem)
    case .loading:
      return []
    case .results(let found):
      if found.isEmpty { return [CPListItem(text: labels.noResults, detailText: nil)] }
      return found.prefix(limit).map(placeItem)
    }
  }

  // MARK: - Turn banners and the car's own

  fileprivate func endedByCar() {
    note("navigation stopped by the car")
    navigation = nil
    tripKey = nil
    tripShows = .none
    send("end-route")
  }

  fileprivate func showBanner(for alert: CPNavigationAlert) -> Bool {
    guard alert === alertPresented, case .camera(let camera) = alertPresentedContent else { return false }
    note("camera notification popped up #\(camera.id): \(alert.titleVariants.first ?? "")")
    return true
  }

  fileprivate func showBanner(for maneuver: CPManeuver) -> Bool {
    guard let id = maneuver.userInfo as? String, id == alertDue else { return false }
    alerted = id
    alertDue = nil
    note("turn notification popped up: \(maneuver.instructionVariants.first ?? "")")
    return true
  }
}

// MARK: - CarPlay's callbacks

extension CarPlaySession: CPMapTemplateDelegate {
  func mapTemplate(_ mapTemplate: CPMapTemplate, shouldShowNotificationFor maneuver: CPManeuver) -> Bool {
    showBanner(for: maneuver)
  }

  func mapTemplate(
    _ mapTemplate: CPMapTemplate, shouldUpdateNotificationFor maneuver: CPManeuver, with travelEstimates: CPTravelEstimates
  ) -> Bool {
    (maneuver.userInfo as? String) == alerted
  }

  // A camera's alert while another app fills the car's screen: a notification, as Apple's guide has navigation alerts
  // in the background, its words as it popped up (CarPlay updates none) for its few seconds; a notice waits for the
  // app.
  func mapTemplate(_ mapTemplate: CPMapTemplate, shouldShowNotificationFor navigationAlert: CPNavigationAlert) -> Bool {
    showBanner(for: navigationAlert)
  }

  func mapTemplateShouldProvideNavigationMetadata(_ mapTemplate: CPMapTemplate) -> Bool {
    true
  }

  // The icon beside the words, not above them: a shorter card, more of the map.
  func mapTemplate(_ mapTemplate: CPMapTemplate, displayStyleFor maneuver: CPManeuver) -> CPManeuverDisplayStyle {
    .leadingSymbol
  }

  // Another navigator started (the car's own): this app's route ends, so the voice and banners are the other's alone.
  func mapTemplateDidCancelNavigation(_ mapTemplate: CPMapTemplate) {
    endedByCar()
  }

  func mapTemplate(
    _ mapTemplate: CPMapTemplate, didDismiss navigationAlert: CPNavigationAlert,
    dismissalContext: CPNavigationAlert.DismissalContext
  ) {
    guard navigationAlert === alertPresented else { return }
    let content = alertPresentedContent
    alertPresented = nil
    alertPresentedContent = nil
    alertShown = nil
    carPlayLog.notice("alert dismissed (\(dismissalContext.rawValue))")
    // Closed by the driver (its button, or CarPlay's own x): a failure stays closed, a camera's, and a notice that
    // only says something (no map, location iOS can't ask for any more).
    if dismissalContext == .userDismissed {
      if case .failure = content { failureClosed = content }
      if case .camera(let camera) = content { closeCamera(camera) }
      if case .notice(let notice, let canAsk) = content, CarPlayLogic.closedByCarPlaysX(notice, canAsk: canAsk) {
        noticeClosed = notice
      }
    }
    // Taken down by CarPlay (another alert, the app sent away): shown again; the driver's own buttons decide theirs.
    if dismissalContext == .systemDismissed {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.syncAlert() }
    }
  }

  // The panning interface (cars with a knob or a touchpad): its arrows move the map; a button ends it.
  func mapTemplateDidShowPanningInterface(_ mapTemplate: CPMapTemplate) {
    panning = true
    note("map pan mode on")
    refresh()
  }

  func mapTemplateDidDismissPanningInterface(_ mapTemplate: CPMapTemplate) {
    panning = false
    note("map pan mode off")
    refresh()
  }

  func mapTemplate(_ mapTemplate: CPMapTemplate, panWith direction: CPMapTemplate.PanDirection) {
    let scroll = CarPlayLogic.panScroll(direction: direction.rawValue)
    gesture(["kind": "scroll", "dx": scroll.dx, "dy": scroll.dy])
  }

  // A finger on a touch screen, in the map's points (the car's over `mapScale`), as Android Auto's scroll and fling.
  func mapTemplateDidBeginPanGesture(_ mapTemplate: CPMapTemplate) {
    panFrom = (0, 0)
  }

  func mapTemplate(_ mapTemplate: CPMapTemplate, didUpdatePanGestureWithTranslation translation: CGPoint, velocity: CGPoint) {
    let s = CarPlayLogic.mapScale
    let to = (x: Double(translation.x) / s, y: Double(translation.y) / s)
    let scroll = CarPlayLogic.scroll(from: panFrom, to: to)
    panFrom = to
    gesture(["kind": "scroll", "dx": scroll.dx, "dy": scroll.dy])
  }

  func mapTemplate(_ mapTemplate: CPMapTemplate, didEndPanGestureWithVelocity velocity: CGPoint) {
    let s = CarPlayLogic.mapScale
    gesture(["kind": "fling", "vx": Double(velocity.x) / s, "vy": Double(velocity.y) / s])
  }

  @available(iOS 26.0, *)
  func mapTemplateDidBeginZoomGesture(_ mapTemplate: CPMapTemplate) {
    zoomFrom = 1
  }

  @available(iOS 26.0, *)
  func mapTemplate(_ mapTemplate: CPMapTemplate, didUpdateZoomGestureWithCenter center: CGPoint, scale: CGFloat, velocity: CGFloat) {
    let factor = CarPlayLogic.zoomFactor(from: zoomFrom, to: Double(scale))
    zoomFrom = Double(scale)
    let s = CarPlayLogic.mapScale
    gesture(["kind": "scale", "x": Double(center.x) / s, "y": Double(center.y) / s, "factor": factor])
  }
}

extension CarPlaySession: CPSearchTemplateDelegate {
  func searchTemplate(
    _ searchTemplate: CPSearchTemplate, updatedSearchText searchText: String,
    completionHandler: @escaping ([CPListItem]) -> Void
  ) {
    // Each text gets an answer: an older one still waiting gets none.
    searchCompletion?([])
    searchCompletion = nil
    typed = searchText
    if case .loading = CarPlayLogic.searchList(search, typed: typed) {
      searchCompletion = completionHandler
      send("search", ["text": searchText])
    } else {
      completionHandler(searchItems())
    }
  }

  // The keyboard's search key: the answers in a list of their own, over the search. Above the keyboard there is room
  // for one or two, and nothing on CarPlay's keyboard puts it away.
  func searchTemplateSearchButtonPressed(_ searchTemplate: CPSearchTemplate) {
    guard !typed.trimmingCharacters(in: .whitespaces).isEmpty else { return }
    push(resultsTemplate(typed))
  }

  func searchTemplate(
    _ searchTemplate: CPSearchTemplate, selectedResult item: CPListItem, completionHandler: @escaping () -> Void
  ) {
    if let id = item.userInfo as? String { go(id) }
    completionHandler()
  }
}

extension CarPlaySession: CPInterfaceControllerDelegate {
  // Back from the search: an answer still waited for goes nowhere.
  func templateDidDisappear(_ aTemplate: CPTemplate, animated: Bool) {
    if aTemplate === searchTemplate, interfaceController?.templates.contains(aTemplate) != true {
      searchCompletion?([])
      searchCompletion = nil
    }
  }
}

extension CarPlaySession: CPSessionConfigurationDelegate {
  // The car limits the keyboard (and its lists, which CarPlay shortens itself) while driving: no search button then.
  func sessionConfiguration(
    _ sessionConfiguration: CPSessionConfiguration, limitedUserInterfacesChanged limitedUserInterfaces: CPLimitableUserInterface
  ) {
    let limited = limitedUserInterfaces.contains(.keyboard)
    guard limited != keyboardLimited else { return }
    keyboardLimited = limited
    note("keyboard \(limited ? "limited" : "allowed") by the car")
    refresh()
  }
}

extension CarPlaySession: CLLocationManagerDelegate {
  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let status = manager.authorizationStatus
    let was = authorization
    authorization = status
    guard status != .notDetermined, was != nil, was != status else { return }
    // Answered or changed (in Settings): the alert's button follows (Close when iOS can't ask any more).
    alertShown = nil
    syncAlert()
    guard askedLocation else { return }
    askedLocation = false
    let granted = status == .authorizedAlways || status == .authorizedWhenInUse
    note(granted ? "location permission granted" : "location permission refused")
    send("permission")
  }
}

/**
 * The car's map: the React root `CarPlayMap`, or a blank view while there is none. The root is laid out `scale` times
 * smaller than the car's screen and drawn that much bigger, as Android Auto draws its map at `MAP_SCALE` times the car's
 * density: the map's points are the car's divided by it.
 */
final class CarPlayMapController: UIViewController {
  private let react: UIView?
  private let scale: Double
  /** What CarPlay's panels cover changed: the map's insets follow. */
  private let onInsets: () -> Void

  init(_ react: UIView?, scale: Double, onInsets: @escaping () -> Void) {
    self.react = react
    self.scale = scale
    self.onInsets = onInsets
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not used")
  }

  override func loadView() {
    view = UIView()
    view.backgroundColor = .clear
    if let react { view.addSubview(react) }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    guard let react else { return }
    let s = CGFloat(scale)
    react.transform = .identity
    react.bounds = CGRect(x: 0, y: 0, width: view.bounds.width / s, height: view.bounds.height / s)
    react.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
    react.transform = CGAffineTransform(scaleX: s, y: s)
    // The map buttons' layout guide follows the layout, not the safe area.
    onInsets()
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    onInsets()
  }
}

/** The module's icons: the app's own (scripts/car-icons.py), template images CarPlay tints for the car's day or night. */
enum CarPlayImages {
  private static let bundle: Bundle = {
    let code = Bundle(for: CarPlaySession.self)
    guard let url = code.url(forResource: "WtfCarPlay", withExtension: "bundle"), let bundle = Bundle(url: url) else {
      carPlayLog.error("WtfCarPlay.bundle not found: no icons")
      return code
    }
    return bundle
  }()

  /** Buttons' size; a list's rows; the guidance panel's maneuvers, points. Drawn from the vector at that size. */
  static let buttonSize = 24.0
  static let rowSize = 32.0
  static let maneuverSize = 18.0

  static func icon(_ name: String, size: Double = buttonSize) -> UIImage {
    guard let image = vector(name) else { return UIImage() }
    let side = CGSize(width: size, height: size)
    if image.size == side { return image.withRenderingMode(.alwaysTemplate) }
    let drawn = UIGraphicsImageRenderer(size: side).image { _ in image.draw(in: CGRect(origin: .zero, size: side)) }
    return drawn.withRenderingMode(.alwaysTemplate)
  }

  /**
   * A map button's drawing spans this share of the button's icon at most: the X's own (14 of 24). The symbols leave
   * different room around their drawing (the voice 3 of 24 a side, my location 1): drawn alike, they filled the round
   * button but the X, + and −.
   */
  static let mapDrawingShare = 14.0 / 24

  /** How a map button's icon is drawn: its colour, and an edge around it (`edgeAlpha` of `edge`, `edgeWidth` pt). */
  struct MapIconStyle {
    var color: UIColor
    var edge: UIColor
    var edgeAlpha: Double
    var edgeWidth: Double

    /** White on the night's dark glass, a faint dark edge for where it shows something light. */
    static let night = MapIconStyle(color: .white, edge: .black, edgeAlpha: 0.25, edgeWidth: 1)
    /**
     * By day the app's text colour (src/constants/theme.ts, light `text` #1D1C1A), about CarPlay's own glyphs by day,
     * with no edge: the light glass needs none, and pure black in a white edge looked heavy.
     */
    static let day = MapIconStyle(
      color: UIColor(red: 0x1D / 255.0, green: 0x1C / 255.0, blue: 0x1A / 255.0, alpha: 1), edge: .white, edgeAlpha: 0,
      edgeWidth: 0)
    /**
     * Focused by night: on CarPlay's white focus fill or on the dark glass, black with a full white edge. By day the
     * fill and the glass are light alike: the day's own.
     */
    static let focusedAtNight = MapIconStyle(color: .black, edge: .white, edgeAlpha: 1, edgeWidth: 1.5)
  }

  /** The share of its box each icon's drawing spans, measured once. Main thread. */
  private static var drawingShares: [String: Double] = [:]

  /**
   * A map button's icon, its drawing as big as the X's, never tinted by CarPlay: on iOS 26 its tint of map buttons is
   * wrong (Apple's known issue; developer forums 798735, 799192, 842273), white on its white focus fill, and reported
   * white on near-white buttons by day. The session draws them by the car's night or day, and focused (a knob's, a
   * touchpad's, or where the focus came back after a list) by night for a white fill or the glass. The edge's copies
   * make one layer, faded as a whole: overlapping, they would add up to solid.
   */
  static func mapIcon(_ name: String, _ style: MapIconStyle) -> UIImage {
    guard let image = vector(name) else { return UIImage() }
    let share = drawingShares[name] ?? drawingShare(image)
    drawingShares[name] = share
    let size = buttonSize * min(1, mapDrawingShare / share)
    let inset = (buttonSize - size) / 2
    let around = image.withTintColor(style.edge, renderingMode: .alwaysOriginal)
    let drawing = image.withTintColor(style.color, renderingMode: .alwaysOriginal)
    return UIGraphicsImageRenderer(size: CGSize(width: buttonSize, height: buttonSize)).image { context in
      let cg = context.cgContext
      guard style.edgeAlpha > 0 else {
        drawing.draw(in: CGRect(x: inset, y: inset, width: size, height: size))
        return
      }
      cg.saveGState()
      cg.setAlpha(style.edgeAlpha)
      cg.beginTransparencyLayer(auxiliaryInfo: nil)
      for i in 0..<8 {
        let angle = Double(i) * .pi / 4
        let offset = (x: cos(angle) * style.edgeWidth, y: sin(angle) * style.edgeWidth)
        around.draw(in: CGRect(x: inset + offset.x, y: inset + offset.y, width: size, height: size))
      }
      cg.endTransparencyLayer()
      cg.restoreGState()
      drawing.draw(in: CGRect(x: inset, y: inset, width: size, height: size))
    }.withRenderingMode(.alwaysOriginal)
  }

  /** A camera alert's image, its sign or the camera's glyph, points: CarPlay draws it smaller, both alike. */
  static let signSize = 40.0

  /**
   * The speed limit as the road sign drivers know (speed-limit-sign.tsx): a white disc in a red ring, the number black;
   * the disc dimmed by night so it doesn't glare. Its own colours, not CarPlay's tint.
   */
  static func speedSign(_ kph: Int, dark: Bool, size: Double = signSize) -> UIImage {
    let rgb = { (hex: Int) in
      UIColor(
        red: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255,
        alpha: 1)
    }
    let box = CGRect(x: 0, y: 0, width: size, height: size)
    let ring = size * 0.11
    return UIGraphicsImageRenderer(size: box.size).image { _ in
      rgb(0xD52B1E).setFill()
      UIBezierPath(ovalIn: box).fill()
      rgb(dark ? 0xF2F0EC : 0xFFFFFF).setFill()
      UIBezierPath(ovalIn: box.insetBy(dx: ring, dy: ring)).fill()
      let text = NSAttributedString(
        string: String(kph),
        attributes: [
          .font: UIFont.systemFont(ofSize: size * (kph >= 100 ? 0.34 : 0.41), weight: .bold),
          .foregroundColor: rgb(0x1D1C1A),
          .kern: -size * 0.015,
        ])
      let drawn = text.size()
      text.draw(at: CGPoint(x: (size - drawn.width) / 2, y: (size - drawn.height) / 2))
    }.withRenderingMode(.alwaysOriginal)
  }

  /** The share of its box the drawing of `image` spans, across or down, whichever is more: drawn and its ink found. */
  private static func drawingShare(_ image: UIImage) -> Double {
    let side = 96
    guard
      let context = CGContext(
        data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side,
        space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
    else { return 1 }
    context.setFillColor(gray: 1, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: side, height: side))
    UIGraphicsPushContext(context)
    image.withTintColor(.black, renderingMode: .alwaysOriginal).draw(in: CGRect(x: 0, y: 0, width: side, height: side))
    UIGraphicsPopContext()
    guard let data = context.data else { return 1 }
    let pixels = data.bindMemory(to: UInt8.self, capacity: side * side)
    var low = (x: side, y: side)
    var high = (x: -1, y: -1)
    for y in 0..<side {
      for x in 0..<side where pixels[y * side + x] < 128 {
        low = (min(low.x, x), min(low.y, y))
        high = (max(high.x, x), max(high.y, y))
      }
    }
    guard high.x >= low.x else { return 1 }
    return Double(max(high.x - low.x, high.y - low.y) + 1) / Double(side)
  }

  private static func vector(_ name: String) -> UIImage? {
    guard let image = UIImage(named: name, in: bundle, compatibleWith: nil) else {
      carPlayLog.error("icon \(name, privacy: .public) not found")
      return nil
    }
    return image
  }

  static func placeIcon(_ kind: String) -> String {
    switch kind {
    case "home": return "car_home"
    case "work": return "car_work"
    case "favorite": return "car_star"
    case "result": return "car_location_on"
    default: return "car_history"
    }
  }
}
