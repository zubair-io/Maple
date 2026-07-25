// ColorWheelGeometryTests.swift — pure geometry for the Color Grading
// hue/saturation wheels (#275). Mirrors CropGeometryTests's shape: no
// SwiftUI, just numeric assertions on `ColorWheelGeometry`.

import XCTest
@testable import MapleCore

final class ColorWheelGeometryTests: XCTestCase {

    // MARK: - Centre / rim

    func testCentrePositionMapsToSaturationZero() {
        let (_, saturation) = ColorWheelGeometry.hueSaturation(
            at: .init(x: 0.5, y: 0.5)
        )
        XCTAssertEqual(saturation, 0, accuracy: 1e-9)
    }

    func testRimPositionMapsToSaturationHundred() {
        // Directly right of centre, at the wheel's rim radius (0.5).
        let (hue, saturation) = ColorWheelGeometry.hueSaturation(
            at: .init(x: 1.0, y: 0.5)
        )
        XCTAssertEqual(saturation, 100, accuracy: 1e-9)
        XCTAssertEqual(hue, 0, accuracy: 1e-6)
    }

    func testCardinalDirectionsMapToExpectedHues() {
        // Up (screen-space -y) reads as 90°; left as 180°; down as 270°.
        XCTAssertEqual(
            ColorWheelGeometry.hueSaturation(at: .init(x: 0.5, y: 0.0)).hue, 90, accuracy: 1e-6
        )
        XCTAssertEqual(
            ColorWheelGeometry.hueSaturation(at: .init(x: 0.0, y: 0.5)).hue, 180, accuracy: 1e-6
        )
        XCTAssertEqual(
            ColorWheelGeometry.hueSaturation(at: .init(x: 0.5, y: 1.0)).hue, 270, accuracy: 1e-6
        )
    }

    // MARK: - Clamping outside the unit disc

    func testPositionBeyondRimClampsToSaturationHundred() {
        // Well outside the unit square — the ray still resolves to a
        // valid hue, saturation pinned at the rim.
        let (_, saturation) = ColorWheelGeometry.hueSaturation(
            at: .init(x: 2.0, y: 2.0)
        )
        XCTAssertEqual(saturation, 100, accuracy: 1e-9)
    }

    func testPositionInverseClampsSaturationAboveHundred() {
        // `position(hue:saturation:)` defensively clamps an out-of-range
        // saturation (shouldn't occur — the model range enforces it) to
        // the rim rather than escaping the unit square.
        let atRim = ColorWheelGeometry.position(hue: 0, saturation: 100)
        let beyondRim = ColorWheelGeometry.position(hue: 0, saturation: 250)
        XCTAssertEqual(beyondRim, atRim)
    }

    func testPositionInverseClampsNegativeSaturation() {
        let atCentre = ColorWheelGeometry.position(hue: 45, saturation: 0)
        let negative = ColorWheelGeometry.position(hue: 45, saturation: -30)
        XCTAssertEqual(negative, atCentre)
    }

    // MARK: - Round trip

    func testRoundTripsThroughEveryQuadrant() {
        let cases: [(hue: Double, saturation: Double)] = [
            (0, 0), (0, 50), (0, 100),
            (45, 30), (90, 100), (135, 60),
            (180, 20), (225, 80), (270, 40),
            (315, 100), (359, 10),
        ]
        for c in cases {
            let position = ColorWheelGeometry.position(hue: c.hue, saturation: c.saturation)
            let (hue, saturation) = ColorWheelGeometry.hueSaturation(at: position)
            XCTAssertEqual(saturation, c.saturation, accuracy: 1e-6,
                "saturation round-trip failed for \(c)")
            // Hue is undefined at saturation 0 (any angle maps to the
            // centre) — skip the hue check there.
            if c.saturation > 0 {
                XCTAssertEqual(hue, c.hue, accuracy: 1e-6,
                    "hue round-trip failed for \(c)")
            }
        }
    }

    // MARK: - Nudge

    func testNudgeStepsHueAndSaturationIndependently() {
        let result = ColorWheelGeometry.nudge(hue: 10, saturation: 20, dx: 1, dy: 0, step: 2)
        XCTAssertEqual(result.hue, 12, accuracy: 1e-9)
        XCTAssertEqual(result.saturation, 20, accuracy: 1e-9)

        let result2 = ColorWheelGeometry.nudge(hue: 10, saturation: 20, dx: 0, dy: 1, step: 5)
        XCTAssertEqual(result2.hue, 10, accuracy: 1e-9)
        XCTAssertEqual(result2.saturation, 25, accuracy: 1e-9)
    }

    func testNudgeWrapsHueAtTheThreeSixtySeam() {
        let forward = ColorWheelGeometry.nudge(hue: 359, saturation: 0, dx: 1, dy: 0, step: 2)
        XCTAssertEqual(forward.hue, 1, accuracy: 1e-9)

        let backward = ColorWheelGeometry.nudge(hue: 1, saturation: 0, dx: -1, dy: 0, step: 2)
        XCTAssertEqual(backward.hue, 359, accuracy: 1e-9)
    }

    func testNudgeClampsSaturationToRange() {
        let atTop = ColorWheelGeometry.nudge(hue: 0, saturation: 99, dx: 0, dy: 1, step: 5)
        XCTAssertEqual(atTop.saturation, 100, accuracy: 1e-9)

        let atBottom = ColorWheelGeometry.nudge(hue: 0, saturation: 1, dx: 0, dy: -1, step: 5)
        XCTAssertEqual(atBottom.saturation, 0, accuracy: 1e-9)
    }
}
