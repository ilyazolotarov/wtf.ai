import Foundation
import XCTest

@testable import CarPlayLogic

private func step(_ id: String = "left:@50.45,30.52", kind: String = "left", distanceM: Double = 800, timeS: Double = 60) -> CarStep {
  CarStep(
    id: id, kind: kind, exit: nil, instruction: "Turn left", distanceM: distanceM, timeS: timeS, shownDistance: 800,
    shownUnit: "m")
}

private func route(
  _ status: String = "active", steps: [CarStep] = [step()], replanning: Bool = false, quiet: Bool = false,
  lat: Double = 49.84, lon: Double = 24.03, alternatives: [CarAlternative] = []
) -> CarRoute {
  CarRoute(
    status: status, message: nil, destinationName: "Lviv", destinationLat: lat, destinationLon: lon,
    replanning: replanning, quiet: quiet, steps: steps, remainingM: 12_000, remainingS: 900, remainingShown: 12,
    remainingUnit: "km1", alternatives: alternatives)
}

private let lviv = "49.840000,24.030000"
private let notice = CarNotice(kind: CarNotice.location, title: "Location is off", text: "Allow it", action: "Allow")

final class TripPlanTests: XCTestCase {
  func testARouteStartsATripThatFollowsItsStates() {
    XCTAssertEqual(CarPlayLogic.tripPlan(current: nil, arrived: false, route: route("planning", steps: [])), CarTripPlan(end: nil, start: lviv, shows: .loading(rerouting: false)))
    XCTAssertEqual(CarPlayLogic.tripPlan(current: lviv, arrived: false, route: route()), CarTripPlan(end: nil, start: nil, shows: .steps))
    XCTAssertEqual(
      CarPlayLogic.tripPlan(current: lviv, arrived: false, route: route(replanning: true)),
      CarTripPlan(end: nil, start: nil, shows: .loading(rerouting: true)))
    XCTAssertEqual(CarPlayLogic.tripPlan(current: lviv, arrived: false, route: route("arrived", steps: [])), CarTripPlan(end: nil, start: nil, shows: .arrived))
  }

  func testArrivalFinishesTheTripWhenTheRouteGoesAndOtherwiseItIsCancelled() {
    XCTAssertEqual(CarPlayLogic.tripPlan(current: lviv, arrived: true, route: nil), CarTripPlan(end: .finish, start: nil, shows: .none))
    XCTAssertEqual(CarPlayLogic.tripPlan(current: lviv, arrived: false, route: nil), CarTripPlan(end: .cancel, start: nil, shows: .none))
    XCTAssertEqual(CarPlayLogic.tripPlan(current: lviv, arrived: false, route: route("failed", steps: [])), CarTripPlan(end: .cancel, start: nil, shows: .none))
    XCTAssertEqual(CarPlayLogic.tripPlan(current: nil, arrived: false, route: nil), CarTripPlan(end: nil, start: nil, shows: .none))
  }

  func testAnotherDestinationIsAnotherTripAndSoIsSettingOffAgainAfterArriving() {
    let kyiv = route(lat: 50.45, lon: 30.52)
    XCTAssertEqual(CarPlayLogic.tripPlan(current: lviv, arrived: false, route: kyiv), CarTripPlan(end: .cancel, start: "50.450000,30.520000", shows: .steps))
    XCTAssertEqual(CarPlayLogic.tripPlan(current: lviv, arrived: true, route: route()), CarTripPlan(end: .finish, start: lviv, shows: .steps))
  }

  func testATripStartsOnlyOnceCarPlayHasHadTimeToEndTheOneBefore() {
    XCTAssertEqual(CarPlayLogic.tripStartWait(endedAt: nil, now: 100), 0)
    XCTAssertEqual(CarPlayLogic.tripStartWait(endedAt: 100, now: 100), CarPlayLogic.tripRestartS)
    XCTAssertEqual(CarPlayLogic.tripStartWait(endedAt: 100, now: 100.25), CarPlayLogic.tripRestartS - 0.25, accuracy: 1e-9)
    XCTAssertEqual(CarPlayLogic.tripStartWait(endedAt: 100, now: 100 + CarPlayLogic.tripRestartS), 0)
    XCTAssertEqual(CarPlayLogic.tripStartWait(endedAt: 100, now: 500), 0)
  }
}

