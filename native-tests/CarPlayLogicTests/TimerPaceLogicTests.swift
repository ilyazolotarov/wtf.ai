import Foundation
import XCTest

@testable import CarPlayLogic

final class TimerPaceLogicTests: XCTestCase {
  func testPhoneShowingTheAppPacesByItsDisplay() {
    XCTAssertEqual(TimerPaceLogic.pace(phoneScenes: [.foregroundActive]), .phoneDisplay)
    // Control Centre over the app, a call's banner: the phone's screen still shows it.
    XCTAssertEqual(TimerPaceLogic.pace(phoneScenes: [.foregroundInactive]), .phoneDisplay)
    XCTAssertEqual(TimerPaceLogic.pace(phoneScenes: [.background, .foregroundActive]), .phoneDisplay)
  }

  // Only the car's screen shows the app: the phone locked, dark, or in another app.
  func testCarAloneRunsTimersOnTheirOwn() {
    XCTAssertEqual(TimerPaceLogic.pace(phoneScenes: [.background]), .ownTimers)
    XCTAssertEqual(TimerPaceLogic.pace(phoneScenes: []), .ownTimers)
    XCTAssertEqual(TimerPaceLogic.pace(phoneScenes: [.unattached]), .ownTimers)
  }
}
