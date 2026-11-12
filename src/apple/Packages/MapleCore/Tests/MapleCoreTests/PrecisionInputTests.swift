import XCTest

@testable import MapleCore

/// What a press on the tone-curve plot does for each kind of input (#5121).
final class PrecisionInputTests: XCTestCase {
  /// The compact iPhone plot: 176 pt less its two 6 pt ring margins.
  private let phonePlot = 164.0

  func testAPencilAndAPointerKeepThePreciseRadiusAtEverySize() {
    for side in [0.0, phonePlot, 300, 1000] {
      XCTAssertEqual(PrecisionInputKind.pencil.curveHitRadius(plotSide: side), 0.05)
      XCTAssertEqual(PrecisionInputKind.pointer.curveHitRadius(plotSide: side), 0.05)
    }
  }

  func testAFingertipGrabsWithinHalfATouchTarget() {
    let radius = PrecisionInputKind.finger.curveHitRadius(plotSide: phonePlot)
    XCTAssertEqual(radius * phonePlot, 22, accuracy: 1e-9)
    XCTAssertEqual(
      PrecisionInputKind.finger.curveHitRadius(plotSide: 300) * 300, 22, accuracy: 1e-9)
  }

  func testAFingertipIsNeverMorePreciseThanAPencil() {
    XCTAssertEqual(PrecisionInputKind.finger.curveHitRadius(plotSide: 1000), 0.05)
    XCTAssertEqual(PrecisionInputKind.finger.curveHitRadius(plotSide: 0), 0.05)
  }

  func testAPressOnEmptyPlotAddsAPointThere() {
    XCTAssertEqual(
      ToneCurveEditing.press([], x: 0.5, y: 0.7, radius: 0.05), .insert(x: 0.5, y: 0.7))
  }

  func testAPressOnAPointGrabsIt() {
    let points: [ToneCurvePoint] = [(x: 0, y: 0), (x: 0.5, y: 0.6), (x: 1, y: 1)]
    XCTAssertEqual(
      ToneCurveEditing.press(points, x: 0.52, y: 0.58, radius: 0.05), .grab(index: 1))
  }

  func testAPencilAddsAPointWhereAFingertipGrabsItsNeighbour() {
    // 14.8 pt from the corner anchor on the phone plot: inside a
    // fingertip's 22 pt, outside the Pencil's 8.2 pt.
    let x = 0.09
    let y = 0.0
    XCTAssertEqual(
      ToneCurveEditing.press(
        [], x: x, y: y, radius: PrecisionInputKind.finger.curveHitRadius(plotSide: phonePlot)),
      .grab(index: 0))
    XCTAssertEqual(
      ToneCurveEditing.press(
        [], x: x, y: y, radius: PrecisionInputKind.pencil.curveHitRadius(plotSide: phonePlot)),
      .insert(x: x, y: y))
  }

  func testAPressGrabsTheNearestOfTwoPointsInReach() {
    let points: [ToneCurvePoint] = [(x: 0, y: 0), (x: 0.4, y: 0.4), (x: 0.5, y: 0.5), (x: 1, y: 1)]
    XCTAssertEqual(
      ToneCurveEditing.press(points, x: 0.47, y: 0.47, radius: 0.134), .grab(index: 2))
  }

  func testAPressAboveOrBelowAPointOutOfReachDoesNothing() {
    // A new point may not share its x with an existing one.
    let points: [ToneCurvePoint] = [(x: 0, y: 0), (x: 0.5, y: 0.9), (x: 1, y: 1)]
    XCTAssertNil(ToneCurveEditing.press(points, x: 0.5, y: 0.1, radius: 0.05))
  }

  func testAPressIsClampedToThePlot() {
    XCTAssertEqual(
      ToneCurveEditing.press([], x: 0.3, y: 1.4, radius: 0.05), .insert(x: 0.3, y: 1))
    XCTAssertNil(ToneCurveEditing.press([], x: -0.2, y: 0.5, radius: 0.05))
  }

  func testAnInsertedPressLandsWhereThePlotInsertsIt() {
    let points: [ToneCurvePoint] = [(x: 0, y: 0), (x: 0.5, y: 0.6), (x: 1, y: 1)]
    guard case .insert(let x, let y) = ToneCurveEditing.press(points, x: 0.25, y: 0.3, radius: 0.05)
    else { return XCTFail("expected an insert") }
    let inserted = ToneCurveEditing.insert(points, x: x, y: y)
    XCTAssertEqual(inserted.count, 4)
    XCTAssertEqual(inserted[1].x, 0.25)
    XCTAssertEqual(inserted[1].y, 0.3)
  }
}