final class TurnAlertTests: XCTestCase {
  func testTheNextManeuverPopsUpOnceWhenNear() {
    XCTAssertNil(CarPlayLogic.turnAlert(route(steps: [step(distanceM: 800, timeS: 60)]), alerted: nil))
    XCTAssertEqual(CarPlayLogic.turnAlert(route(steps: [step(distanceM: 300, timeS: 30)]), alerted: nil), "left:@50.45,30.52")
    XCTAssertEqual(CarPlayLogic.turnAlert(route(steps: [step(distanceM: 600, timeS: 20)]), alerted: nil), "left:@50.45,30.52")
    XCTAssertNil(CarPlayLogic.turnAlert(route(steps: [step(distanceM: 100, timeS: 8)]), alerted: "left:@50.45,30.52"))
  }

  func testNothingPopsUpForTheDepartureOnTheDriversOwnWayOrWhilePlannedAgain() {
    XCTAssertNil(CarPlayLogic.turnAlert(route(steps: [step(kind: "depart", distanceM: 50)]), alerted: nil))
    XCTAssertNil(CarPlayLogic.turnAlert(route(steps: [step(distanceM: 50)], quiet: true), alerted: nil))
    XCTAssertNil(CarPlayLogic.turnAlert(route(steps: [step(distanceM: 50)], replanning: true), alerted: nil))
    XCTAssertNil(CarPlayLogic.turnAlert(nil, alerted: nil))
  }

  func testTheManeuversAreNewToCarPlayWhenOthersAreNextOrTheNextCanPopUp() {
    let far = route(steps: [step(distanceM: 800)])
    XCTAssertEqual(CarPlayLogic.maneuversKey(far, alert: nil), CarPlayLogic.maneuversKey(route(steps: [step(distanceM: 700)]), alert: nil))
    XCTAssertNotEqual(CarPlayLogic.maneuversKey(far, alert: nil), CarPlayLogic.maneuversKey(far, alert: "left:@50.45,30.52"))
    XCTAssertNotEqual(CarPlayLogic.maneuversKey(far, alert: nil), CarPlayLogic.maneuversKey(route(steps: [step("right:@1,2")]), alert: nil))
  }

  func testTheManeuverStateForTheCarsCluster() {
    XCTAssertEqual(CarPlayLogic.maneuverState(step(distanceM: 800, timeS: 60)), 0)
    XCTAssertEqual(CarPlayLogic.maneuverState(step(distanceM: 250, timeS: 25)), 2)
    XCTAssertEqual(CarPlayLogic.maneuverState(step(distanceM: 40, timeS: 4)), 3)
  }
}

final class ButtonsTests: XCTestCase {
  private let alternatives = [CarAlternative(index: 0, title: "Zelena", detail: "+2 min")]

  private func mapButtons(
    _ route: CarRoute?, notice: CarNotice? = nil, voiceMuted: Bool? = false, panning: Bool = false, recentre: Bool = false
  ) -> [CarMapButton] {
    CarPlayLogic.mapButtons(route: route, notice: notice, voiceMuted: voiceMuted, panning: panning, recentre: recentre)
  }

  func testTheBarHoldsTheDestinationsSearchAndVoiceOnlyWithoutARoute() {
    let none = CarPlayLogic.barButtons(route: nil, notice: nil, voiceMuted: false, panning: false)
    XCTAssertEqual(none.leading, [.destinations, .search])
    XCTAssertEqual(none.trailing, [.voice(muted: false)])
    for followed in [route(), route(alternatives: alternatives), route("failed")] {
      let bar = CarPlayLogic.barButtons(route: followed, notice: nil, voiceMuted: true, panning: false)
      XCTAssertEqual(bar.leading, [])
      XCTAssertEqual(bar.trailing, [])
    }
    for followed in [nil, route()] {
      let panning = CarPlayLogic.barButtons(route: followed, notice: nil, voiceMuted: false, panning: true)
      XCTAssertEqual(panning.leading, [])
      XCTAssertEqual(panning.trailing, [.endPanning])
    }
  }

