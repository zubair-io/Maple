// ColorCurvePickerTests.swift — tests for Oklab secondary color curve math,
// skin-tone guard knots, non-folding Hue vs Hue clamp, and stage-input
// eyedropper (#5077).

import XCTest

@testable import MapleCore

@MainActor
final class ColorCurvePickerTests: XCTestCase {
  func testSkinToneGuardKnotsInsertAt38_55_72Degrees() {
    let locked = ColorCurveKind.hueVsHue.lockingSkinTone(into: .identity)
    XCTAssertEqual(locked.points.count, 3)
    XCTAssertEqual(locked.points[0].x, 38.0 / 360.0, accuracy: 1e-6)
    XCTAssertEqual(locked.points[1].x, 55.0 / 360.0, accuracy: 1e-6)
    XCTAssertEqual(locked.points[2].x, 72.0 / 360.0, accuracy: 1e-6)
    for pt in locked.points {
      XCTAssertEqual(pt.y, 0.5, accuracy: 1e-6)
    }
    // Non-periodic curves ignore Lock Skin Tone.
    XCTAssertEqual(ColorCurveKind.lumaVsSat.lockingSkinTone(into: .identity), .identity)
  }

  func testHueVsHueNonFoldingClampBoundsSlope() {
    let pts: [ToneCurvePoint] = [
      (x: 0.50, y: 0.50),
      (x: 0.54, y: 0.50),
    ]
    // Neighbor distance dx = 0.04 => max |dy| = 2.5 * 0.04 = 0.10 => y in [0.40, 0.60].
    let clampedHigh = ColorCurveKind.hueVsHue.clampY(
      forX: 0.54, proposedY: 0.95, in: pts, excludingIndex: 1)
    let clampedLow = ColorCurveKind.hueVsHue.clampY(
      forX: 0.54, proposedY: 0.05, in: pts, excludingIndex: 1)
    XCTAssertEqual(clampedHigh, 0.60, accuracy: 1e-6)
    XCTAssertEqual(clampedLow, 0.40, accuracy: 1e-6)

    // Hue vs Sat has no slope clamp beyond [0, 1].
    let satHigh = ColorCurveKind.hueVsSat.clampY(
      forX: 0.54, proposedY: 0.95, in: pts, excludingIndex: 1)
    XCTAssertEqual(satHigh, 0.95, accuracy: 1e-6)
  }

  func testColorCurvePickerSeedsActiveCurveFromSample() async {
    let session = EditSession.preview()
    let picker = ColorCurvePicker(session: session)
    picker.activeKind = .hueVsSat
    picker.provider = { _, _, _ in
      ColorCurveSample(uH: 250.0 / 360.0, uC: 0.45, uL: 0.62, l: 0.68, c: 0.144, hueDeg: 250.0)
    }
    picker.arm()
    XCTAssertTrue(picker.isArmed)
    await picker.pick(at: CGPoint(x: 0.5, y: 0.5))
    XCTAssertFalse(picker.isArmed)
    let curve = session.model.colorCurveHueVsSat
    XCTAssertEqual(curve.points.count, 1)
    XCTAssertEqual(curve.points[0].x, 250.0 / 360.0, accuracy: 1e-6)
    XCTAssertEqual(curve.points[0].y, 0.5, accuracy: 1e-6)
  }
}
