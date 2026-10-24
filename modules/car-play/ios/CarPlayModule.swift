import ExpoModulesCore

// The route's guidance on the car's screen (docs/CARPLAY-SPEC.md §4). The JS side that calls it is the car screen's
// own React root (src/components/car-play), mounted only while a car is connected: no connection events are needed.
// Every function runs on the main queue, where CarPlaySession lives.

struct CarTripRecord: Record {
  @Field var originLat: Double = 0
  @Field var originLon: Double = 0
  @Field var destinationLat: Double = 0
  @Field var destinationLon: Double = 0
  @Field var destinationName: String?
  /** The route as the driver reads it in the trip's card ("18 min · 12 km"). */
  @Field var summary: String = ""
}

struct CarManeuverRecord: Record {
  @Field var instruction: String = ""
  /** An SF Symbol (a stand-in for the app's own turn icons). */
  @Field var symbol: String = ""
  /** From the previous maneuver (the first: from the car), m and s. */
  @Field var distanceM: Double = 0
  @Field var timeS: Double = 0
}

struct CarEstimatesRecord: Record {
  @Field var toNextM: Double = 0
  @Field var toNextS: Double = 0
  @Field var remainingM: Double = 0
  @Field var remainingS: Double = 0
}

public class CarPlayModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CarPlay")

    AsyncFunction("startTrip") { (trip: CarTripRecord) in
      CarPlaySession.shared.startTrip(trip)
    }.runOnQueue(.main)

    AsyncFunction("setManeuvers") { (maneuvers: [CarManeuverRecord]) in
      CarPlaySession.shared.setManeuvers(maneuvers)
    }.runOnQueue(.main)

    AsyncFunction("updateEstimates") { (estimates: CarEstimatesRecord) in
      CarPlaySession.shared.updateEstimates(estimates)
    }.runOnQueue(.main)

    AsyncFunction("endTrip") { (arrived: Bool) in
      CarPlaySession.shared.endTrip(arrived: arrived)
    }.runOnQueue(.main)
  }
}