  func testNoVoiceButtonAtVolumeZeroOrUnderANoticeNorSearchWithoutAKeyboard() {
    XCTAssertEqual(CarPlayLogic.barButtons(route: nil, notice: nil, voiceMuted: nil, panning: false).trailing, [])
    XCTAssertEqual(CarPlayLogic.barButtons(route: nil, notice: notice, voiceMuted: false, panning: false).trailing, [])
    XCTAssertEqual(CarPlayLogic.barButtons(route: nil, notice: nil, voiceMuted: nil, panning: false, keyboard: false).leading, [.destinations])
    XCTAssertEqual(mapButtons(route(), notice: notice), [.endRoute, .pan])
    XCTAssertEqual(mapButtons(route(), voiceMuted: nil), [.endRoute, .pan])
  }

  func testWithoutARoutePanOrRecentreInItsPlaceWhileTheMapIsMovedAndZoom() {
    XCTAssertEqual(mapButtons(nil), [.pan, .zoomIn, .zoomOut])
    XCTAssertEqual(mapButtons(nil, recentre: true), [.recentre, .zoomIn, .zoomOut])
  }

  func testOnARouteTheXTheVoiceTheRoutesWhileThereAreOthersThenPan() {
    XCTAssertEqual(mapButtons(route(), voiceMuted: true), [.endRoute, .voice(muted: true), .pan])
    XCTAssertEqual(mapButtons(route(alternatives: alternatives)), [.endRoute, .voice(muted: false), .routes])
    XCTAssertEqual(mapButtons(route(replanning: true, alternatives: alternatives)), [.endRoute, .voice(muted: false), .pan])
    XCTAssertEqual(mapButtons(route("failed")), [.endRoute, .voice(muted: false), .pan])
    // Without the voice there is room for the routes and pan.
    XCTAssertEqual(mapButtons(route(alternatives: alternatives), voiceMuted: nil), [.endRoute, .routes, .pan])
  }

  // CarPlay documents three map buttons; a fourth was drawn, and a knob focused none of them (a car, 2026-10-31).
  func testNeverMoreThanThreeMapButtonsAndRecentreComesRightAfterTheX() {
    XCTAssertEqual(mapButtons(route(alternatives: alternatives), recentre: true), [.endRoute, .recentre, .voice(muted: false)])
    XCTAssertEqual(mapButtons(route(), recentre: true), [.endRoute, .recentre, .voice(muted: false)])
    XCTAssertEqual(mapButtons(route(alternatives: alternatives), voiceMuted: nil, recentre: true), [.endRoute, .recentre, .routes])
    for recentre in [false, true] {
      for alternatives in [[], alternatives] {
        for voiceMuted in [nil, false] as [Bool?] {
          XCTAssertLessThanOrEqual(mapButtons(route(alternatives: alternatives), voiceMuted: voiceMuted, recentre: recentre).count, CarPlayLogic.maxMapButtons)
        }
      }
      XCTAssertLessThanOrEqual(mapButtons(nil, recentre: recentre).count, CarPlayLogic.maxMapButtons)
    }
  }

  func testWhilePanningTheMapsButtonsZoom() {
    XCTAssertEqual(mapButtons(route(alternatives: alternatives), panning: true), [.zoomIn, .zoomOut])
    XCTAssertEqual(mapButtons(nil, panning: true, recentre: true), [.zoomIn, .zoomOut])
  }

  func testTheButtonsStayWhileTheBarHidesOnlyOnARoute() {
    XCTAssertTrue(CarPlayLogic.buttonsStay(route: route()))
    XCTAssertFalse(CarPlayLogic.buttonsStay(route: nil))
  }

  func testTheFollowZoomShowsAsMuchRoadPerPixelAsAndroidAuto() {
    XCTAssertEqual(CarPlayLogic.followZoomShift(screenScale: 1), 0)
    XCTAssertEqual(CarPlayLogic.followZoomShift(screenScale: 2), -1)
    XCTAssertEqual(CarPlayLogic.followZoomShift(screenScale: 3), -log2(3))
    XCTAssertEqual(CarPlayLogic.followZoomShift(screenScale: 0), 0)
  }

