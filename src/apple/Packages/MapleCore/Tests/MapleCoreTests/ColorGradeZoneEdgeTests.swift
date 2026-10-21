// ColorGradeZoneEdgeTests.swift — pointer position to zone edge pivot (#5040).

import XCTest

@testable import MapleCore

final class ColorGradeZoneEdgeTests: XCTestCase {
  func testPositionIsNormalisedOverTheStripWidth() {
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 100, width: 400, range: ColorGradeZoneEdge.shadowRange),
      0.25, accuracy: 1e-12)
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 320, width: 400, range: ColorGradeZoneEdge.highlightRange),
      0.8, accuracy: 1e-12)
  }

  func testPositionClampsToEachEdgesAuthoringRange() {
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 4, width: 400, range: ColorGradeZoneEdge.shadowRange), 0.10)
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 390, width: 400, range: ColorGradeZoneEdge.shadowRange),
      0.564622)
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 100, width: 400, range: ColorGradeZoneEdge.highlightRange),
      0.564622)
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 399, width: 400, range: ColorGradeZoneEdge.highlightRange),
      0.90)
  }

  func testAHandleLocalPositionWouldBeWrongForTheSameDrag() {
    let handleLocal = ColorGradeZoneEdge.normalized(
      x: 11, width: 400, range: ColorGradeZoneEdge.shadowRange)
    let stripSpace = ColorGradeZoneEdge.normalized(
      x: 226, width: 400, range: ColorGradeZoneEdge.shadowRange)
    XCTAssertNotEqual(handleLocal, stripSpace)
  }
}
