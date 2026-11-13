import XCTest

@testable import Maple

final class EditorCropGeometryTests: XCTestCase {
  func testRegularCropClearsRailPaddingAndCollapseTab() {
    let size = CGSize(width: 1100, height: 800)
    let inspector = CGRect(x: 692, y: 76, width: 396, height: 712)
    let insets = EditorCropGeometry.insets(
      size: size, controlsFrame: inspector, isRegular: true, hasFilmstrip: true)
    let tabEnd =
      EditorCropGeometry.filmstripLeadingPadding
      + EditorCropGeometry.filmstripWidth + EditorCropGeometry.filmstripTabGap
      + EditorCropGeometry.filmstripTabWidth
    // Even an image fitted exactly to the viewport leaves the crop handle's
    // 14-point grab tolerance outside both floating control surfaces.
    XCTAssertGreaterThanOrEqual(insets.leading - 14, tabEnd)
    XCTAssertLessThanOrEqual(size.width - insets.trailing + 14, inspector.minX)
    XCTAssertGreaterThan(size.width - insets.leading - insets.trailing, 90)
  }

  func testCompactCropReservesBottomControlsWithoutHiddenFilmstripSpace() {
    let size = CGSize(width: 700, height: 450)
    let inspector = CGRect(x: 12, y: 262, width: 676, height: 176)
    let insets = EditorCropGeometry.insets(
      size: size, controlsFrame: inspector, isRegular: false, hasFilmstrip: true)
    XCTAssertEqual(insets.leading, EditorCropGeometry.handleMargin)
    XCTAssertLessThanOrEqual(size.height - insets.bottom + 14, inspector.minY)
    XCTAssertGreaterThan(size.height - insets.top - insets.bottom, 90)
  }

  func testRegularCropWithoutFilmstripKeepsNormalHandleMargin() {
    let insets = EditorCropGeometry.insets(
      size: CGSize(width: 1100, height: 800), controlsFrame: nil,
      isRegular: true, hasFilmstrip: false)
    XCTAssertEqual(insets.leading, EditorCropGeometry.handleMargin)
    XCTAssertEqual(insets.trailing, EditorCropGeometry.handleMargin)
  }

  func testTabletCropStacksControlsWhenSideLayoutWouldCrushCanvas() {
    XCTAssertTrue(
      EditorCropGeometry.stacksControlsAtBottom(
        size: CGSize(width: 600, height: 1000), isTablet: true, hasFilmstrip: true))
    XCTAssertFalse(
      EditorCropGeometry.stacksControlsAtBottom(
        size: CGSize(width: 900, height: 700), isTablet: true, hasFilmstrip: true))
    XCTAssertFalse(
      EditorCropGeometry.stacksControlsAtBottom(
        size: CGSize(width: 600, height: 1000), isTablet: false, hasFilmstrip: true))

    let size = CGSize(width: 600, height: 1000)
    let bottomPanel = CGRect(x: 12, y: 560, width: 576, height: 428)
    let insets = EditorCropGeometry.insets(
      size: size, controlsFrame: bottomPanel, isRegular: true,
      hasFilmstrip: true, controlsAtBottom: true)
    XCTAssertEqual(insets.trailing, EditorCropGeometry.handleMargin)
    XCTAssertLessThanOrEqual(size.height - insets.bottom + 14, bottomPanel.minY)
    XCTAssertGreaterThan(size.width - insets.leading - insets.trailing, 300)
    XCTAssertGreaterThan(size.height - insets.top - insets.bottom, 300)
  }
}