  func testTheSpeedSitsInTheCornerAboveTheButtons() {
    XCTAssertEqual(CarPlayLogic.speedRight(right: 40), 0)
    // A right-hand drive car's dock beside the buttons: the pill beside the dock.
    XCTAssertEqual(CarPlayLogic.speedRight(right: 90), 50)
    XCTAssertEqual(CarPlayLogic.speedRight(right: 0), 0)
  }
}

final class NoticeTests: XCTestCase {
  private func notice(_ kind: String) -> CarNotice { CarNotice(kind: kind, title: "t", text: "x", action: "a") }

  func testLocationAsksWhileIOSCanThenOnlyClosesAsNoMapDoesAHeldRouteTakesTheDriversWord() {
    XCTAssertEqual(CarPlayLogic.noticeButtons(notice(CarNotice.location), canAsk: true), .allow)
    XCTAssertEqual(CarPlayLogic.noticeButtons(notice(CarNotice.location), canAsk: false), .close)
    XCTAssertEqual(CarPlayLogic.noticeButtons(notice(CarNotice.noMap), canAsk: true), .close)
    XCTAssertEqual(CarPlayLogic.noticeButtons(notice(CarNotice.heldRoute), canAsk: true), .confirmOrCancel)
  }

  func testCarPlaysXClosesForGoodOnlyANoticeThatAsksNothing() {
    XCTAssertTrue(CarPlayLogic.closedByCarPlaysX(notice(CarNotice.noMap), canAsk: true))
    XCTAssertTrue(CarPlayLogic.closedByCarPlaysX(notice(CarNotice.location), canAsk: false))
    XCTAssertFalse(CarPlayLogic.closedByCarPlaysX(notice(CarNotice.location), canAsk: true))
    XCTAssertFalse(CarPlayLogic.closedByCarPlaysX(notice(CarNotice.heldRoute), canAsk: true))
  }
}

final class CameraAlertTests: XCTestCase {
  private func camera(_ id: Int, limit: Int? = 50, title: String = "Speed camera in 600 m", line: String? = nil) -> CarCamera {
    CarCamera(id: id, title: title, line: line, limitKph: limit, slowDown: line != nil)
  }

  func testTheSameCameraSignAndRedIsTheSameAlertAsTheDistanceCountsDown() {
    let far = CarPlayLogic.cameraAlert(camera(7), closed: [])
    XCTAssertEqual(far, CarCameraAlert(id: 7, limitKph: 50, slowDown: false))
    XCTAssertEqual(CarPlayLogic.cameraAlert(camera(7, title: "Speed camera in 450 m"), closed: []), far)
    XCTAssertNotEqual(CarPlayLogic.cameraAlert(camera(8), closed: []), far)
    XCTAssertNotEqual(CarPlayLogic.cameraAlert(camera(7, limit: nil), closed: []), far)
    // "Slow down" slides in as an alert of its own, then counts down in place.
    let red = CarPlayLogic.cameraAlert(camera(7, title: "Slow down", line: "Speed camera in 300 m"), closed: [])
    XCTAssertNotEqual(red, far)
    XCTAssertEqual(CarPlayLogic.cameraAlert(camera(7, title: "Slow down", line: "Speed camera in 150 m"), closed: []), red)
  }

  func testAClosedAlertStaysClosedButSlowDownStillComesAndNoneWithoutACamera() {
    let far = CarCameraAlert(id: 7, limitKph: 50, slowDown: false)
    XCTAssertNil(CarPlayLogic.cameraAlert(camera(7, title: "Speed camera in 450 m"), closed: [far]))
    XCTAssertEqual(CarPlayLogic.cameraAlert(camera(8), closed: [far]), CarCameraAlert(id: 8, limitKph: 50, slowDown: false))
    let red = camera(7, title: "Slow down", line: "Speed camera in 300 m")
    XCTAssertEqual(CarPlayLogic.cameraAlert(red, closed: [far]), CarCameraAlert(id: 7, limitKph: 50, slowDown: true))
    XCTAssertNil(CarPlayLogic.cameraAlert(red, closed: [far, CarCameraAlert(id: 7, limitKph: 50, slowDown: true)]))
    XCTAssertNil(CarPlayLogic.cameraAlert(nil, closed: []))
  }

