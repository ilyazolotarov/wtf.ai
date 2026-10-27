import CarPlay
import MapKit
import os

/** The car's screen coming and going, and what drew its map: in the device log (CARPLAY-SPEC §5). */
let carPlayLog = Logger(subsystem: "ai.wtf.navigator", category: "carplay")

/**
 * The connected car's screen: the map template, the React Native view under it, and the navigation session of a
 * route. Main thread only (the scene delegate's callbacks and the module's functions).
 */
final class CarPlaySession {
  static let shared = CarPlaySession()

  /** The JS root of the car's screen (index.ts). */
  static let moduleName = "CarPlayMap"

  private var interfaceController: CPInterfaceController?
  private var window: CPWindow?
  private var mapTemplate: CPMapTemplate?
  private var trip: CPTrip?
  private var navigation: CPNavigationSession?
  /** The React Native host the map's root was made on. */
  private weak var mapHost: AnyObject?

  func connect(_ controller: CPInterfaceController, window: CPWindow) {
    carPlayLog.notice("CarPlay scene connected")
    interfaceController = controller
    self.window = window
    let template = CPMapTemplate()
    mapTemplate = template
    controller.setRootTemplate(template, animated: false, completion: nil)
    showMap()
    // After the scenes connecting at this launch: the phone's starts React Native as it connects.
    if !AppReactHost.isRunning {
      DispatchQueue.main.async { AppReactHost.startWithoutPhone() }
    }
  }

  /**
   * A JS runtime came up (CarPlayModule's OnCreate). On a new host (the development launcher makes one at each load)
   * the map's root is made again: a root stays on the host it was made on, and the car's screen went black. A reload
   * on the same host restarts the root by itself, and making it again then too released the old one while React
   * Native's restart still held it (a debug assertion: "Surface must not be running").
   */
  func reactNativeStarted() {
    guard window != nil, let host = AppReactHost.host, host !== mapHost else { return }
    carPlayLog.notice("React Native on a new host")
    showMap()
  }

  /** The React root `CarPlayMap` once React Native runs, a blank view until then. */
  private func showMap() {
    guard let window else { return }
    let react = AppReactHost.rootView(moduleName: Self.moduleName)
    mapHost = react == nil ? nil : AppReactHost.host
    let drawnBy = react == nil ? "a blank view until React Native runs" : "the React root"
    carPlayLog.notice("CarPlay map: \(drawnBy, privacy: .public)")
    window.rootViewController = CarPlayMapController(react)
  }

  func disconnect() {
    carPlayLog.notice("CarPlay scene disconnected")
    navigation?.cancelTrip()
    navigation = nil
    trip = nil
    mapTemplate = nil
    // Unmounts the React root, and with it the guidance that calls the module.
    window?.rootViewController = nil
    window = nil
    mapHost = nil
    interfaceController = nil
  }

  func startTrip(_ record: CarTripRecord) {
    guard let mapTemplate else { return }
    navigation?.cancelTrip()
    let destination = Self.mapItem(record.destinationLat, record.destinationLon)
    destination.name = record.destinationName
    let choice = CPRouteChoice(
      summaryVariants: [record.summary], additionalInformationVariants: [], selectionSummaryVariants: [])
    let trip = CPTrip(
      origin: Self.mapItem(record.originLat, record.originLon), destination: destination, routeChoices: [choice])
    self.trip = trip
    navigation = mapTemplate.startNavigationSession(for: trip)
  }

  /** The next maneuver first; replaced only when they change, so the panel doesn't redraw at every position. */
  func setManeuvers(_ records: [CarManeuverRecord]) {
    navigation?.upcomingManeuvers = records.map { record in
      let maneuver = CPManeuver()
      maneuver.instructionVariants = [record.instruction]
      maneuver.symbolImage = UIImage(systemName: record.symbol)
      maneuver.initialTravelEstimates = Self.estimates(record.distanceM, record.timeS)
      return maneuver
    }
  }

  func updateEstimates(_ record: CarEstimatesRecord) {
    guard let navigation, let trip, let mapTemplate else { return }
    if let next = navigation.upcomingManeuvers.first {
      navigation.updateEstimates(Self.estimates(record.toNextM, record.toNextS), for: next)
    }
    mapTemplate.updateEstimates(Self.estimates(record.remainingM, record.remainingS), for: trip)
  }

  func endTrip(arrived: Bool) {
    if arrived {
      navigation?.finishTrip()
    } else {
      navigation?.cancelTrip()
    }
    navigation = nil
    trip = nil
  }

  private static func estimates(_ meters: Double, _ seconds: Double) -> CPTravelEstimates {
    CPTravelEstimates(distanceRemaining: Measurement(value: meters, unit: UnitLength.meters), timeRemaining: seconds)
  }

  private static func mapItem(_ lat: Double, _ lon: Double) -> MKMapItem {
    MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lon)))
  }
}

/** The car's map: the React root `CarPlayMap`, or a blank view while there is none. */
final class CarPlayMapController: UIViewController {
  private let react: UIView?

  init(_ react: UIView?) {
    self.react = react
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not used")
  }

  override func loadView() {
    view = react ?? UIView()
    view.backgroundColor = .systemBackground
  }
}
