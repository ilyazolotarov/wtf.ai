import CarPlay
import ExpoModulesCore
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

  func connect(_ controller: CPInterfaceController, window: CPWindow) {
    carPlayLog.notice("CarPlay scene connected")
    interfaceController = controller
    self.window = window
    let template = CPMapTemplate()
    mapTemplate = template
    controller.setRootTemplate(template, animated: false, completion: nil)
    window.rootViewController = CarPlayMapController()
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

  /**
   * A root view of `moduleName` on the app's one React Native host, started first when nothing has (the app opened
   * from the car's screen, no phone scene). The template's AppDelegate keeps the factory in `reactNativeFactory`
   * (Expo's ExpoReactNativeFactoryProvider, in the Expo pod, which a module can't depend on); it is an
   * ExpoReactNativeFactory, reached through ExpoModulesCore's protocol. Nil: no such AppDelegate.
   */
  static func reactView() -> UIView? {
    guard let delegate = UIApplication.shared.delegate else { return nil }
    let factory = Mirror(reflecting: delegate).children.first { $0.label == "reactNativeFactory" }?.value
    guard let factory = factory as? ExpoReactNativeFactoryProtocol else { return nil }
    // Made without the app delegate subscribers' root view customizations (RCTRootViewFactoryConfiguration's
    // customizeRootView, read the way ExpoReactNativeFactory reads it): expo-splash-screen's would put the launch
    // screen over the car's map for good, and move its one splash to this view, so the phone's would never go if
    // CarPlay connected while it showed.
    let rootViewFactory = (factory as? NSObject)?.value(forKey: "rootViewFactory") as? NSObject
    let configuration = rootViewFactory?.value(forKey: "_configuration") as? NSObject
    let customize = configuration?.value(forKey: "customizeRootView")
    configuration?.setValue(nil, forKey: "customizeRootView")
    defer { configuration?.setValue(customize, forKey: "customizeRootView") }
    return factory.recreateRootView(withBundleURL: nil, moduleName: moduleName, initialProps: nil, launchOptions: nil)
  }
}

/** The car's map: the React root `CarPlayMap`. */
final class CarPlayMapController: UIViewController {
  override func loadView() {
    let react = CarPlaySession.reactView()
    let drawnBy = react == nil ? "no React Native factory, a blank view" : "the React root"
    carPlayLog.notice("CarPlay map: \(drawnBy, privacy: .public)")
    view = react ?? UIView()
    view.backgroundColor = .systemBackground
  }
}