  func testTheWordsTheDistanceUnderSlowDown() {
    XCTAssertEqual(CarPlayLogic.cameraWords(camera(7)).titles, ["Speed camera in 600 m"])
    XCTAssertEqual(CarPlayLogic.cameraWords(camera(7)).subtitles, [])
    let red = CarPlayLogic.cameraWords(camera(7, title: "Slow down", line: "Speed camera in 150 m"))
    XCTAssertEqual(red.titles, ["Slow down"])
    XCTAssertEqual(red.subtitles, ["Speed camera in 150 m"])
  }
}

final class SearchAndDistanceTests: XCTestCase {
  func testTheResultsShownAnswerTheTextTyped() {
    let found = CarSearch(query: "khre", results: [CarPlace(id: "search:a1", title: "Khreshchatyk, 22", detail: nil, kind: "result")])
    XCTAssertEqual(CarPlayLogic.searchList(found, typed: " "), .empty)
    XCTAssertEqual(CarPlayLogic.searchList(nil, typed: "khre"), .loading)
    XCTAssertEqual(CarPlayLogic.searchList(found, typed: "khres"), .loading)
    XCTAssertEqual(CarPlayLogic.searchList(found, typed: "khre "), .results(found.results))
  }

  func testEstimatesChangeOnlyWithWhatCarPlayShows() {
    XCTAssertEqual(CarPlayLogic.estimatesKey(800, "m", 60), CarPlayLogic.estimatesKey(800, "m", 80))
    XCTAssertNotEqual(CarPlayLogic.estimatesKey(800, "m", 60), CarPlayLogic.estimatesKey(750, "m", 60))
    XCTAssertNotEqual(CarPlayLogic.estimatesKey(12, "km1", 900), CarPlayLogic.estimatesKey(12, "km1", 960))
  }

  func testDistancesRoundedAsThePhonesBanner() {
    XCTAssertEqual(CarPlayLogic.shownDistance(144).value, 140)
    XCTAssertFalse(CarPlayLogic.shownDistance(144).kilometers)
    XCTAssertEqual(CarPlayLogic.shownDistance(730).value, 750)
    XCTAssertEqual(CarPlayLogic.shownDistance(1_260).value, 1.3, accuracy: 1e-9)
    XCTAssertTrue(CarPlayLogic.shownDistance(1_260).kilometers)
    XCTAssertEqual(CarPlayLogic.shownDistance(123_400).value, 123)
    XCTAssertEqual(CarPlayLogic.distance(1.2, unit: "km1").kilometers, true)
    XCTAssertEqual(CarPlayLogic.distance(-5, unit: "m").value, 0)
  }

  func testManeuverKindsAndTheirIcons() {
    XCTAssertEqual(CarPlayLogic.maneuverKind("keep-left"), .keepLeft)
    XCTAssertEqual(CarPlayLogic.maneuverKind("roundabout").icon, "car_roundabout_left")
    XCTAssertEqual(CarPlayLogic.maneuverKind("arrive").icon, "car_flag")
    XCTAssertEqual(CarPlayLogic.maneuverKind("something new"), .straight)
  }
}

final class GestureTests: XCTestCase {
  func testAPanAsTheDistanceTheFingerWentBack() {
    let scroll = CarPlayLogic.scroll(from: (10, 5), to: (25, -5))
    XCTAssertEqual(scroll.dx, -15)
    XCTAssertEqual(scroll.dy, 10)
  }

  func testThePanningArrowsShowMoreOfTheirSide() {
    XCTAssertEqual(CarPlayLogic.panScroll(direction: 1).dx, -CarPlayLogic.panStep)
    XCTAssertEqual(CarPlayLogic.panScroll(direction: 2).dx, CarPlayLogic.panStep)
    let upRight = CarPlayLogic.panScroll(direction: 4 | 2)
    XCTAssertEqual(upRight.dx, CarPlayLogic.panStep)
    XCTAssertEqual(upRight.dy, -CarPlayLogic.panStep)
  }

  func testAPinchAsTheChangeSinceTheLast() {
    XCTAssertEqual(CarPlayLogic.zoomFactor(from: 1, to: 1.5), 1.5)
    XCTAssertEqual(CarPlayLogic.zoomFactor(from: 1.5, to: 3), 2)
    XCTAssertEqual(CarPlayLogic.zoomFactor(from: 0, to: 2), 1)
  }
}
