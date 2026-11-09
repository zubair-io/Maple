import SwiftUI
import XCTest

@testable import Maple

/// #5774: the header shares the status row only where the status items sit
/// alone at the trailing end of the top inset.
final class StatusRowHeaderPlacementTests: XCTestCase {
  private let openDuoPortrait = CGSize(width: 669, height: 835)
  private let openDuoSafeArea = EdgeInsets(top: 82, leading: 0, bottom: 20, trailing: 0)
  private let phone = CGSize(width: 402, height: 812)
  private let phoneSafeArea = EdgeInsets(top: 62, leading: 0, bottom: 34, trailing: 0)

  private func insets(_ occlusions: [CGRect], size: CGSize, safeArea: EdgeInsets) -> EdgeInsets? {
    StatusRowHeaderPlacement.statusRowInsets(occlusions: occlusions, size: size, safeArea: safeArea)
  }

  func testOpenDuoHeaderCentresOnTheStatusItemsAndClearsThem() {
    let status = CGRect(x: 500, y: -82, width: 169, height: 82)
    let row = insets([status], size: openDuoPortrait, safeArea: openDuoSafeArea)
    XCTAssertEqual(row?.top, 19)
    XCTAssertEqual(row?.trailing, 169)
  }

  func testSeparateStatusItemsAreClearedTogether() {
    let clock = CGRect(x: 520, y: -70, width: 60, height: 30)
    let wifi = CGRect(x: 590, y: -76, width: 50, height: 40)
    let row = insets([clock, wifi], size: openDuoPortrait, safeArea: openDuoSafeArea)
    XCTAssertEqual(row?.top, 82 - 56 - 22)
    XCTAssertEqual(row?.trailing, 149)
  }

  func testStatusItemsOverhangingTheInsetEdgesStillCount() {
    let pastTheEdge = CGRect(x: 500, y: -82.4, width: 169.4, height: 82.3)
    let pastTheSafeAreaTop = CGRect(x: 500, y: -70, width: 169, height: 76)
    for status in [pastTheEdge, pastTheSafeAreaTop] {
      XCTAssertNotNil(
        insets([status], size: openDuoPortrait, safeArea: openDuoSafeArea), "\(status)")
    }
  }

  func testShortStatusItemsNearTheScreenTopNeverPushTheRowOffScreen() {
    let status = CGRect(x: 520, y: -80, width: 120, height: 20)
    XCTAssertEqual(insets([status], size: openDuoPortrait, safeArea: openDuoSafeArea)?.top, 0)
  }

  func testALeadingRegionReportedAboveTheScreenStillKeepsTheRestingRow() {
    let clock = CGRect(x: 30, y: -75, width: 80, height: 30)
    let battery = CGRect(x: 300, y: -50, width: 80, height: 30)
    XCTAssertNil(insets([clock, battery], size: phone, safeArea: phoneSafeArea))
  }

  func testALeadingClockKeepsTheRestingRow() {
    let clock = CGRect(x: 30, y: -50, width: 80, height: 30)
    let battery = CGRect(x: 300, y: -50, width: 80, height: 30)
    XCTAssertNil(insets([clock, battery], size: phone, safeArea: phoneSafeArea))
  }

  func testACentredSensorHousingKeepsTheRestingRow() {
    let island = CGRect(x: 140, y: -51, width: 122, height: 37)
    XCTAssertNil(insets([island], size: phone, safeArea: phoneSafeArea))
  }

  func testOcclusionsBelowTheSafeAreaTopAreIgnored() {
    let closedDuoRailClock = CGRect(x: 380, y: 30, width: 70, height: 120)
    XCTAssertNil(
      insets(
        [closedDuoRailClock], size: CGSize(width: 375, height: 660),
        safeArea: EdgeInsets(top: 20, leading: 0, bottom: 20, trailing: 83)))
  }

  func testNoRoomBesideTheStatusItemsKeepsTheRestingRow() {
    let status = CGRect(x: 250, y: -60, width: 140, height: 60)
    XCTAssertNil(
      insets(
        [status], size: CGSize(width: 390, height: 800),
        safeArea: EdgeInsets(top: 60, leading: 0, bottom: 34, trailing: 0)))
  }

  func testATopInsetShorterThanTheRowKeepsTheRestingRow() {
    let status = CGRect(x: 500, y: -30, width: 169, height: 30)
    XCTAssertNil(
      insets(
        [status], size: openDuoPortrait,
        safeArea: EdgeInsets(top: 30, leading: 0, bottom: 20, trailing: 0)))
  }

  func testNoStatusItemsKeepsTheRestingRow() {
    XCTAssertNil(insets([], size: openDuoPortrait, safeArea: openDuoSafeArea))
  }
}
