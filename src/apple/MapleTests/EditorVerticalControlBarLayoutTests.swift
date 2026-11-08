import MapleCore
import XCTest

@testable import Maple

/// #5710: which editors use the vertical bar or the bottom ruler, and where
/// the vertical bar's top sits.
final class EditorVerticalControlBarLayoutTests: XCTestCase {
  func testOpenDuoUsesTheVerticalBarInLandscapeAndTheBottomRulerInPortrait() {
    let landscape = CGSize(width: 951, height: 669)
    let portrait = CGSize(width: 669, height: 835)
    XCTAssertTrue(
      EditorVerticalControlBar.fits(in: landscape, idiom: .phone, isiOSAppOnMac: false))
    XCTAssertFalse(EditorControls.docksCompactBar(size: landscape, idiom: .phone))
    XCTAssertFalse(
      EditorVerticalControlBar.fits(in: portrait, idiom: .phone, isiOSAppOnMac: false))
    XCTAssertTrue(EditorControls.docksCompactBar(size: portrait, idiom: .phone))
  }

  func testIPadNeverDocksTheCompactBar() {
    for size in [CGSize(width: 1024, height: 1300), CGSize(width: 1366, height: 1000)] {
      XCTAssertFalse(EditorControls.docksCompactBar(size: size, idiom: .pad), "\(size)")
    }
  }

  func testIPadUsesTheRulerControlsOnlyInLandscape() {
    XCTAssertTrue(
      EditorVerticalControlBar.fits(
        in: CGSize(width: 1366, height: 1000), idiom: .pad, isiOSAppOnMac: false))
    XCTAssertFalse(
      EditorVerticalControlBar.fits(
        in: CGSize(width: 1024, height: 1300), idiom: .pad, isiOSAppOnMac: false))
  }

  func testShortWindowsAndTheMacKeepTheStackedInspector() {
    XCTAssertFalse(
      EditorVerticalControlBar.fits(
        in: CGSize(width: 932, height: 430), idiom: .phone, isiOSAppOnMac: false))
    XCTAssertFalse(
      EditorVerticalControlBar.fits(
        in: CGSize(width: 1366, height: 1000), idiom: .pad, isiOSAppOnMac: true))
    XCTAssertFalse(
      EditorVerticalControlBar.fits(
        in: CGSize(width: 1366, height: 1000), idiom: .mac, isiOSAppOnMac: false))
  }

  func testWithNothingOccludedTheBarStartsBelowTheHeader() {
    let top = EditorVerticalControlBar.topClearance(
      occlusions: [], topTrailingCorner: 0, trailingEdge: 1366)
    XCTAssertEqual(top, EditorVerticalControlBar.headerClearance)
  }

  func testTheBarClearsAStatusClusterAtTheTrailingEdge() {
    let cluster = CGRect(x: 880, y: 28, width: 50, height: 76)
    let top = EditorVerticalControlBar.topClearance(
      occlusions: [cluster], topTrailingCorner: 0, trailingEdge: 951)
    XCTAssertEqual(top, cluster.maxY + 12)
  }

  func testOcclusionsOutsideTheBarsBandOrAboveTheSafeAreaAreIgnored() {
    let leadingCamera = CGRect(x: 0, y: 0, width: 60, height: 200)
    let statusAboveSafeArea = CGRect(x: 500, y: -82, width: 169, height: 82)
    let top = EditorVerticalControlBar.topClearance(
      occlusions: [leadingCamera, statusAboveSafeArea], topTrailingCorner: 0, trailingEdge: 951)
    XCTAssertEqual(top, EditorVerticalControlBar.headerClearance)
  }

  func testATallRoundedCornerPushesTheBarDown() {
    let top = EditorVerticalControlBar.topClearance(
      occlusions: [], topTrailingCorner: 90, trailingEdge: 1366)
    XCTAssertEqual(top, 102)
  }
}
